/**
 * Creates a TableHelper for a single table bound to a YKeyValue store.
 *
 * Provides CRUD operations with schema validation and migration on read.
 * This is the primary building block for table construction, used by
 * createWorkspace (which creates the store for encryption coordination)
 * and by tests.
 */

import type { YKeyValueLwwChange } from '../shared/y-keyvalue/y-keyvalue-lww.js';
import type { EncryptedYKeyValueLww } from '../shared/y-keyvalue/y-keyvalue-lww-encrypted.js';
import type {
	GetResult,
	InferTableRow,
	InvalidRowResult,
	RowResult,
	TableDefinition,
	TableHelper,
	UpdateResult,
} from './types.js';

/**
 * Creates a TableHelper for a single table bound to a YKeyValue store.
 *
 * @param ykv - The backing YKeyValue store (encrypted or passthrough)
 * @param definition - The table definition with schema and migration
 * @returns TableHelper with type-safe CRUD, query, and observation methods
 */
export function createTable<
	// biome-ignore lint/suspicious/noExplicitAny: variance-friendly — defineTable already constrains schemas
	TTableDefinition extends TableDefinition<any>,
>(
	ykv: EncryptedYKeyValueLww<unknown>,
	definition: TTableDefinition,
): TableHelper<InferTableRow<TTableDefinition>> {
	type TRow = InferTableRow<TTableDefinition>;
	/**
	 * Parse and migrate a raw row value. Injects `id` into the input before validation.
	 */
	function parseRow(id: string, input: unknown): RowResult<TRow> {
		const row = { ...(input as Record<string, unknown>), id };
		const result = definition.schema['~standard'].validate(row);
		if (result instanceof Promise)
			throw new TypeError('Async schemas not supported');
		if (result.issues)
			return { status: 'invalid', id, errors: result.issues, row };
		// Migrate to latest version. The cast is safe because `id` was injected
		// into the input above and preserved through validation + migration.
		const migrated = definition.migrate(result.value) as TRow;
		return { status: 'valid', row: migrated };
	}

	return {
		// ═══════════════════════════════════════════════════════════════════════
		// PARSE
		// ═══════════════════════════════════════════════════════════════════════

		parse(id: string, input: unknown): RowResult<TRow> {
			return parseRow(id, input);
		},

		// ═══════════════════════════════════════════════════════════════════════
		// WRITE
		// ═══════════════════════════════════════════════════════════════════════

		set(row: TRow): void {
			ykv.set(row.id, row);
		},

		/**
		 * Insert many rows in chunked transactions with event-loop yielding.
		 *
		 * Default chunkSize is 1000 (benchmarked sweet spot for inserts).
		 * The bottleneck for bulkSet is the observer's conflict resolution—
		 * each chunk triggers one observer pass that builds an entryIndexMap
		 * and deduplicates entries. Smaller chunks keep each pass manageable.
		 *
		 * Use `onProgress` for UI feedback (progress bars). The 1000 default
		 * balances progress granularity against per-chunk overhead.
		 */
		async bulkSet(
			rows: TRow[],
			options?: {
				chunkSize?: number;
				onProgress?: (percent: number) => void;
			},
		): Promise<void> {
			const { chunkSize = 1000, onProgress } = options ?? {};
			const total = rows.length;

			for (let i = 0; i < total; i += chunkSize) {
				const chunk = rows.slice(i, i + chunkSize);
				ykv.bulkSet(chunk.map((row) => ({ key: row.id, val: row })));
				onProgress?.(Math.min((i + chunkSize) / total, 1));
				await new Promise((resolve) => setTimeout(resolve, 0));
			}
		},

		// ═══════════════════════════════════════════════════════════════════════
		// UPDATE
		// ═══════════════════════════════════════════════════════════════════════

		update(id: string, partial: Partial<Omit<TRow, 'id'>>): UpdateResult<TRow> {
			const current = this.get(id);
			if (current.status !== 'valid') return current;

			const merged = { ...current.row, ...partial, id };
			const result = parseRow(id, merged);
			if (result.status === 'invalid') return result;

			this.set(result.row);
			return { status: 'updated', row: result.row };
		},

		// ═══════════════════════════════════════════════════════════════════════
		// READ
		// ═══════════════════════════════════════════════════════════════════════

		get(id: string): GetResult<TRow> {
			const raw = ykv.get(id);
			if (raw === undefined) {
				return { status: 'not_found', id, row: undefined };
			}
			return parseRow(id, raw);
		},

		getAll(): RowResult<TRow>[] {
			const results: RowResult<TRow>[] = [];
			for (const [key, entry] of ykv.readableEntries()) {
				const result = parseRow(key, entry.val);
				results.push(result);
			}
			return results;
		},

		getAllValid(): TRow[] {
			const rows: TRow[] = [];
			for (const [key, entry] of ykv.readableEntries()) {
				const result = parseRow(key, entry.val);
				if (result.status === 'valid') {
					rows.push(result.row);
				}
			}
			return rows;
		},

		getAllInvalid(): InvalidRowResult[] {
			const invalid: InvalidRowResult[] = [];
			for (const [key, entry] of ykv.readableEntries()) {
				const result = parseRow(key, entry.val);
				if (result.status === 'invalid') {
					invalid.push(result);
				}
			}
			return invalid;
		},

		// ═══════════════════════════════════════════════════════════════════════
		// QUERY
		// ═══════════════════════════════════════════════════════════════════════

		filter(predicate: (row: TRow) => boolean): TRow[] {
			const rows: TRow[] = [];
			for (const [key, entry] of ykv.readableEntries()) {
				const result = parseRow(key, entry.val);
				if (result.status === 'valid' && predicate(result.row)) {
					rows.push(result.row);
				}
			}
			return rows;
		},

		find(predicate: (row: TRow) => boolean): TRow | undefined {
			for (const [key, entry] of ykv.readableEntries()) {
				const result = parseRow(key, entry.val);
				if (result.status === 'valid' && predicate(result.row)) {
					return result.row;
				}
			}
			return undefined;
		},

		// ═══════════════════════════════════════════════════════════════════════
		// DELETE
		// ═══════════════════════════════════════════════════════════════════════

		delete(id: string): void {
			ykv.delete(id);
		},

		/**
		 * Delete many rows in chunked transactions with event-loop yielding.
		 *
		 * Default chunkSize is 2500 (benchmarked sweet spot for deletions).
		 * This differs from bulkSet's default of 1000 because the cost profiles
		 * are different:
		 *
		 * - **bulkSet** is bottlenecked by observer conflict resolution (entryIndexMap
		 *   build + dedup). Smaller chunks keep each observer pass manageable.
		 * - **bulkDelete** is bottlenecked by `Y.Array.delete()` linked-list walks
		 *   inside the Yjs transaction. Moderate chunks (2000–3000) amortize the
		 *   per-chunk overhead without overloading a single transaction.
		 *
		 * The `toArray()` scan inside `ykv.bulkDelete` is ~0.04ms even at 25K entries—
		 * negligible. The real cost is the Yjs linked-list deletion, which scales
		 * non-linearly within large transactions.
		 *
		 * Benchmark data (25K rows):
		 * ```
		 * chunkSize=100:    ~360ms
		 * chunkSize=500:     ~97ms
		 * chunkSize=1000:    ~74ms
		 * chunkSize=2500:    ~66ms  ← default
		 * chunkSize=5000:    ~96ms
		 * single call:      ~215ms
		 * ```
		 */
		async bulkDelete(
			ids: string[],
			options?: {
				chunkSize?: number;
				onProgress?: (percent: number) => void;
			},
		): Promise<void> {
			const { chunkSize = 2500, onProgress } = options ?? {};
			const total = ids.length;

			for (let i = 0; i < total; i += chunkSize) {
				const chunk = ids.slice(i, i + chunkSize);
				ykv.bulkDelete(chunk);
				onProgress?.(Math.min((i + chunkSize) / total, 1));
				await new Promise((resolve) => setTimeout(resolve, 0));
			}
		},

		clear(): void {
			const keys = Array.from(ykv.readableEntries()).map(([k]) => k);
			ykv.bulkDelete(keys);
		},

		// ═══════════════════════════════════════════════════════════════════════
		// OBSERVE
		// ═══════════════════════════════════════════════════════════════════════

		observe(
			callback: (changedIds: ReadonlySet<TRow['id']>, origin?: unknown) => void,
		): () => void {
			const handler = (
				changes: Map<string, YKeyValueLwwChange<unknown>>,
				origin: unknown,
			) => {
				callback(new Set(changes.keys()) as ReadonlySet<TRow['id']>, origin);
			};

			ykv.observe(handler);
			return () => ykv.unobserve(handler);
		},

		// ═══════════════════════════════════════════════════════════════════════
		// METADATA
		// ═══════════════════════════════════════════════════════════════════════

		count(): number {
			return ykv.readableEntryCount;
		},

		has(id: string): boolean {
			return ykv.has(id);
		},
	};
}
