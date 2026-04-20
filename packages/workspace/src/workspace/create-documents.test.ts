/**
 * createDocuments Tests
 *
 * Validates documents lifecycle, content read/write behavior, and integration with table row metadata.
 * The suite protects contracts around open/close idempotency, direct content access, cleanup semantics, and hook orchestration.
 *
 * Key behaviors:
 * - Document operations keep row metadata in sync and honor documents origins.
 * - Lifecycle methods (`close`, `closeAll`) safely clean up open documents.
 */

import { describe, expect, test } from 'bun:test';
import { type } from 'arktype';
import * as Y from 'yjs';
import {
	type CreateDocumentsConfig,
	createDocuments,
	DOCUMENTS_ORIGIN,
} from './create-documents.js';
import { createTables } from './create-tables.js';
import { defineTable } from './define-table.js';
import { timeline } from './strategies.js';

const fileSchema = type({
	id: 'string',
	name: 'string',
	updatedAt: 'number',
	_v: '1',
});

function setupTables() {
	const ydoc = new Y.Doc({ guid: 'test-workspace' });
	const tables = createTables(ydoc, { files: defineTable(fileSchema) });
	return { ydoc, tables };
}

function setup(
	overrides?: Pick<
		CreateDocumentsConfig<typeof fileSchema.infer>,
		'documentExtensions'
	>,
) {
	const { ydoc, tables } = setupTables();
	const documents = createDocuments({
		id: 'test-workspace',
		tableName: 'files',
		documentName: 'content',
		guidKey: 'id',
		content: timeline,
		onUpdate: () => ({ updatedAt: Date.now() }),
		tableHelper: tables.files,
		ydoc,
		...overrides,
	});
	return { ydoc, tables, documents };
}

