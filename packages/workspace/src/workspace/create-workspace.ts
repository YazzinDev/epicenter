/**
 * createWorkspace() — Instantiate a workspace client.
 *
 * Returns a client that IS usable directly AND has `.withExtension()` for chaining.
 *
 * ## Extension chaining vs action maps
 *
 * Extensions use chainable `.withExtension(key, factory)` because they build on each
 * other progressively — each factory receives previously added extensions as typed context.
 * You may be importing extensions you don't control and want to compose on top of them.
 *
 * Actions use a single `.withActions(factory)` because they don't build on each other,
 * are always defined by the app author, and benefit from being declared in one place.
 *
 * ## Encryption
 *
 * All stores are always wrapped with `createEncryptedYkvLww()` (passthrough when no
 * key is set). After the workspace is ready, call `applyEncryptionKeys()` to activate
 * encryption on all stores. This is synchronous — HKDF and XChaCha20 are both sync.
 *
 * ```
 * workspace.applyEncryptionKeys(session.encryptionKeys);
 * workspace.extensions.sync.connect();
 * ```
 *
 * Once encryption has been activated, the stores permanently refuse plaintext writes.
 * The only reset path is `clearLocalData()`.
 *
 * @example
 * ```typescript
 * // Direct use (no extensions)
 * const client = createWorkspace({ id: 'my-app', tables: { posts } });
 * client.tables.posts.set({ id: '1', title: 'Hello' });
 *
 * // With extensions (chained)
 * const client = createWorkspace({ id: 'my-app', tables: { posts } })
 *   .withExtension('persistence', indexeddbPersistence)
 *   .withExtension('sync', ySweetSync({ auth: directAuth('...') }));
 *
 * // With actions (terminal)
 * const client = createWorkspace({ id: 'my-app', tables: { posts } })
 *   .withExtension('persistence', indexeddbPersistence)
 *   .withActions((client) => ({
 *     createPost: defineMutation({ ... }),
 *   }));
 *
 * // From reusable definition
 * const def = defineWorkspace({ id: 'my-app', tables: { posts } });
 * const client = createWorkspace(def);
 * ```
 */

import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import type { Actions } from '../shared/actions.js';
import { base64ToBytes, deriveWorkspaceKey } from '../shared/crypto/index.js';
import type { YKeyValueLwwEntry } from '../shared/y-keyvalue/y-keyvalue-lww.js';
import {
	createEncryptedYkvLww,
	type EncryptedYKeyValueLww,
} from '../shared/y-keyvalue/y-keyvalue-lww-encrypted.js';
import { createAwareness } from './create-awareness.js';
import { createDocuments } from './create-documents.js';
import { createKv } from './create-kv.js';
import { createTable } from './create-table.js';
import {
	type EncryptionKeys,
	encryptionKeysFingerprint,
} from './encryption-key.js';
import {
	defineExtension,
	disposeLifo,
	type MaybePromise,
	startDisposeLifo,
} from './lifecycle.js';
import type {
	AwarenessDefinitions,
	BaseRow,
	DocumentConfig,
	DocumentContext,
	DocumentExtensionRegistration,
	Documents,
	DocumentsHelper,
	ExtensionContext,
	KvDefinitions,
	TableDefinitions,
	TablesHelper,
	WorkspaceClient,
	WorkspaceClientBuilder,
	WorkspaceDefinition,
} from './types.js';
import { KV_KEY, TableKey } from './ydoc-keys.js';

/**
 * Create a workspace client with chainable extension support.
 *
 * The returned client IS directly usable (no extensions required) AND supports
 * chaining `.withExtension()` calls to progressively add extensions, each with
 * typed access to all previously added extensions.
 *
 * Single code path — no overloads, no branches. Awareness is always created
 * (like tables and KV). When no awareness fields are defined, the helper has
 * zero accessible field keys but `raw` is still available for sync providers.
 *
 * @param config - Workspace config (or WorkspaceDefinition from defineWorkspace())
 * @returns WorkspaceClientBuilder - a client that can be used directly or chained with .withExtension()
 */
