import { oauthProvider } from '@better-auth/oauth-provider';
import { APPS } from '@epicenter/constants/apps';
import { type BetterAuthOptions, betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { customSession } from 'better-auth/plugins';
import { bearer } from 'better-auth/plugins/bearer';
import { deviceAuthorization } from 'better-auth/plugins/device-authorization';
import { jwt } from 'better-auth/plugins/jwt';
import { eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { createAutumn } from '../autumn';
import { FEATURE_IDS } from '../billing-plans';
import * as schema from '../db/schema';
import { BASE_AUTH_CONFIG } from './base-config';
import type { SessionResponse } from './contracts';
import { deriveUserEncryptionKeys } from './encryption';

type Db = NodePgDatabase<typeof schema>;

/**
 * Assemble and return a configured `betterAuth()` instance from runtime deps.
 *
 * Cloudflare Workers doesn't expose `env` or database connections at module scope,
 * so this defers Better Auth initialization to request time. The returned object is
 * the raw Better Auth instance—no wrapper or additional abstraction.
 *
 * Wires up:
 * - Drizzle adapter (Postgres via Hyperdrive)
 * - Google OAuth + email/password (from {@link BASE_AUTH_CONFIG})
 * - Plugins: bearer tokens, JWT, device authorization, OAuth provider (PKCE)
 * - `customSession()` enrichment that appends the full encryption keyring
 *   to `/auth/get-session` responses (see {@link SessionResponse})
 * - Autumn billing customer creation on user signup
 * - Cloudflare KV secondary storage for session caching
 */
export function createAuth({
	db,
	env,
	baseURL,
}: {
	db: Db;
	env: Cloudflare.Env;
	baseURL: string;
}) {
	const authOptionsBase = {
		...BASE_AUTH_CONFIG,
		database: drizzleAdapter(db, { provider: 'pg' }),
		baseURL,
		secret: env.BETTER_AUTH_SECRET,
		account: {
			...BASE_AUTH_CONFIG.account,
			// Better Auth's database strategy validates OAuth callbacks two ways:
			// 1. A verification record in Postgres (random token, single-use, 10min TTL)
			// 2. A signed state cookie set during the sign-in POST
			//
			// Layer 2 fails in our architecture. The sign-in POST is a cross-origin
			// fetch (opensidian.com → api.epicenter.so), and modern browsers block
			// third-party Set-Cookie from fetch responses—even with SameSite=None.
			// Chrome Privacy Sandbox, Safari ITP, and Firefox ETP all enforce this.
			// The cookie is never stored, so the callback can't read it back.
			//
			// Layer 1 (DB verification) is the primary security mechanism and is
			// unaffected. skipStateCookieCheck disables only layer 2.
			skipStateCookieCheck: true,
		},
		socialProviders: {
			google: {
				clientId: env.GOOGLE_CLIENT_ID,
				clientSecret: env.GOOGLE_CLIENT_SECRET,
			},
		},
		session: {
			expiresIn: 60 * 60 * 24 * 7,
			updateAge: 60 * 60 * 24,
			// Write sessions to Postgres (source of truth), not just KV.
			// Required when secondaryStorage is configured—see comment below.
			storeSessionInDatabase: true,
			cookieCache: {
				enabled: true,
				maxAge: 60 * 5,
				strategy: 'jwe',
			},
		},
		// Cross-origin cookie config for sessions.
		//
		// The auth server (api.epicenter.so) serves multiple client apps:
		//   - Subdomains: fuji.epicenter.so, opensidian.epicenter.so
		//   - External domains: opensidian.com
		//   - Desktop: tauri://localhost
		//   - Dev: localhost:5173, localhost:5174, etc.
		//
		// SameSite=None + Secure lets browsers send session cookies on
		// cross-origin fetches (e.g. opensidian.com → api.epicenter.so).
		// This trades browser-level CSRF for app-level origin checking,
		// which Better Auth enforces via trustedOrigins on every request.
		// Standard practice for auth servers on a separate domain—same
		// model as Auth0, Clerk, and Supabase Auth.
		//
		// crossSubDomainCookies scopes cookies to .epicenter.so so any
		// subdomain shares sessions. Apps on other domains (opensidian.com)
		// still work because their fetches target api.epicenter.so.
		//
		// NOTE: We intentionally omit `partitioned: true` (CHIPS).
		// Partitioned cookies are keyed by the top-level site at creation
		// time. During OAuth the top-level site changes mid-flow (client →
		// Google → API callback), so the cookie becomes invisible at the
		// callback step. Partitioned is for iframes, not redirect OAuth.
		advanced: {
			crossSubDomainCookies: {
				enabled: true,
				domain: '.epicenter.so',
			},
			defaultCookieAttributes: {
				sameSite: 'none',
				secure: true,
			},
		},
		databaseHooks: {
			user: {
				create: {
					after: async (user) => {
						const autumn = createAutumn(env);
						await autumn.customers.getOrCreate({
							customerId: user.id,
							name: user.name,
							email: user.email,
						});
					},
				},
				delete: {
					before: async (user) => {
						// Clean up R2 assets before CASCADE deletes Postgres rows
						const assets = await db
							.select({ id: schema.asset.id })
							.from(schema.asset)
							.where(eq(schema.asset.userId, user.id));

						if (assets.length > 0) {
							const keys = assets.map((a) => `${user.id}/${a.id}`);
							await env.ASSETS_BUCKET.delete(keys);
						}

						// Zero Autumn storage balance
						const autumn = createAutumn(env);
						await autumn.balances
							.update({
								customerId: user.id,
								featureId: FEATURE_IDS.storageBytes,
								usage: 0,
							})
							.catch((e) =>
								console.error('[user-delete] Autumn zero failed:', e),
							);
					},
				},
			},
		},
		trustedOrigins: (request) => {
			const origins = [
				'tauri://localhost',
				...Object.values(APPS).flatMap((app) => [
					...app.urls,
					`http://localhost:${app.port}`,
				]),
				// Wrangler dev serves at the custom domain over plain HTTP (no TLS).
				// The browser sends Origin: http://api.epicenter.so which doesn't
				// match https://api.epicenter.so. Add the HTTP variant.
				`http://${new URL(APPS.API.urls[0]).host}`,
			];
			const origin = request?.headers.get('origin');
			if (origin?.startsWith('chrome-extension://')) {
				origins.push(origin);
			}
			return origins;
		},
		// secondaryStorage = Cloudflare KV as a read-through cache.
		// Postgres (Germany) is always the source of truth. KV avoids the
		// ~150ms round-trip on repeated session reads from distant edges.
		//
		// Staleness: KV is eventually consistent, so cached entries may
		// briefly outlive their Postgres counterparts after deletion.
		//   - Sessions: a revoked session stays valid in KV for up to
		//     cookieCache.maxAge (5 min). Standard Redis/KV cache tradeoff.
		//   - Verification: a consumed OAuth state may linger in KV, but
		//     replaying it requires a valid Google authorization code that
		//     was already consumed—harmless.
		//
		// IMPORTANT: When secondaryStorage is configured, Better Auth
		// defaults to KV-only writes unless you opt back into Postgres
		// with storeSessionInDatabase / storeInDatabase. Missing either
		// flag causes silent data loss. If you remove secondaryStorage,
		// remove both flags too.
		secondaryStorage: {
			get: (key: string) => env.SESSION_KV.get(key),
			set: (key: string, value: string, ttl?: number) =>
				env.SESSION_KV.put(key, value, {
					expirationTtl: ttl ?? 60 * 5,
				}),
			delete: (key: string) => env.SESSION_KV.delete(key),
		},
		// Write verification records to Postgres, not just KV. Required
		// for OAuth state—KV eventual consistency means the callback edge
		// may not see a record written moments earlier at a different edge.
		verification: {
			storeInDatabase: true,
		},
	} satisfies Omit<BetterAuthOptions, 'plugins'>;

	const basePlugins = [
		bearer(),
		jwt(),
		deviceAuthorization({
			verificationUri: '/device',
			expiresIn: '10m',
			interval: '5s',
		}),
		oauthProvider({
			loginPage: '/sign-in',
			consentPage: '/consent',
			requirePKCE: true,
			allowDynamicClientRegistration: false,
			// The plugin warns that /.well-known/oauth-authorization-server/auth must exist
			// because basePath is /auth (not /), so it can't auto-mount at the root.
			// We already mount both discovery endpoints manually in app.ts.
			silenceWarnings: { oauthAuthServerConfig: true, openidConfig: true },
			trustedClients: [
				{
					clientId: 'epicenter-desktop',
					name: 'Epicenter Desktop',
					type: 'native',
					redirectUrls: ['tauri://localhost/auth/callback'],
					skipConsent: true,
					metadata: {},
				},
				{
					clientId: 'epicenter-mobile',
					name: 'Epicenter Mobile',
					type: 'native',
					redirectUrls: ['epicenter://auth/callback'],
					skipConsent: true,
					metadata: {},
				},
				{
					clientId: 'epicenter-cli',
					name: 'Epicenter CLI',
					type: 'native',
					redirectUrls: [],
					skipConsent: true,
					metadata: {},
				},
			],
		}),
	];
	/**
	 * Enrich `/auth/get-session` responses with the full encryption keyring.
	 *
	 * Derives a per-user key for every version in `ENCRYPTION_SECRETS`.
	 * HKDF derivation adds <0.1ms per key—negligible next to the network round-trip.
	 * Embedding all keys here eliminates separate key-fetch endpoints and
	 * enables fresh clients to decrypt blobs from any key version.
	 */
	const customSessionPlugin = customSession(
		async ({ user, session }) => {
			const encryptionKeys = await deriveUserEncryptionKeys(user.id);
			return {
				user,
				session,
				encryptionKeys,
			} satisfies SessionResponse;
		},
		{
			...authOptionsBase,
			plugins: basePlugins,
		},
	);

	return betterAuth({
		...authOptionsBase,
		plugins: [...basePlugins, customSessionPlugin],
	});
}