describe('createDocuments', () => {
	describe('open', () => {
		test('document extension factory receives tableName and documentName in context', async () => {
			let receivedTableName: string | undefined;
			let receivedDocumentName: string | undefined;
			const { documents } = setup({
				documentExtensions: [
					{
						key: 'test',
						factory: (ctx) => {
							receivedTableName = ctx.tableName;
							receivedDocumentName = ctx.documentName;
						},
					},
				],
			});
			await documents.open('f1');
			expect(receivedTableName).toBe('files');
			expect(receivedDocumentName).toBe('content');
		});

		test('is idempotent — same GUID returns the same content instance', async () => {
			const { documents } = setup();

			const content1 = await documents.open('f1');
			const content2 = await documents.open('f1');
			expect(content1).toBe(content2);
		});

		test('open accepts a row object and returns content', async () => {
			const { tables, documents } = setup();
			const row = {
				id: 'f1',
				name: 'test.txt',
				updatedAt: 0,
				_v: 1,
			} as const;
			tables.files.set(row);

			const content = await documents.open(row);
			content.write('hello from row');
			expect(content.read()).toBe('hello from row');
		});

		test('open accepts a string guid directly and returns content', async () => {
			const { documents } = setup();

			const content = await documents.open('f1');
			content.write('hello from guid');
			expect(content.read()).toBe('hello from guid');
		});
	});

	describe('document content read and write', () => {
		test('read returns empty string for new doc', async () => {
			const { documents } = setup();

			const content = await documents.open('f1');
			const text = content.read();
			expect(text).toBe('');
		});

		test('write replaces text content, then read returns it', async () => {
			const { documents } = setup();

			const content = await documents.open('f1');
			content.write('hello world');
			const text = content.read();
			expect(text).toBe('hello world');
		});

		test('write replaces existing content', async () => {
			const { documents } = setup();

			const content = await documents.open('f1');
			content.write('first');
			content.write('second');
			const text = content.read();
			expect(text).toBe('second');
		});
	});

	describe('onUpdate callback', () => {
		test('content doc change invokes onUpdate and writes returned fields', async () => {
			const { tables, documents } = setup();
			tables.files.set({
				id: 'f1',
				name: 'test.txt',
				updatedAt: 0,
				_v: 1,
			});

			const content = await documents.open('f1');
			content.write('hello');

			// Give the update observer a tick
			const result = tables.files.get('f1');
			expect(result.status).toBe('valid');
			if (result.status === 'valid') {
				expect(result.row.updatedAt).toBeGreaterThan(0);
			}
		});

		test('onUpdate callback return values are written to the row', async () => {
			const customSchema = type({
				id: 'string',
				name: 'string',
				updatedAt: 'number',
				lastEditedBy: 'string',
				_v: '1',
			});
			const ydoc = new Y.Doc({ guid: 'test-custom-onUpdate' });
			const tables = createTables(ydoc, {
				files: defineTable(customSchema),
			});

			const documents = createDocuments({
				id: 'test-custom-onUpdate',
				tableName: 'files',
				documentName: 'content',
				guidKey: 'id',
				content: timeline,
				onUpdate: () => ({
					updatedAt: 999,
					lastEditedBy: 'test-user',
				}),
				tableHelper: tables.files,
				ydoc,
			});

			tables.files.set({
				id: 'f1',
				name: 'test.txt',
				updatedAt: 0,
				lastEditedBy: '',
				_v: 1,
			});

			const content = await documents.open('f1');
			content.write('hello');

			const result = tables.files.get('f1');
			expect(result.status).toBe('valid');
			if (result.status === 'valid') {
				expect(result.row.updatedAt).toBe(999);
				expect(result.row.lastEditedBy).toBe('test-user');
			}
		});

		test('onUpdate returning empty object is a no-op', async () => {
			const ydoc = new Y.Doc({ guid: 'test-noop-onUpdate' });
			const tables = createTables(ydoc, {
				files: defineTable(fileSchema),
			});

			const documents = createDocuments({
				id: 'test-noop-onUpdate',
				tableName: 'files',
				documentName: 'content',
				guidKey: 'id',
				content: timeline,
				onUpdate: () => ({}),
				tableHelper: tables.files,
				ydoc,
			});

			tables.files.set({
				id: 'f1',
				name: 'test.txt',
				updatedAt: 0,
				_v: 1,
			});

			const content = await documents.open('f1');
			content.write('hello');

			const result = tables.files.get('f1');
			expect(result.status).toBe('valid');
			if (result.status === 'valid') {
				expect(result.row.updatedAt).toBe(0); // unchanged
			}
		});

		test('onUpdate bump uses DOCUMENTS_ORIGIN', async () => {
			const { tables, documents } = setup();
			tables.files.set({
				id: 'f1',
				name: 'test.txt',
				updatedAt: 0,
				_v: 1,
			});

			let capturedOrigin: unknown = null;
			tables.files.observe((_changedIds, origin) => {
				capturedOrigin = origin;
			});

			const content = await documents.open('f1');
			content.write('hello');

			expect(capturedOrigin).toBe(DOCUMENTS_ORIGIN);
		});

		test('non-transport remote update invokes onUpdate', async () => {
			const { tables, documents } = setup();
			tables.files.set({
				id: 'f1',
				name: 'test.txt',
				updatedAt: 0,
				_v: 1,
			});

			const content = await documents.open('f1');
			// Get the underlying Y.Doc via a shared type — Timeline no longer exposes ydoc directly.
			// asText() creates a timeline entry which triggers onUpdate, so reset updatedAt after.
			const contentYdoc = content.asText().doc!;
			tables.files.update('f1', { updatedAt: 0 });

			// Apply a remote update with no origin (e.g., IndexedDB load)
			const remoteDoc = new Y.Doc({ guid: 'f1', gc: false });
			remoteDoc.getText('content').insert(0, 'remote edit');
			const remoteUpdate = Y.encodeStateAsUpdate(remoteDoc);

			Y.applyUpdate(contentYdoc, remoteUpdate);

			const result = tables.files.get('f1');
			expect(result.status).toBe('valid');
			if (result.status === 'valid') {
				expect(result.row.updatedAt).not.toBe(0);
			}

			remoteDoc.destroy();
		});

		test('transport-originated update does NOT invoke onUpdate', async () => {
			const { tables, documents } = setup();
			tables.files.set({
				id: 'f1',
				name: 'test.txt',
				updatedAt: 0,
				_v: 1,
			});

			const content = await documents.open('f1');
			// Get the underlying Y.Doc via a shared type — Timeline no longer exposes ydoc directly.
			// asText() creates a timeline entry which triggers onUpdate, so reset updatedAt after.
			const contentYdoc = content.asText().doc!;
			tables.files.update('f1', { updatedAt: 0 });

			// Apply a remote update with a Symbol origin (simulating sync/broadcast)
			const FAKE_TRANSPORT = Symbol('fake-transport');
			const remoteDoc = new Y.Doc({ guid: 'f1', gc: false });
			remoteDoc.getText('content').insert(0, 'synced edit');
			const remoteUpdate = Y.encodeStateAsUpdate(remoteDoc);

			Y.applyUpdate(contentYdoc, remoteUpdate, FAKE_TRANSPORT);

			const result = tables.files.get('f1');
			expect(result.status).toBe('valid');
			if (result.status === 'valid') {
				// Transport-originated updates skip onUpdate — the originating
				// tab already bumped metadata via workspace sync.
				expect(result.row.updatedAt).toBe(0);
			}

			remoteDoc.destroy();
		});
	});
	describe('close', () => {
		test('frees memory — doc can be re-opened as new instance', async () => {
			const { documents } = setup();

			const content1 = await documents.open('f1');
			await documents.close('f1');

			const content2 = await documents.open('f1');
			expect(content2).not.toBe(content1);
		});

		test('close on non-existent guid is a no-op', async () => {
			const { documents } = setup();

			// Should not throw
			await documents.close('nonexistent');
		});
	});

	describe('closeAll', () => {
		test('closes all open documents', async () => {
			const { documents } = setup();

			const content1 = await documents.open('f1');
			const content2 = await documents.open('f2');

			await documents.closeAll();

			// Re-opening should create new content instances
			const content1b = await documents.open('f1');
			const content2b = await documents.open('f2');
			expect(content1b).not.toBe(content1);
			expect(content2b).not.toBe(content2);
		});
	});

	describe('row deletion', () => {
		test('deleting a row closes its open document', async () => {
			const { tables, documents } = setup();
			tables.files.set({
				id: 'f1',
				name: 'test.txt',
				updatedAt: 0,
				_v: 1,
			});

			const content1 = await documents.open('f1');
			tables.files.delete('f1');

			// After deletion, re-opening should create new content
			const content2 = await documents.open('f1');
			expect(content2).not.toBe(content1);
		});
	});
	describe('document extension hooks', () => {
		test('hooks are called in order', async () => {
			const order: number[] = [];

			const { documents } = setup({
				documentExtensions: [
					{
						key: 'first',
						factory: () => {
							order.push(1);
							return { dispose: () => {} };
						},
					},
					{
						key: 'second',
						factory: () => {
							order.push(2);
							return { dispose: () => {} };
						},
					},
					{
						key: 'third',
						factory: () => {
							order.push(3);
							return { dispose: () => {} };
						},
					},
				],
			});

			await documents.open('f1');
			expect(order).toEqual([1, 2, 3]);
		});

		test('second hook receives whenReady from first', async () => {
			let secondReceivedWhenReady = false;

			const { documents } = setup({
				documentExtensions: [
					{
						key: 'first',
						factory: () => ({
							whenReady: Promise.resolve(),
							dispose: () => {},
						}),
					},
					{
						key: 'second',
						factory: ({ whenReady }) => {
							secondReceivedWhenReady = whenReady instanceof Promise;
							return { dispose: () => {} };
						},
					},
				],
			});

			await documents.open('f1');
			expect(secondReceivedWhenReady).toBe(true);
		});

		test('hook returning void is skipped', async () => {
			let hooksCalled = 0;

			const { documents } = setup({
				documentExtensions: [
					{
						key: 'void-hook',
						factory: () => {
							hooksCalled++;
							return undefined; // void return
						},
					},
					{
						key: 'normal-hook',
						factory: () => {
							hooksCalled++;
							return { dispose: () => {} };
						},
					},
				],
			});

			await documents.open('f1');
			expect(hooksCalled).toBe(2);
		});

		test('no hooks → bare content opens with instant resolution', async () => {
			const { documents } = setup({ documentExtensions: [] });

			const content = await documents.open('f1');
			expect(content.read()).toBe('');
		});
	});

	describe('document extension whenReady and typed extensions', () => {
		test('document extension receives extensions map with flat exports', async () => {
			let capturedFirstExtension: unknown;

			const { documents } = setup({
				documentExtensions: [
					{
						key: 'first',
						factory: () => ({
							someValue: 42,
							dispose: () => {},
						}),
					},
					{
						key: 'second',
						factory: (context) => {
							capturedFirstExtension = context.extensions.first;
							return { dispose: () => {} };
						},
					},
				],
			});

			await documents.open('f1');
			expect(capturedFirstExtension).toBeDefined();
			expect(
				(capturedFirstExtension as Record<string, unknown>).someValue,
			).toBe(42);
		});

		test('document extension with no exports is still accessible', async () => {
			let firstExtensionSeen = false;

			const { documents } = setup({
				documentExtensions: [
					{
						key: 'first',
						factory: () => ({
							dispose: () => {},
						}),
					},
					{
						key: 'second',
						factory: (context) => {
							firstExtensionSeen = context.extensions.first !== undefined;
							return { dispose: () => {} };
						},
					},
				],
			});

			await documents.open('f1');
			expect(firstExtensionSeen).toBe(true);
		});
	});
});