export function createWorkspace<
	TId extends string,
	TTableDefinitions extends TableDefinitions = Record<string, never>,
	TKvDefinitions extends KvDefinitions = Record<string, never>,
	TAwarenessDefinitions extends AwarenessDefinitions = Record<string, never>,
>({
	id,
	tables: tablesDef,
	kv: kvDef,
	awareness: awarenessDef,
}: WorkspaceDefinition<
	TId,
	TTableDefinitions,
	TKvDefinitions,
	TAwarenessDefinitions
>): WorkspaceClientBuilder<
	TId,
	TTableDefinitions,
	TKvDefinitions,
	TAwarenessDefinitions,
	Record<string, never>
> {
	// ── Data doc ────────────────────────────────────────────────────────
	const ydoc = new Y.Doc({ guid: id });

	const tableDefs = (tablesDef ?? {}) as TTableDefinitions;
	const kvDefs = (kvDef ?? {}) as TKvDefinitions;
	const awarenessDefs = (awarenessDef ?? {}) as TAwarenessDefinitions;

	// ── Tables ───────────────────────────────────────────────────────────────
	const tableEntries = Object.entries(tableDefs).map(([name, definition]) => {
		const yarray = ydoc.getArray<YKeyValueLwwEntry<unknown>>(TableKey(name));
		const store = createEncryptedYkvLww(yarray);
		const helper = createTable(store, definition);
		return { name, store, helper };
	});

	const tables = Object.fromEntries(
		tableEntries.map(({ name, helper }) => [name, helper]),
	) as TablesHelper<TTableDefinitions>;

	// ── KV ──────────────────────────────────────────────────────────────────
	const kvYarray = ydoc.getArray<YKeyValueLwwEntry<unknown>>(KV_KEY);
	const kvStore = createEncryptedYkvLww(kvYarray);
	const kvHelper = createKv(kvStore, kvDefs);

	// ── Encrypted stores (all table stores + KV store) ─────────────────────
	// The workspace owns this list so it can coordinate activateEncryption
	// across all stores simultaneously via applyEncryptionKeys().
	const encryptedStores: readonly EncryptedYKeyValueLww<unknown>[] = [
		...tableEntries.map(({ store }) => store),
		kvStore,
	];

	// Fingerprint of the last-applied encryption keys for same-key dedup.
	// Token refreshes fire onLogin repeatedly with identical keys — this
	// skips the expensive base64 decode → HKDF → per-store scan path.
	let lastKeysFingerprint: string | undefined;

	const rawAwareness = new Awareness(ydoc);
	const awareness = createAwareness(rawAwareness, awarenessDefs);
	const definitions = {
		tables: tableDefs,
		kv: kvDefs,
		awareness: awarenessDefs,
	};

	/**
	 * Immutable builder state passed through the builder chain.
	 *
	 * Each `withExtension` creates new arrays instead of mutating shared state,
	 * which fixes builder branching isolation (two branches from the same base
	 * builder get independent extension sets).
	 *
	 * Three arrays track three distinct lifecycle moments:
	 * - `extensionCleanups` — `dispose()` shutdown: close connections, stop observers (irreversible)
	 * - `clearLocalDataCallbacks` — `workspace.clearLocalData()` data wipe: delete IndexedDB (reversible, repeatable)
	 * - `whenReadyPromises` — construction: composite `whenReady` waits for all extensions to init
	 */
	type BuilderState = {
		extensionCleanups: (() => MaybePromise<void>)[];
		clearLocalDataCallbacks: (() => MaybePromise<void>)[];
		whenReadyPromises: Promise<unknown>[];
	};

	// Accumulated document extension registrations (in chain order).
	// Mutable array — grows as .withDocumentExtension() is called. Document
	// bindings reference this array by closure, so by the time user code
	// calls .open(), all extensions are registered.
	const documentExtensionRegistrations: DocumentExtensionRegistration[] = [];

	// Create documents for tables that have .withDocument() declarations.
	// Documents are created eagerly but reference documentExtensionRegistrations by closure,
	// so they pick up extensions added later via .withDocumentExtension().
	const documentCleanups: (() => Promise<void>)[] = [];
	// Runtime type is Record<string, Record<string, Documents<BaseRow>>> —
	// cast to DocumentsHelper at the end so it satisfies WorkspaceClient/ExtensionContext.
	const documentsNamespace: Record<
		string,
		Record<string, Documents<BaseRow>>
	> = {};

	for (const [tableName, tableDef] of Object.entries(tableDefs)) {
		if (Object.keys(tableDef.documents).length === 0) continue;

		const tableHelper = tables[tableName];
		if (!tableHelper) continue;

		const tableDocumentsNamespace: Record<string, Documents<BaseRow>> = {};

		for (const [docName, rawConfig] of Object.entries(tableDef.documents)) {
			const { content, guid, onUpdate } =
				rawConfig as DocumentConfig;

			const documents = createDocuments({
				id,
				tableName,
				documentName: docName,
				content,
				guidKey: guid as keyof BaseRow & string,
				onUpdate,
				tableHelper,
				ydoc,
				documentExtensions: documentExtensionRegistrations,
			});

			tableDocumentsNamespace[docName] = documents;
			documentCleanups.push(() => documents.closeAll());
		}

		documentsNamespace[tableName] = tableDocumentsNamespace;
	}

	const typedDocuments =
		documentsNamespace as unknown as DocumentsHelper<TTableDefinitions>;

	/**
	 * Build a workspace client with the given extensions and lifecycle state.
	 *
	 * Called once at the bottom of `createWorkspace` (empty state), then once per
	 * `withExtension`/`withWorkspaceExtension` call (accumulated state). Each call
	 * returns a fresh builder object — the client object itself is shared across all
	 * builders (same `ydoc`, `tables`, `kv`), but the builder methods and extensions
	 * map are new.
	 */
	function buildClient<TExtensions extends Record<string, unknown>>({
		extensions,
		state,
		actions,
	}: {
		extensions: TExtensions;
		state: BuilderState;
		actions: Actions;
	}): WorkspaceClientBuilder<
		TId,
		TTableDefinitions,
		TKvDefinitions,
		TAwarenessDefinitions,
		TExtensions
	> {
		const dispose = async (): Promise<void> => {
			// Close all documents first (before extensions they depend on)
			for (const cleanup of documentCleanups) {
				await cleanup();
			}
			const errors = await disposeLifo(state.extensionCleanups);
			awareness.raw.destroy();
			ydoc.destroy();

			if (errors.length > 0) {
				throw new AggregateError(
					errors,
					`${errors.length} extension(s) failed during dispose`,
				);
			}
		};

		const whenReady = Promise.all(state.whenReadyPromises)
			.then(() => {})
			.catch(async (err) => {
				// If any extension's whenReady rejects, clean up everything
				await dispose().catch(() => {}); // idempotent
				throw err;
			});

		const client = {
			id,
			ydoc,
			definitions,
			tables,
			documents: typedDocuments,
			kv: kvHelper,
			awareness,
			// Each extension entry is the exports object stored by reference.
			extensions,
			actions,
			batch(fn: () => void): void {
				ydoc.transact(fn);
			},
			/**
			 * Apply a binary Y.js update to the underlying document.
			 *
			 * Use this to hydrate the workspace from a persisted snapshot (e.g. a `.yjs`
			 * file on disk) without exposing the raw Y.Doc to consumer code.
			 *
			 * @param update - A Uint8Array produced by `Y.encodeStateAsUpdate()` or equivalent
			 */
			loadSnapshot(update: Uint8Array): void {
				Y.applyUpdate(ydoc, update);
			},
			/**
			 * Get the encoded size of the current data doc in bytes.
			 *
			 * Useful for monitoring doc growth. This is the total
			 * CRDT state including history, not just the active data.
			 */
			encodedSize(): number {
				return Y.encodeStateAsUpdate(ydoc).byteLength;
			},
			/**
			 * Apply encryption keys to all stores.
			 *
			 * Decodes base64 user keys, derives per-workspace keys via HKDF-SHA256,
			 * and activates encryption on all stores. Once activated, stores permanently
			 * refuse plaintext writes — the only reset path is `clearLocalData()`.
			 *
			 * This method is synchronous — HKDF via @noble/hashes and XChaCha20 via
			 * @noble/ciphers are both sync. Call it after persistence is ready but
			 * before connecting sync.
			 *
			 * @param keys - Non-empty array of versioned user keys from the auth session
			 *
			 * @example
			 * ```typescript
			 * await workspace.whenReady;
			 * workspace.applyEncryptionKeys(session.encryptionKeys);
			 * workspace.extensions.sync.connect();
			 * ```
			 */
			applyEncryptionKeys(keys: EncryptionKeys): void {
				const fingerprint = encryptionKeysFingerprint(keys);
				if (fingerprint === lastKeysFingerprint) return;
				lastKeysFingerprint = fingerprint;

				const keyring = new Map<number, Uint8Array>();
				for (const { version, userKeyBase64 } of keys) {
					const userKey = base64ToBytes(userKeyBase64);
					keyring.set(version, deriveWorkspaceKey(userKey, id));
				}
				for (const store of encryptedStores) {
					store.activateEncryption(keyring);
				}
			},
			async clearLocalData(): Promise<void> {
				for (let i = state.clearLocalDataCallbacks.length - 1; i >= 0; i--) {
					try {
						await state.clearLocalDataCallbacks[i]?.();
					} catch (err) {
						console.error('Extension clearLocalData error:', err);
					}
				}
			},
			whenReady,
			dispose,
			[Symbol.asyncDispose]: dispose,
		};

		/**
		 * Apply an extension factory to the workspace Y.Doc.
		 *
		 * Shared by `withExtension` and `withWorkspaceExtension` — the only
		 * difference is whether `withExtension` also registers the factory for
		 * document Y.Docs (fired lazily at `documents.open()` time).
		 */
		function applyWorkspaceExtension<
			TKey extends string,
			TExports extends Record<string, unknown>,
		>(
			key: TKey,
			factory: (
				context: ExtensionContext<
					TId,
					TTableDefinitions,
					TKvDefinitions,
					TAwarenessDefinitions,
					TExtensions
				>,
			) => TExports & {
				whenReady?: Promise<unknown>;
				dispose?: () => MaybePromise<void>;
				clearLocalData?: () => MaybePromise<void>;
			},
		) {
			const {
				dispose: _dispose,
				[Symbol.asyncDispose]: _asyncDispose,
				whenReady: _whenReady,
				...clientContext
			} = client;
			const ctx = {
				...clientContext,
				whenReady:
					state.whenReadyPromises.length === 0
						? Promise.resolve()
						: Promise.all(state.whenReadyPromises).then(() => {}),
			};

			try {
				const raw = factory(ctx);

				// Void return means "not installed" — skip registration
				if (!raw) return buildClient({ extensions, state, actions });

				const resolved = defineExtension(raw);

				return buildClient({
					extensions: {
						...extensions,
						[key]: resolved,
					} as TExtensions & Record<TKey, TExports>,
					state: {
						extensionCleanups: [...state.extensionCleanups, resolved.dispose],
						clearLocalDataCallbacks: [
							...state.clearLocalDataCallbacks,
							...(resolved.clearLocalData ? [resolved.clearLocalData] : []),
						],
						whenReadyPromises: [...state.whenReadyPromises, resolved.whenReady],
					},
					actions,
				});
			} catch (err) {
				startDisposeLifo(state.extensionCleanups);
				throw err;
			}
		}

		// The builder methods use generics at the type level for progressive accumulation,
		// but the runtime implementations use wider types for storage (registrations array).
		// The cast at the end bridges the gap — type safety is enforced at call sites.

		/**
		 * Register an extension for both the workspace Y.Doc and every document Y.Doc.
		 *
		 * Extensions initialize in registration order. The factory receives a `whenReady`
		 * promise that resolves when all previously registered extensions have finished
		 * initializing. Extensions that await this promise create a sequential dependency;
		 * extensions that ignore it run in parallel with earlier ones.
		 *
		 * The typical chain is persistence → encryption/unlock → sync. Persistence loads
		 * local state first, so sync only exchanges the delta with the server.
		 *
		 * The factory only receives `SharedExtensionContext` (`ydoc`, `awareness`, `whenReady`)
		 * since the same factory runs for both workspace and document Y.Docs. Use
		 * `withWorkspaceExtension` if you need tables, KV, or other workspace-specific context.
		 *
		 * @example
		 * ```typescript
		 * createWorkspace(definition)
		 *   .withExtension('persistence', filesystemPersistence({ filePath: '...' }))
		 *   .withExtension('sync', createSyncExtension({ url: ... }))
		 * ```
		 */
		const builder = Object.assign(client, {
			withExtension<
				TKey extends string,
				TExports extends Record<string, unknown>,
			>(
				key: TKey,
				factory: (context: {
					ydoc: Y.Doc;
					awareness: { raw: Awareness };
					whenReady: Promise<void>;
				}) => TExports & {
					whenReady?: Promise<unknown>;
					dispose?: () => MaybePromise<void>;
					clearLocalData?: () => MaybePromise<void>;
				},
			) {
				// Registers for both workspace and document scopes.
				// The factory only receives SharedExtensionContext (ydoc + awareness + whenReady),
				// which is a structural subset of both ExtensionContext and DocumentContext.
				documentExtensionRegistrations.push({
					key,
					factory,
				});
				return applyWorkspaceExtension(key, factory);
			},

			/**
			 * Register an extension for the workspace Y.Doc only.
			 *
			 * Same initialization ordering as `withExtension`—the factory receives a `whenReady`
			 * promise from all prior extensions. Use this when the factory needs workspace-specific
			 * context (tables, KV, awareness, documents) that `withExtension` doesn't provide.
			 *
			 * @example
			 * ```typescript
			 * createWorkspace(definition)
			 *   .withExtension('persistence', filesystemPersistence({ filePath: '...' }))
			 *   .withWorkspaceExtension('materializer', (ctx) =>
			 *     createMarkdownMaterializer(ctx, { dir: './data' })
			 *       .table('notes', { serialize: slugFilename('title') }))
			 * ```
			 */
			withWorkspaceExtension<
				TKey extends string,
				TExports extends Record<string, unknown>,
			>(
				key: TKey,
				factory: (
					context: ExtensionContext<
						TId,
						TTableDefinitions,
						TKvDefinitions,
						TAwarenessDefinitions,
						TExtensions
					>,
				) => TExports & {
					whenReady?: Promise<unknown>;
					dispose?: () => MaybePromise<void>;
					clearLocalData?: () => MaybePromise<void>;
				},
			) {
				return applyWorkspaceExtension(key, factory);
			},

			withDocumentExtension(
				key: string,
				factory: (context: DocumentContext) =>
					| (Record<string, unknown> & {
							whenReady?: Promise<unknown>;
							dispose?: () => MaybePromise<void>;
							clearLocalData?: () => MaybePromise<void>;
					  })
					| void,
			) {
				documentExtensionRegistrations.push({
					key,
					factory,
				});
				return buildClient({ extensions, state, actions });
			},

			withActions(
				factory: (
					client: WorkspaceClient<
						TId,
						TTableDefinitions,
						TKvDefinitions,
						TAwarenessDefinitions,
						TExtensions
					>,
				) => Actions,
			) {
				const newActions = factory(client);
				const allActions = { ...actions, ...newActions };

				// Wire actions into the sync extension for inbound RPC dispatch.
				// The sync extension is registered before actions (it needs to connect
				// first), so we push actions to it after the fact.
				const sync = (extensions as Record<string, any>).sync;
				if (typeof sync?.registerActions === 'function') {
					sync.registerActions(allActions);
				}

				return buildClient({
					extensions,
					state,
					actions: allActions,
				});
			},
		});

		return builder as unknown as WorkspaceClientBuilder<
			TId,
			TTableDefinitions,
			TKvDefinitions,
			TAwarenessDefinitions,
			TExtensions
		>;
	}

	return buildClient({
		extensions: {} as Record<string, never>,
		state: {
			extensionCleanups: [],
			clearLocalDataCallbacks: [],
			whenReadyPromises: [],
		},
		actions: {},
	});
}
