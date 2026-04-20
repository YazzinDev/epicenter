/**
 * SQLite Materializer Tests
 *
 * Tests the full createSqliteMaterializer lifecycle: DDL generation, full load,
 * incremental sync, FTS5 search, rebuild, and dispose. Uses real Yjs documents
 * with defineTable schemas so the materializer exercises the actual workspace
 * observation path.
 *
 * Key behaviors:
 * - Materializer waits for workspace whenReady before touching SQLite
 * - Full load inserts all valid rows on initialization
 * - Observer-based sync upserts changed rows and deletes removed rows
 * - FTS5 search returns ranked results with snippets
 * - rebuild() drops and recreates all materialized data
 * - dispose() stops observers and clears timeouts
 */

import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { type } from 'arktype';
import { createWorkspace, defineTable } from '../../../workspace/index.js';
import { createSqliteMaterializer } from './sqlite.js';
import type { MirrorDatabase } from './types.js';
import { isAction, isQuery, isMutation } from '../../../shared/actions.js';

const postsTable = defineTable(
	type({ id: 'string', _v: '1', title: 'string', 'published?': 'boolean' }),
);

const notesTable = defineTable(type({ id: 'string', _v: '1', body: 'string' }));

const hasFts5 = canUseFts5();

type TestDb = MirrorDatabase & {
	raw: Database;
	sqlCalls: string[];
	close(): void;
};

function createTestDb(): TestDb {
	const raw = new Database(':memory:');
	const sqlCalls: string[] = [];

	return {
		raw,
		sqlCalls,
		close() {
			raw.close();
		},
		run(sql: string) {
			sqlCalls.push(sql);
			return raw.run(sql);
		},
		prepare(sql: string) {
			sqlCalls.push(sql);
			return raw.prepare(sql);
		},
	};
}

type SetupOptions = {
	tables?: Array<{
		name: string;
		config?: { fts?: string[]; serialize?: (value: unknown) => unknown };
	}>;
	debounceMs?: number;
};

function setup(options: SetupOptions = {}) {
	const db = createTestDb();
	const workspace = createWorkspace({
		id: 'test',
		tables: { posts: postsTable, notes: notesTable },
	}).withWorkspaceExtension('sqlite', (ctx) => {
		const materializer = createSqliteMaterializer(ctx, {
			db,
			debounceMs: options.debounceMs,
		});

		// Default: register both tables if no specific tables provided
		const tablesToRegister = options.tables ?? [
			{ name: 'posts' },
			{ name: 'notes' },
		];

		for (const tableOpt of tablesToRegister) {
			materializer.table(tableOpt.name, tableOpt.config);
		}

		return materializer;
	});

	return { db, workspace };
}

function createDeferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((promiseResolve) => {
		resolve = promiseResolve;
	});

	return { promise, resolve };
}

function canUseFts5() {
	const raw = new Database(':memory:');

	try {
		raw.run('CREATE VIRTUAL TABLE test_fts USING fts5(title)');
		return true;
	} catch {
		return false;
	} finally {
		raw.close();
	}
}

async function waitForSyncCycle() {
	await new Promise((resolve) => setTimeout(resolve, 200));
}

function getRows(db: TestDb, tableName: string) {
	return db.raw.prepare(`SELECT * FROM "${tableName}" ORDER BY "id"`).all() as Record<string, unknown>[];
}

function hasTable(db: TestDb, tableName: string) {
	const row = db.raw
		.prepare('SELECT name FROM sqlite_master WHERE type = ? AND name = ?')
		.get('table', tableName);
	return row != null;
}

async function cleanup(setupResult: ReturnType<typeof setup>) {
	await setupResult.workspace.dispose();
	setupResult.db.close();
}

// ============================================================================
// READINESS Tests
// ============================================================================

