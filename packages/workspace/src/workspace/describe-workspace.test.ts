/**
 * describeWorkspace Tests
 *
 * Validates workspace descriptor generation for tables, kv, actions, and awareness schemas.
 * These tests ensure generated metadata is complete, serializable, and stable for introspection tooling.
 *
 * Key behaviors:
 * - Descriptor includes table/kv/action metadata with expected schema structure.
 * - Descriptor output remains JSON-serializable without circular references.
 */

import { describe, expect, test } from 'bun:test';
import { type } from 'arktype';
import Type from 'typebox';
import { defineMutation, defineQuery } from '../shared/actions.js';
import { createWorkspace } from './create-workspace.js';
import { defineKv } from './define-kv.js';
import { defineTable } from './define-table.js';
import { describeWorkspace } from './describe-workspace.js';

describe('describeWorkspace', () => {
	test('workspace with tables + kv + actions produces complete descriptor', () => {
		const posts = defineTable(type({ id: 'string', title: 'string', _v: '1' }));
		const settings = defineKv(
			type({ theme: "'light' | 'dark'", fontSize: 'number' }),
			{ theme: 'light', fontSize: 14 },
		);

		const client = createWorkspace({
			id: 'test-app',
			tables: { posts },
			kv: { settings },
		}).withActions((c) => ({
			posts: {
				getAll: defineQuery({
					description: 'Get all posts',
					handler: () => c.tables.posts.getAllValid(),
				}),
				create: defineMutation({
					description: 'Create a post',
					input: Type.Object({ title: Type.String() }),
					handler: ({ title }) => {
						c.tables.posts.set({ id: '1', title, _v: 1 });
					},
				}),
			},
		}));

		const descriptor = describeWorkspace(client);

		// ID
		expect(descriptor.id).toBe('test-app');

		// Tables
		expect(Object.keys(descriptor.tables)).toEqual(['posts']);
		expect(descriptor.tables.posts?.schema).toBeDefined();
		expect(descriptor.tables.posts?.schema).toHaveProperty('type', 'object');
		expect(descriptor.tables.posts?.schema).toHaveProperty('properties');

		// KV
		expect(Object.keys(descriptor.kv)).toEqual(['settings']);
		expect(descriptor.kv.settings?.schema).toBeDefined();
		expect(descriptor.kv.settings?.schema).toHaveProperty('type', 'object');

		// Actions
		expect(descriptor.actions).toHaveLength(2);

		const getAllAction = descriptor.actions.find(
			(a) => a.path.join('.') === 'posts.getAll',
		);
		expect(getAllAction).toBeDefined();
		expect(getAllAction?.type).toBe('query');
		expect(getAllAction?.description).toBe('Get all posts');
		expect(getAllAction?.input).toBeUndefined();

		const createAction = descriptor.actions.find(
			(a) => a.path.join('.') === 'posts.create',
		);
		expect(createAction).toBeDefined();
		expect(createAction?.type).toBe('mutation');
		expect(createAction?.description).toBe('Create a post');
		expect(createAction?.input).toBeDefined();
		expect(createAction?.input).toHaveProperty('type', 'object');
	});

	test('workspace without actions returns an empty actions array', () => {
		const posts = defineTable(type({ id: 'string', title: 'string', _v: '1' }));

		const client = createWorkspace({
			id: 'no-actions',
			tables: { posts },
		});

		const descriptor = describeWorkspace(client);

		expect(descriptor.id).toBe('no-actions');
		expect(descriptor.actions).toEqual([]);
		expect(Object.keys(descriptor.tables)).toEqual(['posts']);
	});

	test('multi-version table produces oneOf in JSON Schema', () => {
		const v1 = type({ id: 'string', title: 'string', _v: '1' });
		const v2 = type({
			id: 'string',
			title: 'string',
			views: 'number',
			_v: '2',
		});

		const posts = defineTable(v1, v2).migrate((row) => {
			if (row._v === 2) return row;
			return { ...row, views: 0, _v: 2 };
		});

		const client = createWorkspace({
			id: 'multi-version',
			tables: { posts },
		});

		const descriptor = describeWorkspace(client);

		expect(descriptor.tables.posts?.schema).toHaveProperty('oneOf');
		const oneOf = (descriptor.tables.posts?.schema as { oneOf: unknown[] })
			.oneOf;
		expect(oneOf).toHaveLength(2);
	});

	test('single-version table produces direct JSON Schema (no oneOf)', () => {
		const posts = defineTable(type({ id: 'string', title: 'string', _v: '1' }));

		const client = createWorkspace({
			id: 'single-version',
			tables: { posts },
		});

		const descriptor = describeWorkspace(client);

		// Single-version tables use the schema directly via arktype,
		// which produces a normal object schema (no oneOf wrapper)
		expect(descriptor.tables.posts?.schema).toHaveProperty('type', 'object');
		expect(descriptor.tables.posts?.schema).not.toHaveProperty('oneOf');
	});

	test('JSON.stringify(descriptor) succeeds (no circular refs)', () => {
		const posts = defineTable(type({ id: 'string', title: 'string', _v: '1' }));
		const settings = defineKv(type({ theme: "'light' | 'dark'" }), {
			theme: 'light',
		});

		const client = createWorkspace({
			id: 'stringify-test',
			tables: { posts },
			kv: { settings },
		}).withActions(() => ({
			getAll: defineQuery({
				handler: () => [],
			}),
		}));

		const descriptor = describeWorkspace(client);
		const json = JSON.stringify(descriptor);

		expect(json).toBeDefined();
		expect(typeof json).toBe('string');

		// Round-trip check
		const parsed = JSON.parse(json);
		expect(parsed.id).toBe('stringify-test');
		expect(parsed.tables.posts).toBeDefined();
		expect(parsed.kv.settings).toBeDefined();
		expect(parsed.actions).toHaveLength(1);
	});

	test('workspace without kv definitions returns an empty kv object', () => {
		const posts = defineTable(type({ id: 'string', title: 'string', _v: '1' }));

		const client = createWorkspace({
			id: 'no-kv',
			tables: { posts },
		});

		const descriptor = describeWorkspace(client);

		expect(descriptor.kv).toEqual({});
	});

	test('workspace without tables returns empty descriptor sections', () => {
		const client = createWorkspace({
			id: 'no-tables',
		});

		const descriptor = describeWorkspace(client);

		expect(descriptor.tables).toEqual({});
		expect(descriptor.kv).toEqual({});
		expect(descriptor.awareness).toEqual({});
		expect(descriptor.actions).toEqual([]);
	});

	test('awareness fields are included in descriptor', () => {
		const client = createWorkspace({
			id: 'with-awareness',
			awareness: {
				cursor: type({ x: 'number', y: 'number' }),
				selection: type({ start: 'number', end: 'number' }),
			},
		});

		const descriptor = describeWorkspace(client);

		expect(Object.keys(descriptor.awareness)).toEqual(['cursor', 'selection']);
		expect(descriptor.awareness.cursor?.schema).toHaveProperty(
			'type',
			'object',
		);
		expect(descriptor.awareness.selection?.schema).toHaveProperty(
			'type',
			'object',
		);
	});

	test('title appears in action descriptors', () => {
		const client = createWorkspace({
			id: 'metadata-test',
			tables: {
				posts: defineTable(type({ id: 'string', title: 'string', _v: '1' })),
			},
		}).withActions((c) => ({
			posts: {
				getAll: defineQuery({
					title: 'List Posts',
					description: 'Get all posts',
					handler: () => c.tables.posts.getAllValid(),
				}),
				delete: defineMutation({
					title: 'Delete Post',
					description: 'Delete a post by ID',
					input: Type.Object({ id: Type.String() }),
					handler: ({ id }) => {
						c.tables.posts.delete(id);
					},
				}),
				create: defineMutation({
					description: 'Create a post (no title)',
					handler: () => {},
				}),
			},
		}));

		const descriptor = describeWorkspace(client);

		const getAllAction = descriptor.actions.find(
			(a) => a.path.join('.') === 'posts.getAll',
		);
		expect(getAllAction?.title).toBe('List Posts');

		const deleteAction = descriptor.actions.find(
			(a) => a.path.join('.') === 'posts.delete',
		);
		expect(deleteAction?.title).toBe('Delete Post');

		const createAction = descriptor.actions.find(
			(a) => a.path.join('.') === 'posts.create',
		);
		expect(createAction?.title).toBeUndefined();
	});

	test('workspace without extensions returns empty extensions record', () => {
		const posts = defineTable(type({ id: 'string', title: 'string', _v: '1' }));

		const client = createWorkspace({
			id: 'no-extensions',
			tables: { posts },
		});

		const descriptor = describeWorkspace(client);

		expect(descriptor.extensions).toEqual({});
	});

	test('workspace extensions with defineQuery/defineMutation are discovered', () => {
		const posts = defineTable(type({ id: 'string', title: 'string', _v: '1' }));

		const client = createWorkspace({
			id: 'with-extensions',
			tables: { posts },
		}).withWorkspaceExtension('myExt', () => ({
			searchStuff: defineQuery({
				title: 'Search Stuff',
				description: 'Search for stuff',
				handler: () => [],
			}),
			rebuildStuff: defineMutation({
				title: 'Rebuild Stuff',
				handler: () => {},
			}),
			// Non-action properties should be ignored
			whenReady: Promise.resolve(),
			dispose() {},
		}));

		const descriptor = describeWorkspace(client);

		// Extensions discovered
		expect(Object.keys(descriptor.extensions)).toEqual(['myExt']);
		expect(descriptor.extensions.myExt).toHaveLength(2);

		const searchAction = descriptor.extensions.myExt?.find(
			(a) => a.path.join('.') === 'searchStuff',
		);
		expect(searchAction).toBeDefined();
		expect(searchAction?.type).toBe('query');
		expect(searchAction?.title).toBe('Search Stuff');

		const rebuildAction = descriptor.extensions.myExt?.find(
			(a) => a.path.join('.') === 'rebuildStuff',
		);
		expect(rebuildAction).toBeDefined();
		expect(rebuildAction?.type).toBe('mutation');

		// Actions from extensions are NOT in the top-level actions array
		expect(descriptor.actions).toEqual([]);
	});
});
