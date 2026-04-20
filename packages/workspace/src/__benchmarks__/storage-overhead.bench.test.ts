/**
 * Storage Overhead Benchmarks
 *
 * Answers: "How big is my data in Y.Doc vs raw JSON?"
 *
 * Measures CRDT overhead ratios, per-row byte costs, size growth after updates,
 * and practical ceiling estimates for row counts.
 *
 * For comprehensive scaling measurements (timing, memory, encode/decode, multi-table),
 * see `scaling-ceiling.bench.test.ts`.
 */

import { describe, test } from 'bun:test';
import * as Y from 'yjs';
import { createTables } from '../workspace/create-tables.js';
import {
	formatBytes,
	generateId,
	heavyNoteDefinition,
	makeHeavyRow,
	noteDefinition,
	postDefinition,
} from './helpers.js';

// ═══════════════════════════════════════════════════════════════════════════════
// CRDT Overhead vs Raw JSON
// ═══════════════════════════════════════════════════════════════════════════════

describe('CRDT overhead vs raw JSON', () => {
	test('small row: actual payload vs Y.Doc overhead', () => {
		const ydoc = new Y.Doc();
		const tables = createTables(ydoc, { posts: postDefinition });

		// Example row
		const row = { id: 'id-000001', title: 'Post 1', views: 42 };
		const jsonPayload = JSON.stringify(row);
		console.log('\n=== SMALL ROW ANALYSIS ===');
		console.log(`Row data: ${jsonPayload}`);
		console.log(`JSON payload size: ${jsonPayload.length} bytes`);

		// What Y.js actually stores (from YKeyValueLww):
		// { key: 'id-000001', val: { id: 'id-000001', ... }, ts: 1706200000000 }
		const yEntry = { key: row.id, val: row, ts: Date.now() };
		console.log(`Y.js wrapper JSON: ${JSON.stringify(yEntry).length} bytes`);
		console.log(
			`Overhead: +${JSON.stringify(yEntry).length - jsonPayload.length} bytes (ID stored twice + timestamp)`,
		);

		// Insert 1000 rows
		for (let i = 0; i < 1_000; i++) {
			tables.posts.set({
				id: generateId(i),
				title: `Post ${i}`,
				views: i,
				_v: 1,
			});
		}

		const encoded = Y.encodeStateAsUpdate(ydoc);
		const pureJsonSize = jsonPayload.length * 1_000;
		console.log(`\nWith 1,000 rows:`);
		console.log(`  Y.Doc binary: ${(encoded.byteLength / 1024).toFixed(2)} KB`);
		console.log(`  Per row: ${(encoded.byteLength / 1_000).toFixed(0)} bytes`);
		console.log(
			`  Pure JSON would be: ~${(pureJsonSize / 1024).toFixed(0)} KB`,
		);
		console.log(
			`  CRDT overhead: ${((encoded.byteLength / pureJsonSize - 1) * 100).toFixed(0)}%`,
		);
	});

	test('realistic row: notes with 500 chars of content', () => {
		const ydoc = new Y.Doc();
		const tables = createTables(ydoc, { notes: noteDefinition });

		const sampleContent = `This is a realistic note with actual content. 
It might contain multiple paragraphs and various formatting.
Users typically write notes that are a few hundred characters long.
Some notes are longer, some are shorter, but this is a reasonable average.
Let's add a bit more to make it realistic. The quick brown fox jumps over the lazy dog.`;

		const row = {
			id: generateId(0),
			title: 'Meeting Notes - Q4 Planning',
			content: sampleContent,
			tags: ['work', 'meetings', 'planning'],
			createdAt: Date.now(),
			updatedAt: Date.now(),
		};

		const jsonPayload = JSON.stringify(row);
		console.log('\n=== REALISTIC ROW ANALYSIS ===');
		console.log(`Content length: ${sampleContent.length} chars`);
		console.log(`Full row JSON: ${jsonPayload.length} bytes`);

		for (let i = 0; i < 1_000; i++) {
			tables.notes.set({
				id: generateId(i),
				title: `Note ${i}`,
				content: sampleContent,
				tags: ['tag1', 'tag2'],
				createdAt: Date.now(),
				updatedAt: Date.now(),
				_v: 1,
			});
		}

		const encoded = Y.encodeStateAsUpdate(ydoc);
		console.log(`\nWith 1,000 notes (~500 chars each):`);
		console.log(
			`  Y.Doc binary: ${(encoded.byteLength / 1024).toFixed(0)} KB (${(encoded.byteLength / 1024 / 1024).toFixed(2)} MB)`,
		);
		console.log(`  Per row: ${(encoded.byteLength / 1_000).toFixed(0)} bytes`);
	});

	test('actual ceiling measurements at 1K / 10K / 50K rows', () => {
		console.log('\n=== PRACTICAL LIMITS (measured) ===');
		console.log('| Rows     | Small Posts  | Notes (~500 chars) | Insert Time  |');
		console.log('|----------|--------------|--------------------| -------------|');

		const sampleContent = 'x'.repeat(400);

		for (const count of [1_000, 10_000, 50_000]) {
			// Small rows
			const smallDoc = new Y.Doc();
			const smallTables = createTables(smallDoc, { posts: postDefinition });
			const smallStart = performance.now();
			for (let i = 0; i < count; i++) {
				smallTables.posts.set({
					id: generateId(i),
					title: `Post ${i}`,
					views: i,
					_v: 1,
				});
			}
			const smallMs = performance.now() - smallStart;
			const smallSize = Y.encodeStateAsUpdate(smallDoc).byteLength;

			// Notes with content
			const noteDoc = new Y.Doc();
			const noteTables = createTables(noteDoc, { notes: noteDefinition });
			for (let i = 0; i < count; i++) {
				noteTables.notes.set({
					id: generateId(i),
					title: `Note ${i}`,
					content: sampleContent,
					tags: ['tag1', 'tag2'],
					createdAt: Date.now(),
					updatedAt: Date.now(),
					_v: 1,
				});
			}
			const noteSize = Y.encodeStateAsUpdate(noteDoc).byteLength;

			console.log(
				`| ${String(count).padStart(8)} | ${formatBytes(smallSize).padEnd(12)} | ${formatBytes(noteSize).padEnd(18)} | ${smallMs.toFixed(0).padStart(8)}ms    |`,
			);
		}
	}, 120_000);  // 50K rows takes a while
});

