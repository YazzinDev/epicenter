/**
 * Markdown Materializer Bidirectional Sync Tests
 *
 * Tests the `pushFromMarkdown` and `pullToMarkdown` methods on
 * `createMarkdownMaterializer`. Uses real temp directories and Yjs
 * workspaces so the materializer exercises actual table set/get and
 * filesystem paths.
 *
 * Key behaviors:
 * - pushFromMarkdown reads `.md` files, parses frontmatter, and calls table.set()
 * - pushFromMarkdown skips non-`.md` files and files without valid frontmatter
 * - pushFromMarkdown reports errors for unreadable files
 * - pushFromMarkdown uses custom deserialize callback when provided
 * - pushFromMarkdown silently skips tables whose directories don't exist
 * - pullToMarkdown re-serializes all valid rows to disk
 * - pullToMarkdown uses custom serialize callback when provided
 * - Round-trip: pullToMarkdown → pushFromMarkdown preserves data
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type } from 'arktype';
import { createWorkspace, defineTable } from '../../../workspace/index.js';
import { createMarkdownMaterializer } from './materializer.js';
import { parseMarkdownFile } from './parse-markdown-file.js';

// ============================================================================
// Test Table Definitions
// ============================================================================

const postsTable = defineTable(
	type({ id: 'string', title: 'string', published: 'boolean', _v: '1' }),
);

const notesTable = defineTable(type({ id: 'string', body: 'string', _v: '1' }));

// ============================================================================
// Test Directory Setup
// ============================================================================

const TEST_DIR = join(import.meta.dir, '__test-materializer__');

beforeEach(async () => {
	await mkdir(TEST_DIR, { recursive: true });
});

afterEach(async () => {
	await rm(TEST_DIR, { recursive: true, force: true });
});

// ============================================================================
// Helpers
// ============================================================================

async function writeTestFile(relativePath: string, content: string) {
	const fullPath = join(TEST_DIR, relativePath);
	await mkdir(join(fullPath, '..'), { recursive: true });
	await writeFile(fullPath, content, 'utf-8');
}

async function readTestFile(relativePath: string) {
	return readFile(join(TEST_DIR, relativePath), 'utf-8');
}

async function listTestDir(relativePath: string) {
	return readdir(join(TEST_DIR, relativePath));
}

function setup(options?: {
	tables?: Array<{
		name: string;
		config?: Parameters<
			ReturnType<typeof createMarkdownMaterializer>['table']
		>[1];
	}>;
}) {
	const workspace = createWorkspace({
		id: 'test.materializer',
		tables: { posts: postsTable, notes: notesTable },
	}).withWorkspaceExtension('materializer', (ctx) => {
		const materializer = createMarkdownMaterializer(ctx, {
			dir: TEST_DIR,
		});

		const tablesToRegister = options?.tables ?? [
			{ name: 'posts' },
			{ name: 'notes' },
		];
		for (const { name, config } of tablesToRegister) {
			materializer.table(name, config);
		}

		return materializer;
	});

	return { workspace };
}

// ============================================================================
// pushFromMarkdown Tests
// ============================================================================

describe('pushFromMarkdown', () => {
	test('imports markdown files into workspace tables', async () => {
		const { workspace } = setup({ tables: [{ name: 'posts' }] });
		await workspace.whenReady;

		await writeTestFile(
			'posts/hello.md',
			'---\nid: post-1\ntitle: Hello World\npublished: true\n_v: 1\n---\n',
		);
		await writeTestFile(
			'posts/draft.md',
			'---\nid: post-2\ntitle: Draft Post\npublished: false\n_v: 1\n---\n',
		);

		const result = await workspace.extensions.materializer.pushFromMarkdown();

		expect(result.imported).toBe(2);
		expect(result.skipped).toBe(0);
		expect(result.errors).toEqual([]);

		const post1 = workspace.tables.posts.get('post-1');
		expect(post1.status).toBe('valid');
		if (post1.status === 'valid') {
			expect(post1.row.title).toBe('Hello World');
			expect(post1.row.published).toBe(true);
		}

		const post2 = workspace.tables.posts.get('post-2');
		expect(post2.status).toBe('valid');
		if (post2.status === 'valid') {
			expect(post2.row.title).toBe('Draft Post');
		}
	});

	test('skips non-.md files', async () => {
		const { workspace } = setup({ tables: [{ name: 'posts' }] });
		await workspace.whenReady;

		await writeTestFile(
			'posts/valid.md',
			'---\nid: p1\ntitle: Valid\npublished: false\n_v: 1\n---\n',
		);
		await writeTestFile('posts/readme.txt', 'not a markdown file');
		await writeTestFile('posts/data.json', '{"id": "test"}');

		const result = await workspace.extensions.materializer.pushFromMarkdown();

		expect(result.imported).toBe(1);
		expect(result.skipped).toBe(0);
	});

	test('skips files without valid frontmatter', async () => {
		const { workspace } = setup({ tables: [{ name: 'posts' }] });
		await workspace.whenReady;

		await writeTestFile(
			'posts/valid.md',
			'---\nid: p1\ntitle: Valid\npublished: false\n_v: 1\n---\n',
		);
		await writeTestFile(
			'posts/no-frontmatter.md',
			'# Just a heading\n\nSome content\n',
		);

		const result = await workspace.extensions.materializer.pushFromMarkdown();

		expect(result.imported).toBe(1);
		expect(result.skipped).toBe(1);
	});

	test('silently skips tables whose directories do not exist', async () => {
		const { workspace } = setup({ tables: [{ name: 'posts' }] });
		await workspace.whenReady;

		// Don't create the posts directory — it should not exist
		const result = await workspace.extensions.materializer.pushFromMarkdown();

		expect(result.imported).toBe(0);
		expect(result.skipped).toBe(0);
		expect(result.errors).toEqual([]);
	});

	test('uses custom deserialize callback', async () => {
		const { workspace } = setup({
			tables: [
				{
					name: 'notes',
					config: {
						deserialize: (parsed) => ({
							id: parsed.frontmatter.id as string,
							body: parsed.body ?? '',
							_v: 1 as const,
						}),
					},
				},
			],
		});
		await workspace.whenReady;

		await writeTestFile(
			'notes/my-note.md',
			'---\nid: note-1\n---\n\nThis is the body content\n',
		);

		const result = await workspace.extensions.materializer.pushFromMarkdown();

		expect(result.imported).toBe(1);

		const note = workspace.tables.notes.get('note-1');
		expect(note.status).toBe('valid');
		if (note.status === 'valid') {
			expect(note.row.body).toBe('This is the body content');
		}
	});

	test('uses custom table directory', async () => {
		const { workspace } = setup({
			tables: [{ name: 'posts', config: { dir: 'blog' } }],
		});
		await workspace.whenReady;

		await writeTestFile(
			'blog/hello.md',
			'---\nid: p1\ntitle: Hello\npublished: false\n_v: 1\n---\n',
		);

		const result = await workspace.extensions.materializer.pushFromMarkdown();

		expect(result.imported).toBe(1);
		expect(workspace.tables.posts.has('p1')).toBe(true);
	});

	test('overwrites existing rows (set is insert-or-replace)', async () => {
		const { workspace } = setup({ tables: [{ name: 'posts' }] });
		await workspace.whenReady;

		// First import
		await writeTestFile(
			'posts/p1.md',
			'---\nid: p1\ntitle: Original\npublished: false\n_v: 1\n---\n',
		);

		const first = await workspace.extensions.materializer.pushFromMarkdown();
		expect(first.imported).toBe(1);

		const originalPost = workspace.tables.posts.get('p1');
		expect(originalPost.status).toBe('valid');
		if (originalPost.status === 'valid') {
			expect(originalPost.row.title).toBe('Original');
		}

		// Flush observer microtasks (observer writes files on table.set() from the first push)
		await Bun.sleep(0);

		// Second import: overwrite the same file with different data
		await writeTestFile(
			'posts/p1.md',
			'---\nid: p1\ntitle: Updated From Disk\npublished: true\n_v: 1\n---\n',
		);

		const second = await workspace.extensions.materializer.pushFromMarkdown();
		expect(second.imported).toBe(1);

		const updatedPost = workspace.tables.posts.get('p1');
		expect(updatedPost.status).toBe('valid');
		if (updatedPost.status === 'valid') {
			expect(updatedPost.row.title).toBe('Updated From Disk');
			expect(updatedPost.row.published).toBe(true);
		}
	});

	test('imports across multiple tables', async () => {
		const { workspace } = setup();
		await workspace.whenReady;

		await writeTestFile(
			'posts/post.md',
			'---\nid: p1\ntitle: Post\npublished: false\n_v: 1\n---\n',
		);
		await writeTestFile(
			'notes/note.md',
			'---\nid: n1\nbody: Note body\n_v: 1\n---\n',
		);

		const result = await workspace.extensions.materializer.pushFromMarkdown();

		expect(result.imported).toBe(2);
		expect(workspace.tables.posts.has('p1')).toBe(true);
		expect(workspace.tables.notes.has('n1')).toBe(true);
	});
});

// ============================================================================
// pullToMarkdown Tests
// ============================================================================

describe('pullToMarkdown', () => {
	test('writes all valid rows to disk', async () => {
		const { workspace } = setup({ tables: [{ name: 'posts' }] });
		await workspace.whenReady;

		workspace.tables.posts.set({
			id: 'p1',
			title: 'First',
			published: true,
			_v: 1,
		});
		workspace.tables.posts.set({
			id: 'p2',
			title: 'Second',
			published: false,
			_v: 1,
		});

		const result = await workspace.extensions.materializer.pullToMarkdown();

		expect(result.written).toBe(2);

		// Verify files were written with correct content
		const content1 = await readTestFile('posts/p1.md');
		expect(content1).toContain('title: First');

		const content2 = await readTestFile('posts/p2.md');
		expect(content2).toContain('title: Second');
	});

	test('creates table directory before writing', async () => {
		const { workspace } = setup({ tables: [{ name: 'posts' }] });
		await workspace.whenReady;

		workspace.tables.posts.set({
			id: 'p1',
			title: 'First',
			published: false,
			_v: 1,
		});

		await workspace.extensions.materializer.pullToMarkdown();

		const entries = await listTestDir('posts');
		expect(entries).toContain('p1.md');
	});

	test('uses custom serialize callback', async () => {
		const { workspace } = setup({
			tables: [
				{
					name: 'notes',
					config: {
						serialize: (row) => ({
							filename: `${row.id}-custom.md`,
							content: `---\nid: ${row.id}\n---\n\n${row.body}\n`,
						}),
					},
				},
			],
		});
		await workspace.whenReady;

		workspace.tables.notes.set({ id: 'n1', body: 'Custom body', _v: 1 });

		const result = await workspace.extensions.materializer.pullToMarkdown();

		expect(result.written).toBe(1);

		const content = await readTestFile('notes/n1-custom.md');
		expect(content).toContain('Custom body');
	});

	test('uses custom table directory', async () => {
		const { workspace } = setup({
			tables: [{ name: 'posts', config: { dir: 'blog' } }],
		});
		await workspace.whenReady;

		workspace.tables.posts.set({
			id: 'p1',
			title: 'Blog Post',
			published: false,
			_v: 1,
		});

		await workspace.extensions.materializer.pullToMarkdown();

		const entries = await listTestDir('blog');
		expect(entries).toContain('p1.md');
	});

	test('writes nothing when table is empty', async () => {
		const { workspace } = setup({ tables: [{ name: 'posts' }] });
		await workspace.whenReady;

		const result = await workspace.extensions.materializer.pullToMarkdown();

		expect(result.written).toBe(0);
	});

	test('writes across multiple tables', async () => {
		const { workspace } = setup();
		await workspace.whenReady;

		workspace.tables.posts.set({
			id: 'p1',
			title: 'Post',
			published: false,
			_v: 1,
		});
		workspace.tables.notes.set({ id: 'n1', body: 'Note', _v: 1 });

		const result = await workspace.extensions.materializer.pullToMarkdown();

		expect(result.written).toBe(2);

		const postsEntries = await listTestDir('posts');
		expect(postsEntries).toContain('p1.md');

		const notesEntries = await listTestDir('notes');
		expect(notesEntries).toContain('n1.md');
	});
});

// ============================================================================
// Round-Trip Tests
// ============================================================================

describe('round-trip', () => {
	test('pullToMarkdown then pushFromMarkdown on fresh workspace preserves row data', async () => {
		// First workspace: populate and pull to disk
		const workspace1 = createWorkspace({
			id: 'test.roundtrip.1',
			tables: { posts: postsTable, notes: notesTable },
		}).withWorkspaceExtension('materializer', (ctx) =>
			createMarkdownMaterializer(ctx, { dir: TEST_DIR }).table('posts'),
		);
		await workspace1.whenReady;

		workspace1.tables.posts.set({
			id: 'p1',
			title: 'Round Trip',
			published: true,
			_v: 1,
		});
		workspace1.tables.posts.set({
			id: 'p2',
			title: 'Another',
			published: false,
			_v: 1,
		});

		await workspace1.extensions.materializer.pullToMarkdown();
		workspace1.extensions.materializer.dispose();

		// Verify files on disk have valid frontmatter
		const p1Content = await readTestFile('posts/p1.md');
		const p1Parsed = parseMarkdownFile(p1Content);
		expect(p1Parsed).not.toBeNull();
		expect(p1Parsed!.frontmatter.title).toBe('Round Trip');

		// Second workspace: fresh instance, push from the same directory
		const workspace2 = createWorkspace({
			id: 'test.roundtrip.2',
			tables: { posts: postsTable, notes: notesTable },
		}).withWorkspaceExtension('materializer', (ctx) =>
			createMarkdownMaterializer(ctx, { dir: TEST_DIR }).table('posts'),
		);
		await workspace2.whenReady;

		const result = await workspace2.extensions.materializer.pushFromMarkdown();
		expect(result.imported).toBe(2);

		const p1 = workspace2.tables.posts.get('p1');
		expect(p1.status).toBe('valid');
		if (p1.status === 'valid') {
			expect(p1.row.title).toBe('Round Trip');
			expect(p1.row.published).toBe(true);
		}

		const p2 = workspace2.tables.posts.get('p2');
		expect(p2.status).toBe('valid');
		if (p2.status === 'valid') {
			expect(p2.row.title).toBe('Another');
			expect(p2.row.published).toBe(false);
		}
	});
});
