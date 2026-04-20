/**
 * FTS5 full-text search setup for the SQLite materializer.
 *
 * Pure functions that generate FTS5 virtual tables and content-sync triggers,
 * plus the search query builder. Separated from the main materializer so
 * FTS concerns don't pollute the core sync logic.
 *
 * @module
 */

import { quoteIdentifier } from './ddl.js';
import type { MirrorDatabase, SearchOptions, SearchResult } from './types.js';

// ════════════════════════════════════════════════════════════════════════════
// FTS SETUP
// ════════════════════════════════════════════════════════════════════════════

/**
 * Create FTS5 virtual table and content-sync triggers for a materializer table.
 *
 * Sets up:
 * 1. `CREATE VIRTUAL TABLE IF NOT EXISTS {table}_fts USING fts5(...)` with content sync
 * 2. AFTER INSERT trigger to index new rows
 * 3. AFTER DELETE trigger to remove deleted rows
 * 4. AFTER UPDATE trigger to re-index changed rows
 *
 * @param db - The mirror database to execute DDL against
 * @param tableName - The source table name
 * @param columns - Column names to include in the FTS index
 */
export async function setupFtsTable(
	db: MirrorDatabase,
	tableName: string,
	columns: string[],
): Promise<void> {
	const ftsTableName = `${tableName}_fts`;
	const quotedColumns = columns.map(quoteIdentifier).join(', ');
	const newValues = columns
		.map((column) => `new.${quoteIdentifier(column)}`)
		.join(', ');
	const oldValues = columns
		.map((column) => `old.${quoteIdentifier(column)}`)
		.join(', ');

	const qt = quoteIdentifier(tableName);
	const qfts = quoteIdentifier(ftsTableName);

	await db.run(
		`CREATE VIRTUAL TABLE IF NOT EXISTS ${qfts}\n` +
			`USING fts5(${quotedColumns}, content=${quoteString(tableName)}, content_rowid=rowid)`,
	);

	await db.run(
		`CREATE TRIGGER IF NOT EXISTS ${quoteIdentifier(`${tableName}_fts_ai`)}\n` +
			`AFTER INSERT ON ${qt} BEGIN\n` +
			`  INSERT INTO ${qfts}(rowid, ${quotedColumns})\n` +
			`  VALUES (new.rowid, ${newValues});\n` +
			`END`,
	);

	await db.run(
		`CREATE TRIGGER IF NOT EXISTS ${quoteIdentifier(`${tableName}_fts_ad`)}\n` +
			`AFTER DELETE ON ${qt} BEGIN\n` +
			`  INSERT INTO ${qfts}(${qfts}, rowid, ${quotedColumns})\n` +
			`  VALUES('delete', old.rowid, ${oldValues});\n` +
			`END`,
	);

	await db.run(
		`CREATE TRIGGER IF NOT EXISTS ${quoteIdentifier(`${tableName}_fts_au`)}\n` +
			`AFTER UPDATE ON ${qt} BEGIN\n` +
			`  INSERT INTO ${qfts}(${qfts}, rowid, ${quotedColumns})\n` +
			`  VALUES('delete', old.rowid, ${oldValues});\n` +
			`  INSERT INTO ${qfts}(rowid, ${quotedColumns})\n` +
			`  VALUES (new.rowid, ${newValues});\n` +
			`END`,
	);
}

// ════════════════════════════════════════════════════════════════════════════
// FTS SEARCH
// ════════════════════════════════════════════════════════════════════════════

/**
 * Execute a FTS5 search query against a materialized table.
 *
 * Returns ranked results with snippet text. The query is trimmed and
 * empty queries return an empty array. If the FTS table doesn't exist
 * or the query fails, returns an empty array with a warning.
 *
 * @param db - The mirror database to query
 * @param tableName - The source table name (FTS table is `{tableName}_fts`)
 * @param ftsColumns - The columns indexed in FTS5 (needed for snippet column index)
 * @param query - The FTS5 search query string
 * @param options - Optional search configuration (limit, snippet column)
 * @returns Array of search results sorted by relevance
 */
export async function ftsSearch(
	db: MirrorDatabase,
	tableName: string,
	ftsColumns: string[],
	query: string,
	options?: SearchOptions,
): Promise<SearchResult[]> {
	const trimmed = query.trim();
	if (!trimmed) {
		return [];
	}

	const ftsTableName = `${tableName}_fts`;
	const limit = options?.limit ?? 50;
	const snippetColumnIndex = options?.snippetColumn
		? Math.max(ftsColumns.indexOf(options.snippetColumn), 0)
		: 0;

	try {
		const qt = quoteIdentifier(tableName);
		const qfts = quoteIdentifier(ftsTableName);
		const stmt = await db.prepare(
			`SELECT ${qt}.${quoteIdentifier('id')} AS id,\n` +
				`  snippet(${qfts}, ${snippetColumnIndex}, '<mark>', '</mark>', '...', 64) AS snippet,\n` +
				`  rank\n` +
				`FROM ${qfts}\n` +
				`JOIN ${qt} ON ${qt}.rowid = ${qfts}.rowid\n` +
				`WHERE ${qfts} MATCH ?\n` +
				`ORDER BY rank LIMIT ?`,
		);
		const rows = await stmt.all(trimmed, limit);

		return rows.map((row) => {
			const r = row as Record<string, unknown>;
			return {
				id: String(r.id),
				snippet: String(r.snippet ?? ''),
				rank: Number(r.rank ?? 0),
			};
		});
	} catch (error: unknown) {
		console.warn('[createSqliteMaterializer] FTS search failed.', error);
		return [];
	}
}

// ════════════════════════════════════════════════════════════════════════════
// PRIVATE HELPERS
// ════════════════════════════════════════════════════════════════════════════

function quoteString(value: string) {
	return `'${value.replaceAll("'", "''")}'`;
}
