import { mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { MaybePromise } from '../../../workspace/lifecycle.js';
import type { KvHelper, TableHelper } from '../../../workspace/types.js';
import type { SerializeResult } from './markdown.js';
import { toMarkdown } from './markdown.js';
import { parseMarkdownFile } from './parse-markdown-file.js';

/**
 * Create a bidirectional markdown materializer for workspace data.
 *
 * Nothing materializes by default. Call `.table()` to opt in per table and
 * `.kv()` to opt in KV. Each `.table()` call validates the table name against
 * the workspace definition and infers the row type for the serialize callback.
 *
 * The materializer awaits `ctx.whenReady` before reading data, so persistence
 * and sync have loaded before the initial flush. All `.table()` and `.kv()`
 * calls happen synchronously in the factory closure before `whenReady` resolves.
 *
 * @example
 * ```typescript
 * .withWorkspaceExtension('materializer', (ctx) =>
 *   createMarkdownMaterializer(ctx, { dir: './data' })
 *     .table('posts', { serialize: slugFilename('title') })
 *     .kv(),
 * )
 * ```
 */
export function createMarkdownMaterializer<
	// biome-ignore lint/suspicious/noExplicitAny: generic bound for heterogeneous table helpers
	TTables extends Record<string, TableHelper<any>>,
	// biome-ignore lint/suspicious/noExplicitAny: generic bound for heterogeneous kv helpers
	TKv extends KvHelper<any>,
>(
	ctx: { tables: TTables; kv: TKv; whenReady: Promise<void> },
	config: {
		/** Base output directory. Accepts a string or async getter for lazy path resolution. */
		dir: string | (() => MaybePromise<string>);
	},
) {
	type TableConfigByName = {
		[TName in keyof TTables & string]?: {
			dir?: string;
			serialize?: TTables[TName] extends TableHelper<infer TRow>
				? (row: TRow) => MaybePromise<SerializeResult>
				: never;
			deserialize?: (parsed: {
				frontmatter: Record<string, unknown>;
				body: string | undefined;
			}) => MaybePromise<
				TTables[TName] extends TableHelper<infer TRow> ? TRow : never
			>;
		};
	};

	type TableRow<TName extends keyof TTables & string> =
		TTables[TName] extends TableHelper<infer TRow> ? TRow : never;

	type MaterializerBuilder = {
		table<TName extends keyof TTables & string>(
			name: TName,
			config?: {
				dir?: string;
				serialize?: TTables[TName] extends TableHelper<infer TRow>
					? (row: TRow) => MaybePromise<SerializeResult>
					: never;
				/** Parse a markdown file back into a table row. Required for `pushFromMarkdown`. Default: uses frontmatter fields directly. */
				deserialize?: (parsed: {
					frontmatter: Record<string, unknown>;
					body: string | undefined;
				}) => MaybePromise<
					TTables[TName] extends TableHelper<infer TRow> ? TRow : never
				>;
			},
		): MaterializerBuilder;
		/**
		 * Opt in to KV materialization.
		 *
		 * Writes a single file (default: `kv.json`) containing all KV values.
		 * The initial snapshot is seeded via `kv.getAll()`, then kept current
		 * via `kv.observeAll()`. Custom serialize receives the accumulated
		 * state and returns `SerializeResult`.
		 */
		kv(config?: {
			serialize?: (data: Record<string, unknown>) => SerializeResult;
		}): MaterializerBuilder;
		/**
		 * Read `.md` files from disk and import them into the Yjs workspace via `table.set()`.
		 *
		 * Each file is parsed for YAML frontmatter and an optional body. The `deserialize`
		 * callback (if provided per table) converts the parsed result to a row. When no
		 * `deserialize` is configured, frontmatter fields are used as the row directly.
		 *
		 * **This overwrites existing rows**—`table.set()` is insert-or-replace.
		 */
		pushFromMarkdown(): Promise<{
			imported: number;
			skipped: number;
			errors: string[];
		}>;
		/**
		 * Re-materialize all Yjs table data to markdown files on disk.
		 *
		 * Reads every valid row from each registered table, serializes it,
		 * and writes the result to disk. Does not remove orphaned files.
		 */
		pullToMarkdown(): Promise<{ written: number }>;
		whenReady: Promise<void>;
		dispose(): void;
	};

	const tableConfigs: TableConfigByName = {};
	const tableNames = new Set<keyof TTables & string>();
	let kvConfig:
		| {
				serialize?: (data: Record<string, unknown>) => SerializeResult;
		  }
		| undefined;
	let shouldMaterializeKv = false;
	const unsubscribers: Array<() => void> = [];

	const materializeTable = async <TName extends keyof TTables & string>(
		name: TName,
		dir: string,
	) => {
		const table = ctx.tables[name];
		if (!table) throw new Error(`Table "${name}" not found in workspace`);
		const tableConfig = tableConfigs[name];
		const directory = join(dir, tableConfig?.dir ?? name);
		const filenames = new Map<string, string>();

		const serialize: (row: TableRow<TName>) => MaybePromise<SerializeResult> =
			tableConfig?.serialize ??
			((row) => ({
				filename: `${row.id}.md`,
				content: toMarkdown({ ...row }),
			}));

		await mkdir(directory, { recursive: true });

		for (const row of table.getAllValid()) {
			const result = await serialize(row);
			await writeFile(join(directory, result.filename), result.content);
			filenames.set(row.id, result.filename);
		}

		// Sequential writes inside the observer avoid rename races — a parallel
		// approach (Promise.allSettled) could delete a file another write needs.
		const unsubscribe = table.observe((changedIds) => {
			void (async () => {
				for (const id of changedIds) {
					const getResult = table.get(id);

					if (getResult.status === 'not_found') {
						const previousFilename = filenames.get(id);
						if (previousFilename) {
							await unlink(join(directory, previousFilename)).catch(() => {});
							filenames.delete(id);
						}
						continue;
					}

					if (getResult.status !== 'valid') {
						continue;
					}

					const result = await serialize(getResult.row);
					const previousFilename = filenames.get(id);

					if (previousFilename && previousFilename !== result.filename) {
						await unlink(join(directory, previousFilename)).catch(() => {});
					}

					await writeFile(join(directory, result.filename), result.content);
					filenames.set(id, result.filename);
				}
			})().catch((error) => {
				console.warn('[markdown-materializer] table write failed:', error);
			});
		});

		unsubscribers.push(unsubscribe);
	};

	const materializeKv = async (dir: string) => {
		const kvState: Record<string, unknown> = { ...ctx.kv.getAll() };
		const serialize =
			kvConfig?.serialize ??
			((data: Record<string, unknown>) => ({
				filename: 'kv.json',
				content: JSON.stringify(data, null, 2),
			}));

		// Initial flush with the full snapshot
		const initial = serialize(kvState);
		await writeFile(join(dir, initial.filename), initial.content);

		const unsubscribe = ctx.kv.observeAll((changes) => {
			void (async () => {
				for (const [key, change] of changes) {
					if (change.type === 'set') {
						kvState[key] = change.value;
						continue;
					}

					delete kvState[key];
				}

				const result = serialize(kvState);
				await writeFile(join(dir, result.filename), result.content);
			})().catch((error) => {
				console.warn('[markdown-materializer] kv write failed:', error);
			});
		});

		unsubscribers.push(unsubscribe);
	};

	/** Resolve the base directory, handling string or async getter. */
	const resolveDir = async () =>
		typeof config.dir === 'function' ? await config.dir() : config.dir;

	const builder: MaterializerBuilder = {
		table(name, tableConfig) {
			tableNames.add(name);
			if (tableConfig) tableConfigs[name] = tableConfig;
			return builder;
		},
		kv(nextKvConfig) {
			shouldMaterializeKv = true;
			kvConfig = nextKvConfig;
			return builder;
		},
		async pushFromMarkdown() {
			const dir = await resolveDir();
			let imported = 0;
			let skipped = 0;
			const errors: string[] = [];

			for (const name of tableNames) {
				const table = ctx.tables[name];
				if (!table) continue;
				const tableConfig = tableConfigs[name];
				const directory = join(dir, tableConfig?.dir ?? name);

				let entries: string[];
				try {
					entries = await readdir(directory);
				} catch {
					continue;
				}

				for (const filename of entries) {
					if (!filename.endsWith('.md')) continue;

					let content: string;
					try {
						content = await readFile(join(directory, filename), 'utf-8');
					} catch (error) {
						errors.push(`Failed to read ${filename}: ${error}`);
						continue;
					}

					const parsed = parseMarkdownFile(content);
					if (!parsed) {
						skipped++;
						continue;
					}

					try {
						const deserialize =
							tableConfig?.deserialize ??
							((p: { frontmatter: Record<string, unknown> }) => p.frontmatter);
						const row = await deserialize(parsed);
						table.set(row);
						imported++;
					} catch (error) {
						errors.push(`Failed to import ${filename}: ${error}`);
					}
				}
			}

			return { imported, skipped, errors };
		},
		async pullToMarkdown() {
			const dir = await resolveDir();
			let written = 0;

			for (const name of tableNames) {
				const table = ctx.tables[name];
				if (!table) continue;
				const tableConfig = tableConfigs[name];
				const directory = join(dir, tableConfig?.dir ?? name);

				const serialize: (
					row: TableRow<typeof name>,
				) => MaybePromise<SerializeResult> =
					tableConfig?.serialize ??
					((row) => ({
						filename: `${row.id}.md`,
						content: toMarkdown({ ...row }),
					}));

				await mkdir(directory, { recursive: true });

				for (const row of table.getAllValid()) {
					const result = await serialize(row);
					await writeFile(join(directory, result.filename), result.content);
					written++;
				}
			}

			return { written };
		},
		whenReady: (async () => {
			await ctx.whenReady;
			const dir = await resolveDir();
			await mkdir(dir, { recursive: true });

			for (const name of tableNames) {
				await materializeTable(name, dir);
			}

			if (shouldMaterializeKv) {
				await materializeKv(dir);
			}
		})(),
		dispose() {
			for (const unsubscribe of unsubscribers.splice(0)) {
				unsubscribe();
			}
		},
	};

	return builder;
}