// ════════════════════════════════════════════════════════════════════════════
// as*() conversion methods
// ════════════════════════════════════════════════════════════════════════════

describe('content.asText / asRichText / asSheet', () => {
	function setupSimple() {
		const ydoc = new Y.Doc({ guid: 'workspace' });
		const tableDef = defineTable(
			type({ id: 'string', name: 'string', updatedAt: 'number', _v: '1' }),
		);
		const tables = createTables(ydoc, { files: tableDef });
		const documents = createDocuments({
			id: 'test-timeline',
			tableName: 'files',
			documentName: 'content',
			guidKey: 'id',
			content: timeline,
			onUpdate: () => ({ updatedAt: Date.now() }),
			tableHelper: tables.files,
			ydoc,
		});
		tables.files.set({ id: 'f1', name: 'test', updatedAt: 0, _v: 1 });
		return { documents, tables };
	}

	// ─── asText ────────────────────────────────────────────────────────

	test('asText on empty timeline auto-creates text entry', async () => {
		const { documents } = setupSimple();
		const content = await documents.open('f1');

		const text = content.asText();
		expect(text).toBeInstanceOf(Y.Text);
		expect(content.currentType).toBe('text');
	});

	test('asText on text entry returns existing Y.Text', async () => {
		const { documents } = setupSimple();
		const content = await documents.open('f1');
		content.write('hello');

		const text = content.asText();
		expect(text.toString()).toBe('hello');
		expect(content.length).toBe(1);
	});

	test('asText on richtext entry converts (lossy)', async () => {
		const { documents } = setupSimple();
		const content = await documents.open('f1');

		const fragment = content.asRichText();
		const p = new Y.XmlElement('paragraph');
		const t = new Y.XmlText();
		t.insert(0, 'Rich content');
		p.insert(0, [t]);
		fragment.insert(0, [p]);

		expect(content.currentType).toBe('richtext');

		const text = content.asText();
		expect(text.toString()).toBe('Rich content');
		expect(content.currentType).toBe('text');
		expect(content.length).toBe(2);
	});

	test('asText on sheet entry converts to CSV', async () => {
		const { documents } = setupSimple();
		const content = await documents.open('f1');

		content.write('Name,Age\nAlice,30\n');
		content.asSheet();
		expect(content.currentType).toBe('sheet');

		const text = content.asText();
		expect(text.toString()).toBe('Name,Age\nAlice,30\n');
		expect(content.currentType).toBe('text');
		expect(content.length).toBe(3);
	});

	// ─── asRichText ────────────────────────────────────────────────────

	test('asRichText on empty timeline auto-creates richtext entry', async () => {
		const { documents } = setupSimple();
		const content = await documents.open('f1');

		const fragment = content.asRichText();
		expect(fragment).toBeInstanceOf(Y.XmlFragment);
		expect(content.currentType).toBe('richtext');
	});

	test('asRichText on richtext entry returns existing fragment', async () => {
		const { documents } = setupSimple();
		const content = await documents.open('f1');
		content.asRichText();

		const fragment = content.asRichText();
		expect(fragment).toBeInstanceOf(Y.XmlFragment);
		expect(content.length).toBe(1);
	});

	test('asRichText on text entry converts to paragraphs', async () => {
		const { documents } = setupSimple();
		const content = await documents.open('f1');
		content.write('Line 1\nLine 2');

		const fragment = content.asRichText();
		expect(fragment).toBeInstanceOf(Y.XmlFragment);
		expect(content.currentType).toBe('richtext');
		expect(content.length).toBe(2);
		expect(content.read()).toBe('Line 1\nLine 2');
	});

	test('asRichText on sheet entry converts CSV to paragraphs', async () => {
		const { documents } = setupSimple();
		const content = await documents.open('f1');
		content.write('A,B\n1,2\n');
		content.asSheet();

		const fragment = content.asRichText();
		expect(fragment).toBeInstanceOf(Y.XmlFragment);
		expect(content.currentType).toBe('richtext');
		expect(content.length).toBe(3);
	});

	// ─── asSheet ──────────────────────────────────────────────────────

	test('asSheet on empty timeline auto-creates sheet entry', async () => {
		const { documents } = setupSimple();
		const content = await documents.open('f1');

		const sheet = content.asSheet();
		expect(sheet.columns).toBeInstanceOf(Y.Map);
		expect(sheet.rows).toBeInstanceOf(Y.Map);
		expect(content.currentType).toBe('sheet');
	});

	test('asSheet on sheet entry returns existing binding', async () => {
		const { documents } = setupSimple();
		const content = await documents.open('f1');
		content.write('X,Y\n1,2\n');
		content.asSheet();

		const sheet = content.asSheet();
		expect(sheet.columns.size).toBe(2);
		expect(sheet.rows.size).toBe(1);
		expect(content.length).toBe(2);
	});

	test('asSheet on text entry parses as CSV', async () => {
		const { documents } = setupSimple();
		const content = await documents.open('f1');
		content.write('Col1,Col2\nA,B\n');

		const sheet = content.asSheet();
		expect(sheet.columns.size).toBe(2);
		expect(sheet.rows.size).toBe(1);
		expect(content.currentType).toBe('sheet');
		expect(content.length).toBe(2);
	});

	test('asSheet on richtext entry extracts text then parses CSV', async () => {
		const { documents } = setupSimple();
		const content = await documents.open('f1');

		const fragment = content.asRichText();
		const p1 = new Y.XmlElement('paragraph');
		const t1 = new Y.XmlText();
		t1.insert(0, 'Name,Age');
		p1.insert(0, [t1]);
		const p2 = new Y.XmlElement('paragraph');
		const t2 = new Y.XmlText();
		t2.insert(0, 'Alice,30');
		p2.insert(0, [t2]);
		fragment.insert(0, [p1, p2]);

		const sheet = content.asSheet();
		expect(sheet.columns.size).toBe(2);
		expect(content.currentType).toBe('sheet');
		expect(content.length).toBe(2);
	});

	// ─── mode getter ──────────────────────────────────────────────────

	test('mode reflects current timeline state', async () => {
		const { documents } = setupSimple();
		const content = await documents.open('f1');

		expect(content.currentType).toBeUndefined(); // empty
		content.write('text');
		expect(content.currentType).toBe('text');
	});

	// ─── consecutive conversions ──────────────────────────────────────

	test('consecutive conversions: text → richtext → sheet → text', async () => {
		const { documents } = setupSimple();
		const content = await documents.open('f1');

		content.write('hello');
		expect(content.currentType).toBe('text');
		expect(content.length).toBe(1);

		content.asRichText();
		expect(content.currentType).toBe('richtext');
		expect(content.length).toBe(2);

		content.asSheet();
		expect(content.currentType).toBe('sheet');
		expect(content.length).toBe(3);

		content.asText();
		expect(content.currentType).toBe('text');
		expect(content.length).toBe(4);
	});
});