describe('createSqliteMaterializer', () => {
	describe('readiness', () => {
		test('waits for workspace whenReady before touching SQLite', async () => {
			const db = createTestDb();
			const gate = createDeferred();
			const workspace = createWorkspace({
				id: 'ready-gated',
				tables: { posts: postsTable, notes: notesTable },
			})
				.withWorkspaceExtension('gate', () => ({ whenReady: gate.promise }))
				.withWorkspaceExtension('sqlite', (ctx) =>
					createSqliteMaterializer(ctx, { db }).table('posts').table('notes'),
				);

			try {
				await new Promise((resolve) => setTimeout(resolve, 25));
				expect(db.sqlCalls).toHaveLength(0);

				gate.resolve();
				await workspace.extensions.sqlite.whenReady;

				expect(db.sqlCalls.length).toBeGreaterThan(0);
				expect(hasTable(db, 'posts')).toBe(true);
			} finally {
				gate.resolve();
				await workspace.dispose();
				db.close();
			}
		});
	});

	// ============================================================================
	// FULL LOAD Tests
	// ============================================================================

	describe('full load', () => {
		test('mirrors existing rows on initialization', async () => {
			const testSetup = setup();

			try {
				testSetup.workspace.tables.posts.set({
					id: 'post-1',
					title: 'Hello mirror',
					published: true,
					_v: 1,
				});
				testSetup.workspace.tables.posts.set({
					id: 'post-2',
					title: 'Second row',
					_v: 1,
				});

				await testSetup.workspace.extensions.sqlite.whenReady;

				expect(getRows(testSetup.db, 'posts')).toEqual([
					{ id: 'post-1', _v: 1, published: 1, title: 'Hello mirror' },
					{ id: 'post-2', _v: 1, published: null, title: 'Second row' },
				]);
			} finally {
				await cleanup(testSetup);
			}
		});

		test('mirrors only specified tables when tables option is provided', async () => {
			const testSetup = setup({ tables: [{ name: 'posts' }] });

			try {
				testSetup.workspace.tables.posts.set({
					id: 'post-1',
					title: 'Mirrored post',
					_v: 1,
				});
				testSetup.workspace.tables.notes.set({
					id: 'note-1',
					body: 'Ignored note',
					_v: 1,
				});

				await testSetup.workspace.extensions.sqlite.whenReady;

				expect(hasTable(testSetup.db, 'posts')).toBe(true);
				expect(hasTable(testSetup.db, 'notes')).toBe(false);
				expect(getRows(testSetup.db, 'posts')).toEqual([
					{ id: 'post-1', _v: 1, published: null, title: 'Mirrored post' },
				]);
			} finally {
				await cleanup(testSetup);
			}
		});
	});

	// ============================================================================
	// INCREMENTAL SYNC Tests
	// ============================================================================

	describe('incremental sync', () => {
		test('upserts rows added after initialization', async () => {
			const testSetup = setup();

			try {
				await testSetup.workspace.extensions.sqlite.whenReady;

				testSetup.workspace.tables.posts.set({
					id: 'post-1',
					title: 'Added later',
					published: true,
					_v: 1,
				});

				await waitForSyncCycle();

				expect(getRows(testSetup.db, 'posts')).toEqual([
					{ id: 'post-1', _v: 1, published: 1, title: 'Added later' },
				]);
			} finally {
				await cleanup(testSetup);
			}
		});

		test('deletes rows removed from workspace', async () => {
			const testSetup = setup();

			try {
				testSetup.workspace.tables.posts.set({
					id: 'post-1',
					title: 'Delete me',
					_v: 1,
				});

				await testSetup.workspace.extensions.sqlite.whenReady;
				testSetup.workspace.tables.posts.delete('post-1');

				await waitForSyncCycle();

				expect(getRows(testSetup.db, 'posts')).toEqual([]);
			} finally {
				await cleanup(testSetup);
			}
		});

		test('updates rows modified in workspace', async () => {
			const testSetup = setup();

			try {
				testSetup.workspace.tables.posts.set({
					id: 'post-1',
					title: 'Before update',
					published: true,
					_v: 1,
				});

				await testSetup.workspace.extensions.sqlite.whenReady;
				testSetup.workspace.tables.posts.update('post-1', {
					title: 'After update',
					published: false,
				});

				await waitForSyncCycle();

				expect(getRows(testSetup.db, 'posts')).toEqual([
					{ id: 'post-1', _v: 1, published: 0, title: 'After update' },
				]);
			} finally {
				await cleanup(testSetup);
			}
		});
	});

	// ============================================================================
	// REBUILD Tests
	// ============================================================================

	describe('rebuild', () => {
		test('rebuild repopulates SQLite from Yjs', async () => {
			const testSetup = setup();

			try {
				testSetup.workspace.tables.posts.set({
					id: 'post-1',
					title: 'Persisted in Yjs',
					_v: 1,
				});

				await testSetup.workspace.extensions.sqlite.whenReady;
				testSetup.db.run('DELETE FROM "posts"');

				expect(getRows(testSetup.db, 'posts')).toEqual([]);

				await testSetup.workspace.extensions.sqlite.rebuild({});

				expect(getRows(testSetup.db, 'posts')).toEqual([
					{ id: 'post-1', _v: 1, published: null, title: 'Persisted in Yjs' },
				]);
			} finally {
				await cleanup(testSetup);
			}
		});

		test('rebuild single table without touching others', async () => {
			const testSetup = setup();

			try {
				testSetup.workspace.tables.posts.set({
					id: 'post-1',
					title: 'Post row',
					_v: 1,
				});
				testSetup.workspace.tables.notes.set({
					id: 'note-1',
					body: 'Note row',
					_v: 1,
				});

				await testSetup.workspace.extensions.sqlite.whenReady;
				testSetup.db.run('DELETE FROM "posts"');

				expect(getRows(testSetup.db, 'posts')).toEqual([]);
				expect(getRows(testSetup.db, 'notes')).toHaveLength(1);

				await testSetup.workspace.extensions.sqlite.rebuild({ table: 'posts' });

				expect(getRows(testSetup.db, 'posts')).toEqual([
					{ id: 'post-1', _v: 1, published: null, title: 'Post row' },
				]);
				expect(getRows(testSetup.db, 'notes')).toHaveLength(1);
			} finally {
				await cleanup(testSetup);
			}
		});

		test('rebuild throws for unknown table name', async () => {
			const testSetup = setup();

			try {
				await testSetup.workspace.extensions.sqlite.whenReady;

				await expect(
					testSetup.workspace.extensions.sqlite.rebuild({
						table: 'nonexistent',
					}),
				).rejects.toThrow('not in the materialized table set');
			} finally {
				await cleanup(testSetup);
			}
		});
	});

	describe('count', () => {
		test('count returns row count for a materialized table', async () => {
			const testSetup = setup();

			try {
				testSetup.workspace.tables.posts.set({
					id: 'post-1',
					title: 'First',
					_v: 1,
				});
				testSetup.workspace.tables.posts.set({
					id: 'post-2',
					title: 'Second',
					_v: 1,
				});

				await testSetup.workspace.extensions.sqlite.whenReady;

				expect(await testSetup.workspace.extensions.sqlite.count({ table: 'posts' })).toBe(2);
				expect(await testSetup.workspace.extensions.sqlite.count({ table: 'notes' })).toBe(0);
			} finally {
				await cleanup(testSetup);
			}
		});

		test('count returns 0 for non-existent table', async () => {
			const testSetup = setup();

			try {
				await testSetup.workspace.extensions.sqlite.whenReady;

				expect(
					await testSetup.workspace.extensions.sqlite.count({
						table: 'nonexistent',
					}),
				).toBe(0);
			} finally {
				await cleanup(testSetup);
			}
		});
	});

	// ============================================================================
	// DISPOSE Tests
	// ============================================================================

	describe('dispose', () => {
		test('dispose cancels queued sync and ignores later writes', async () => {
			const testSetup = setup();

			try {
				await testSetup.workspace.extensions.sqlite.whenReady;

				testSetup.workspace.tables.posts.set({
					id: 'post-1',
					title: 'Queued row',
					_v: 1,
				});
				testSetup.workspace.extensions.sqlite.dispose();

				await waitForSyncCycle();

				testSetup.workspace.tables.posts.set({
					id: 'post-2',
					title: 'Ignored row',
					_v: 1,
				});

				await waitForSyncCycle();

				expect(getRows(testSetup.db, 'posts')).toEqual([]);
			} finally {
				await cleanup(testSetup);
			}
		});
	});

	// ============================================================================
	// SEARCH Tests
	// ============================================================================

	describe('search', () => {
		test('search returns empty array when fts is not configured', async () => {
			const testSetup = setup();

			try {
				await testSetup.workspace.extensions.sqlite.whenReady;

				expect(
					await testSetup.workspace.extensions.sqlite.search({ table: 'posts', query: 'hello' }),
				).toEqual([]);
			} finally {
				await cleanup(testSetup);
			}
		});

		if (hasFts5) {
			test('search returns ranked results with snippets when fts is configured', async () => {
				const testSetup = setup({
					tables: [
						{ name: 'posts', config: { fts: ['title'] } },
						{ name: 'notes' },
					],
				});

				try {
					testSetup.workspace.tables.posts.set({
						id: 'post-1',
						title: 'Epicenter local-first mirror',
						_v: 1,
					});
					testSetup.workspace.tables.posts.set({
						id: 'post-2',
						title: 'Another search result',
						_v: 1,
					});

					await testSetup.workspace.extensions.sqlite.whenReady;

					const results = await testSetup.workspace.extensions.sqlite.search({
						table: 'posts',
						query: 'mirror',
						limit: 10,
					}) as Array<{ id: string; snippet: string; rank: number }>;

					expect(results).toHaveLength(1);
					expect(results[0]?.id).toBe('post-1');
					expect(results[0]?.snippet).toContain('<mark>');
					expect(typeof results[0]?.rank).toBe('number');
				} finally {
					await cleanup(testSetup);
				}
			});
		}
	});

	// ============================================================================
	// ACTION BRAND Tests
	// ============================================================================

	describe('action brand', () => {
		test('search, count, rebuild are detectable via isAction()', async () => {
			const testSetup = setup();

			try {
				const { sqlite } = testSetup.workspace.extensions;
				expect(isAction(sqlite.search)).toBe(true);
				expect(isAction(sqlite.count)).toBe(true);
				expect(isAction(sqlite.rebuild)).toBe(true);

				expect(isQuery(sqlite.search)).toBe(true);
				expect(isQuery(sqlite.count)).toBe(true);
				expect(isMutation(sqlite.rebuild)).toBe(true);

				// Lifecycle hooks are NOT actions
				expect(isAction(sqlite.dispose)).toBe(false);
			} finally {
				await cleanup(testSetup);
			}
		});
	});
});