// ═══════════════════════════════════════════════════════════════════════════════
// Update Growth
// ═══════════════════════════════════════════════════════════════════════════════

describe('update growth', () => {

	test('Y.Doc size growth after updates (same rows updated 5 times)', () => {
		const ydoc = new Y.Doc();
		const tables = createTables(ydoc, { posts: postDefinition });

		for (let i = 0; i < 1_000; i++) {
			tables.posts.set({
				id: generateId(i),
				title: `Post ${i}`,
				views: 0,
				_v: 1,
			});
		}
		const initialSize = Y.encodeStateAsUpdate(ydoc).byteLength;

		for (let update = 1; update <= 5; update++) {
			for (let i = 0; i < 1_000; i++) {
				tables.posts.set({
					id: generateId(i),
					title: `Post ${i} v${update}`,
					views: update,
					_v: 1,
				});
			}
		}
		const finalSize = Y.encodeStateAsUpdate(ydoc).byteLength;

		console.log(
			`Initial size (1,000 rows): ${(initialSize / 1024).toFixed(2)} KB`,
		);
		console.log(
			`Final size (after 5 updates each): ${(finalSize / 1024).toFixed(2)} KB`,
		);
		console.log(`Growth factor: ${(finalSize / initialSize).toFixed(2)}x`);
	});
});

// ═══════════════════════════════════════════════════════════════════════════════
// Heavy Text: Baseline Sizes
// ═══════════════════════════════════════════════════════════════════════════════

describe('heavy text baseline sizes', () => {
	for (const contentChars of [10_000, 50_000, 100_000]) {
		test(`5 rows with ${formatBytes(contentChars)} chars each`, () => {
			const ydoc = new Y.Doc();
			const tables = createTables(ydoc, { notes: heavyNoteDefinition });

			const rows = Array.from({ length: 5 }, (_, i) =>
				makeHeavyRow(`doc-${i}`, contentChars),
			);
			for (const row of rows) tables.notes.set(row);

			const encoded = Y.encodeStateAsUpdate(ydoc);
			const jsonSize = rows.reduce((s, r) => s + JSON.stringify(r).length, 0);

			const label = formatBytes(contentChars).toUpperCase();
			console.log(`\n=== 5 ROWS × ${label} CHARS EACH ===`);
			console.log(`  Pure JSON size:    ${formatBytes(jsonSize)}`);
			console.log(`  Y.Doc binary size: ${formatBytes(encoded.byteLength)}`);
			console.log(
				`  CRDT overhead:     ${((encoded.byteLength / jsonSize - 1) * 100).toFixed(1)}%`,
			);
			console.log(`  Per row:           ${formatBytes(encoded.byteLength / 5)}`);
		});
	}

	test('raw text size scaling: how content size dominates', () => {
		console.log('\n=== TEXT SIZE SCALING (single row) ===');
		console.log('| Content Size | JSON     | Y.Doc    | Overhead |');
		console.log('|-------------|----------|----------|----------|');

		for (const chars of [1_000, 5_000, 10_000, 50_000, 100_000, 500_000]) {
			const ydoc = new Y.Doc();
			const tables = createTables(ydoc, { notes: heavyNoteDefinition });

			const row = makeHeavyRow('doc-0', chars);
			tables.notes.set(row);

			const encoded = Y.encodeStateAsUpdate(ydoc).byteLength;
			const jsonSize = JSON.stringify(row).length;
			const overhead = ((encoded / jsonSize - 1) * 100).toFixed(1);

			console.log(
				`| ${formatBytes(chars).padEnd(11)} | ${formatBytes(jsonSize).padEnd(8)} | ${formatBytes(encoded).padEnd(8)} | ${overhead.padStart(5)}%   |`,
			);
		}
	});
});
