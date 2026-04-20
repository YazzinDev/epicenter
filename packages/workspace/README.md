# Epicenter: YJS-First Collaborative Workspace System

The hard problem with local-first apps is synchronization. If each device has its own SQLite file, how do you keep them in sync? If each device has its own markdown folder, same question.

`@epicenter/workspace` solves that by making Yjs the source of truth. Tables, KV entries, document content, and awareness all live in a `Y.Doc`; persistence, sync, and materializers hang off that core through the extension builder. Write to the workspace, and everything else reacts.

If you're coming from the old README, the API really did change. Older docs showed a different client/bootstrap surface than the one this package exports today. The public path now is `defineWorkspace(...)` or `createWorkspace(...)`, direct property access like `client.tables.posts`, `table.set(...)`, and extension subpaths such as `@epicenter/workspace/extensions/persistence/indexeddb`.

## Quick Start

```bash
bun add @epicenter/workspace
```

```typescript
import { type } from 'arktype';
import Type from 'typebox';
import {
	createWorkspace,
	defineMutation,
	defineQuery,
	defineTable,
	defineWorkspace,
	generateId,
} from '@epicenter/workspace';
import { indexeddbPersistence } from '@epicenter/workspace/extensions/persistence/indexeddb';
import { createSyncExtension } from '@epicenter/workspace/extensions/sync/websocket';

const posts = defineTable(
	type({
		id: 'string',
		title: 'string',
		body: 'string',
		published: 'boolean',
		_v: '1',
	}),
);

const blogDefinition = defineWorkspace({
	id: 'epicenter.blog',
	tables: { posts },
});

export const blogWorkspace = createWorkspace(blogDefinition)
	.withExtension('persistence', indexeddbPersistence)
	.withExtension(
		'sync',
		createSyncExtension({
			url: (docId) => `ws://localhost:3913/rooms/${docId}`,
		}),
	)
	.withActions(({ tables }) => ({
		posts: {
			list: defineQuery({
				title: 'List Posts',
				description: 'List all posts in the workspace.',
				handler: () => tables.posts.getAllValid(),
			}),

			create: defineMutation({
				title: 'Create Post',
				description: 'Create a new post row.',
				input: Type.Object({
					title: Type.String(),
					body: Type.String(),
				}),
				handler: ({ title, body }) => {
					const id = generateId();
					tables.posts.set({
						id,
						title,
						body,
						published: false,
						_v: 1,
					});

					return { id };
				},
			}),
		},
	}));

async function quickStart() {
	await blogWorkspace.whenReady;

	blogWorkspace.tables.posts.set({
		id: 'welcome',
		title: 'Hello World',
		body: 'This row lives in the Y.Doc.',
		published: false,
		_v: 1,
	});

	const result = blogWorkspace.tables.posts.get('welcome');
	if (result.status === 'valid') {
		blogWorkspace.tables.posts.update(result.row.id, { published: true });
	}

	const unsubscribe = blogWorkspace.tables.posts.observe((changedIds) => {
		for (const id of changedIds) {
			console.log('changed:', id);
		}
	});

	const allPosts = blogWorkspace.tables.posts.getAllValid();
	console.log(allPosts.length);

	blogWorkspace.tables.posts.delete('welcome');
	unsubscribe();

	const created = await blogWorkspace.actions.posts.create({
		title: 'Created through an action',
		body: 'Actions close over the client via closure.',
	});
	console.log(created.id);
}

void quickStart;
```

That example uses the current public API end to end:

- `defineTable(...)` with a real schema
- `defineWorkspace(...)` for a reusable definition
- `createWorkspace(...)` for the client
- `.withExtension(...)` for persistence and sync
- direct property access via `client.tables.posts`
- `set`, `get`, `update`, `delete`, `getAllValid`, and `observe`
- `.withActions(...)` plus `defineQuery(...)` and `defineMutation(...)`

## Core Philosophy

### Yjs is the source of truth

Epicenter keeps the write path brutally simple: the `Y.Doc` is authoritative. Tables and KV are just typed helpers over Yjs collections, and document content is a Yjs timeline. Sync providers, SQLite mirrors, and markdown files are all derived from that core.

That matters because conflict resolution only has to happen once. Yjs handles merge semantics; extensions react to the merged state.

### Definitions are pure; clients are live

`defineTable`, `defineKv`, and `defineWorkspace` are pure. They do not create a `Y.Doc`, open a socket, or touch IndexedDB. `createWorkspace` is the boundary where the live client appears.

That split is not cosmetic. It lets you share definitions across modules, infer types once, and instantiate different clients in different runtimes without rewriting the schema layer.

### The builder is the extension system

The old provider map is gone. The current model is a builder:

- `.withExtension(...)` registers an extension for the workspace doc and all document docs
- `.withWorkspaceExtension(...)` registers a workspace-only extension
- `.withDocumentExtension(...)` registers a document-only extension
- `.withActions(...)` attaches callable action functions to the live client

Extensions compose progressively. Each later extension sees the exports from earlier extensions through typed `client.extensions` access.

### Read-time validation beats write-time ceremony

Tables validate and migrate on read, not on write. `set(...)` writes the row shape TypeScript already approved. `get(...)` is where invalid old data shows up as `{ status: 'invalid' }` and old versions are migrated to the latest schema.

That trade-off is deliberate. It keeps the write path cheap and pushes schema evolution into one place—the table definition.

### Storage scales with active data, not edit history

With Yjs garbage collection enabled, storage tracks the live document much more closely than the number of operations that happened over time. Deleted rows, overwritten values, and old content states collapse down to compact metadata. The workspace grows because you keep more data—not because you clicked save a thousand times.

## Architecture Overview

### The Y.Doc: Heart of Every Workspace

Every piece of data lives in a `Y.Doc`, which provides conflict-free merging, real-time collaboration, and offline-first operation:

```
┌─────────────────────────────────────────────────────────────┐
│                      Y.Doc (CRDT)                            │
│  ┌───────────────────────────────────────────────────────┐  │
│  │ Y.Array('table:posts')  <- LWW entries per table      │  │
│  │   └── { key: id, val: { fields... }, ts: number }     │  │
│  │                                                        │  │
│  │ Y.Array('table:users')  <- Another table              │  │
│  │   └── { key: id, val: { fields... }, ts: number }     │  │
│  │                                                        │  │
│  │ Y.Array('kv')  <- Settings as LWW entries             │  │
│  │   └── { key: name, val: value, ts: number }           │  │
│  └───────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘

Note: Schema definitions are stored in static TypeScript modules, not in the Y.Doc.
The Y.Doc carries data. Your definition files carry meaning.
```

### Three-Layer Data Flow

```
┌────────────────────────────────────────────────────────────────────┐
│  WRITE FLOW                                                         │
│                                                                     │
│  App code / action → Y.Doc updated → Extensions react              │
│                       │                                             │
│              ┌────────┼────────┐                                    │
│              ▼        ▼        ▼                                    │
│         IndexedDB  WebSocket  Markdown                              │
│         or SQLite   sync      materializer                          │
└────────────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────────┐
│  READ FLOW                                                          │
│                                                                     │
│  Simple reads → table / kv helpers over Y.Doc                       │
│  Rich text  → document handles over timeline Y.Docs                 │
│  Derived reads → extension exports built on the same core           │
└────────────────────────────────────────────────────────────────────┘
```

### Multi-Device Sync Topology

Epicenter supports distributed sync where Y.Doc instances replicate across devices via y-websocket:

```
   PHONE                   LAPTOP                    DESKTOP
   ┌──────────┐           ┌──────────┐              ┌──────────┐
   │ Browser  │           │ Browser  │              │ Browser  │
   │ Y.Doc    │           │ Y.Doc    │              │ Y.Doc    │
   └────┬─────┘           └────┬─────┘              └────┬─────┘
        │                      │                         │
   (no server)            ┌────▼─────┐              ┌────▼─────┐
        │                 │ Elysia   │◄────────────►│ Elysia   │
        │                 │ :3913    │  server-to-  │ :3913    │
        │                 └────┬─────┘    server    └────┬─────┘
        │                      │                         │
        └──────────────────────┴─────────────────────────┘
                           Connect to multiple nodes
```

Yjs supports multiple providers simultaneously. A phone can connect to desktop, laptop, and cloud at the same time; CRDT merge semantics do the rest.

### How It All Fits Together

1. Define tables, KV entries, and awareness with `defineTable`, `defineKv`, and `defineWorkspace`.
2. Create a live client with `createWorkspace(definition)`.
3. Chain extensions with `.withExtension(...)`, `.withWorkspaceExtension(...)`, and `.withDocumentExtension(...)`.
4. Attach actions with `.withActions(...)`.
5. Wait for `client.whenReady` if your extensions load persisted state or open connections.
6. Read and write through `client.tables`, `client.kv`, `client.documents`, and `client.awareness`.
7. Use `iterateActions(...)`, `describeWorkspace(...)`, and action metadata if you want to build adapters such as HTTP, CLI, or MCP.
8. Dispose the client with `await client.dispose()` when you're done.

The architecture stays local-first: the workspace works offline, synchronizes opportunistically, and treats external systems as helpers around the document—not the other way around.

## Shared Workspace ID Convention

Epicenter uses stable, shared workspace IDs so multiple apps can collaborate on the same data.

- Format: `epicenter.<app>`
- Purpose: stable routing, persistence keys, sync room names, and workspace discovery
- Stability: once published, an ID should not change
- Scope: two apps with the same ID are intentionally pointing at the same workspace

The ID becomes `ydoc.guid` for the workspace doc, so it is not a throwaway string. Pick one and keep it.

## Core Concepts

### Workspaces

A workspace definition is plain data:

- `id`
- `tables`
- `kv`
- `awareness`

A workspace client is that definition plus a live `Y.Doc`, typed helpers, optional documents, optional extensions, and optional actions.

### Yjs document

The raw `Y.Doc` is still available at `client.ydoc`. That is the escape hatch, not the primary API. Most consumers should stay at the workspace layer unless they are building a new extension or debugging storage internals.

### Tables

Tables are versioned row collections. Each row must include:

- `id: string`
- `_v: number`

At runtime, each table becomes a `TableHelper` exposed as a direct property:

- `client.tables.posts.set(row)`
- `client.tables.posts.get(id)`
- `client.tables.posts.update(id, partial)`
- `client.tables.posts.delete(id)`

Table access is direct property access in the current API.

### KV

KV entries are for settings and scalar preferences. They are keyed by string and always return a valid value because invalid or missing data falls back to the definition's default.

- `client.kv.get('theme.mode')`
- `client.kv.set('theme.mode', 'dark')`
- `client.kv.observe('theme.mode', ...)`

### Extensions

Extensions are opt-in capabilities layered onto the workspace builder.

- Use `.withExtension(...)` when the same factory should apply to the workspace doc and every document doc.
- Use `.withWorkspaceExtension(...)` when the factory needs `tables`, `kv`, `definitions`, or other workspace-only fields.
- Use `.withDocumentExtension(...)` when the factory needs `timeline`, `tableName`, or `documentName`.

### Actions

Actions are callable functions with metadata.

- `defineQuery(...)` creates a read action
- `defineMutation(...)` creates a write action
- `.withActions(...)` attaches them to `client.actions`

Handlers close over the client through normal JavaScript closure. They do not receive a framework context object.

### Documents

Tables can declare document-backed content via `.withDocument(...)`. That creates typed document managers under `client.documents`.

If you define a `files` table with `.withDocument('content', ...)`, you get this shape at runtime:

- `client.documents.files.content.open(rowOrGuid)`
- `client.documents.files.content.close(rowOrGuid)`
- `client.documents.files.content.closeAll()`

An open handle is a timeline API with methods such as `read()`, `write(...)`, `asText()`, `asRichText()`, and `asSheet()`.

## Column Types

The old column builder API is gone. There is no `id()`, `text()`, `boolean()`, `date()`, `select()`, `tags()`, or `json()` in the current package surface.

Today, tables and KV entries are defined with schemas directly.

### Required table fields

Every table row schema must include:

- `id`
- `_v`

In arktype, `_v: '1'` means the numeric literal `1`, not the string `'1'` at runtime.

### Single-version tables

```typescript
import { type } from 'arktype';
import { defineTable } from '@epicenter/workspace';

const users = defineTable(
	type({
		id: 'string',
		email: 'string',
		name: 'string',
		_v: '1',
	}),
);

void users;
```

Use the single-schema form when the table has only one version today.

### Versioned tables

```typescript
import { type } from 'arktype';
import { defineTable } from '@epicenter/workspace';

const posts = defineTable(
	type({
		id: 'string',
		title: 'string',
		_v: '1',
	}),
	type({
		id: 'string',
		title: 'string',
		slug: 'string',
		_v: '2',
	}),
).migrate((row) => {
		switch (row._v) {
			case 1:
				return {
					...row,
					slug: row.title.toLowerCase().replaceAll(' ', '-'),
					_v: 2,
				};

			case 2:
				return row;
		}
	});

void posts;
```

Migration runs on read. Old rows stay old in storage until you rewrite them.

### KV entries

```typescript
import { type } from 'arktype';
import { defineKv } from '@epicenter/workspace';

const themeMode = defineKv(type("'light' | 'dark' | 'system'"), 'light');
const sidebarWidth = defineKv(type('number'), 280);
const sidebarCollapsed = defineKv(type('boolean'), false);

void themeMode;
void sidebarWidth;
void sidebarCollapsed;
```

KV is validate-or-default. There is no migration function.

### Awareness definitions

```typescript
import { type } from 'arktype';
import { createWorkspace, defineTable, defineWorkspace } from '@epicenter/workspace';

const notes = defineTable(
	type({
		id: 'string',
		title: 'string',
		_v: '1',
	}),
);

const definition = defineWorkspace({
	id: 'epicenter.notes',
	tables: { notes },
	awareness: {
		name: type('string'),
		color: type('string'),
		cursor: type({ line: 'number', column: 'number' }),
	},
});

const workspace = createWorkspace(definition);

workspace.awareness.setLocal({ name: 'Braden', color: '#ff4d4f' });
workspace.awareness.setLocalField('cursor', { line: 12, column: 3 });

void workspace;
```

### Document-backed tables

```typescript
import { type } from 'arktype';
import { createWorkspace, defineTable, defineWorkspace } from '@epicenter/workspace';

const files = defineTable(
	type({
		id: 'string',
		name: 'string',
		contentGuid: 'string',
		updatedAt: 'number',
		_v: '1',
	}),
).withDocument('content', {
	guid: 'contentGuid',
	onUpdate: () => ({ updatedAt: Date.now() }),
});

const definition = defineWorkspace({
	id: 'epicenter.files',
	tables: { files },
});

const workspace = createWorkspace(definition);

async function documentExample() {
	workspace.tables.files.set({
		id: 'file-1',
		name: 'hello.md',
		contentGuid: 'doc-1',
		updatedAt: 0,
		_v: 1,
	});

	const handle = await workspace.documents.files.content.open('doc-1');
	handle.content.write('# Hello from a document');
	console.log(handle.content.read());
	console.log(handle.content.currentType);
	await workspace.documents.files.content.close('doc-1');
	await workspace.dispose();
	return handle;
}

void documentExample;
```

## Table Operations

All table operations live on direct properties such as `client.tables.posts`.

### Write operations

`set(row)` inserts or replaces a whole row.

```typescript
import { type } from 'arktype';
import { createWorkspace, defineTable } from '@epicenter/workspace';

const posts = defineTable(
	type({
		id: 'string',
		title: 'string',
		published: 'boolean',
		_v: '1',
	}),
);

const workspace = createWorkspace({
	id: 'epicenter.examples.tables',
	tables: { posts },
});

workspace.tables.posts.set({
	id: 'post-1',
	title: 'First post',
	published: false,
	_v: 1,
});

workspace.tables.posts.set({
	id: 'post-1',
	title: 'First post, replaced',
	published: true,
	_v: 1,
});

void workspace;
```

`set(...)` is the insert-or-replace API.

### Update operations

`update(id, partial)` reads the row, merges the partial fields, validates the merged result, and writes it back.

Possible return values:

- `{ status: 'updated', row }`
- `{ status: 'not_found', id, row: undefined }`
- `{ status: 'invalid', id, errors, row }`

```typescript
import { type } from 'arktype';
import { createWorkspace, defineTable } from '@epicenter/workspace';

const posts = defineTable(
	type({
		id: 'string',
		title: 'string',
		published: 'boolean',
		views: 'number',
		_v: '1',
	}),
);

const workspace = createWorkspace({
	id: 'epicenter.examples.update',
	tables: { posts },
});

workspace.tables.posts.set({
	id: 'post-1',
	title: 'Draft',
	published: false,
	views: 0,
	_v: 1,
});

const updateResult = workspace.tables.posts.update('post-1', {
	published: true,
	views: 1,
});

if (updateResult.status === 'updated') {
	console.log(updateResult.row.views);
}

void workspace;
```

### Read operations

The table helper has two styles of read:

| Method | Return type | Notes |
| --- | --- | --- |
| `get(id)` | `GetResult<TRow>` | Returns `valid`, `invalid`, or `not_found` |
| `getAll()` | `RowResult<TRow>[]` | Includes invalid rows |
| `getAllValid()` | `TRow[]` | Skips invalid rows |
| `getAllInvalid()` | `InvalidRowResult[]` | Debug schema drift or corrupt data |
| `filter(predicate)` | `TRow[]` | Runs only on valid rows |
| `find(predicate)` | `TRow | undefined` | First valid match |
| `has(id)` | `boolean` | Existence only |
| `count()` | `number` | Counts valid and invalid rows |

```typescript
import { type } from 'arktype';
import { createWorkspace, defineTable } from '@epicenter/workspace';

const posts = defineTable(
	type({
		id: 'string',
		title: 'string',
		published: 'boolean',
		_v: '1',
	}),
);

const workspace = createWorkspace({
	id: 'epicenter.examples.reads',
	tables: { posts },
});

workspace.tables.posts.set({ id: '1', title: 'One', published: false, _v: 1 });
workspace.tables.posts.set({ id: '2', title: 'Two', published: true, _v: 1 });

const one = workspace.tables.posts.get('1');
if (one.status === 'valid') {
	console.log(one.row.title);
}

const all = workspace.tables.posts.getAll();
const valid = workspace.tables.posts.getAllValid();
const published = workspace.tables.posts.filter((row) => row.published);
const firstPublished = workspace.tables.posts.find((row) => row.published);
const hasPostTwo = workspace.tables.posts.has('2');
const count = workspace.tables.posts.count();

console.log(all.length, valid.length, published.length, firstPublished?.id, hasPostTwo, count);

void workspace;
```

### Delete operations

| Method | Behavior |
| --- | --- |
| `delete(id)` | Deletes one row; missing IDs are a silent no-op |
| `clear()` | Deletes all rows in the table |

```typescript
import { type } from 'arktype';
import { createWorkspace, defineTable } from '@epicenter/workspace';

const tags = defineTable(
	type({
		id: 'string',
		name: 'string',
		_v: '1',
	}),
);

const workspace = createWorkspace({
	id: 'epicenter.examples.deletes',
	tables: { tags },
});

workspace.tables.tags.set({ id: 'tag-1', name: 'important', _v: 1 });
workspace.tables.tags.delete('tag-1');
workspace.tables.tags.clear();

void workspace;
```

### Reactive updates

`observe(...)` reports a set of changed IDs and the optional Yjs transaction origin.

Use `table.get(id)` inside the callback to see whether the row now exists.

```typescript
import { type } from 'arktype';
import { createWorkspace, defineTable } from '@epicenter/workspace';
import { DOCUMENTS_ORIGIN } from '@epicenter/workspace';

const files = defineTable(
	type({
		id: 'string',
		name: 'string',
		_v: '1',
	}),
);

const workspace = createWorkspace({
	id: 'epicenter.examples.observe',
	tables: { files },
});

const unsubscribe = workspace.tables.files.observe((changedIds, origin) => {
	if (origin === DOCUMENTS_ORIGIN) {
		return;
	}

	for (const id of changedIds) {
		const result = workspace.tables.files.get(id);
		if (result.status === 'not_found') {
			console.log('deleted:', id);
			continue;
		}

		if (result.status === 'valid') {
			console.log('present:', result.row.name);
		}
	}
});

workspace.tables.files.set({ id: 'file-1', name: 'notes.md', _v: 1 });
workspace.tables.files.delete('file-1');
unsubscribe();

void workspace;
```

## Provider System

The old provider map is gone. The current public API is the extension chain.

That means this:

```text
createWorkspace(definition)
	.withExtension('persistence', indexeddbPersistence)
	.withExtension('sync', createSyncExtension({ ... }))
	.withWorkspaceExtension('markdown', (ctx) => createMarkdownMaterializer(ctx, { dir: '...' }).table('notes'));
```

Not this:

```text
// This API does not exist anymore.
// providers: { persistence: ..., sync: ... }
```

### Builder methods

| Method | Scope | Use when |
| --- | --- | --- |
| `.withExtension(key, factory)` | Workspace doc + all document docs | Same factory should run everywhere |
| `.withWorkspaceExtension(key, factory)` | Workspace doc only | Factory needs `tables`, `kv`, or `definitions` |
| `.withDocumentExtension(key, factory)` | Document docs only | Factory needs `timeline`, `tableName`, or `documentName` |
| `.withActions(factory)` | Live client only | Attach callable queries and mutations |

### Persistence extensions

The current public persistence subpaths are:

- `@epicenter/workspace/extensions/persistence/indexeddb`
- `@epicenter/workspace/extensions/persistence/sqlite`

The first exports `indexeddbPersistence`. The second exports `filesystemPersistence({ filePath })`, which returns an extension factory.

```typescript
import { type } from 'arktype';
import { createWorkspace, defineTable } from '@epicenter/workspace';
import { filesystemPersistence } from '@epicenter/workspace/extensions/persistence/sqlite';

const notes = defineTable(
	type({
		id: 'string',
		title: 'string',
		_v: '1',
	}),
);

const workspace = createWorkspace({
	id: 'epicenter.notes.desktop',
	tables: { notes },
}).withExtension(
	'persistence',
	filesystemPersistence({
		filePath: '/tmp/epicenter/notes.db',
	}),
);

void workspace;
```

### Sync extension

The public sync subpaths are:

- `@epicenter/workspace/extensions/sync/websocket`
- `@epicenter/workspace/extensions/sync/broadcast-channel`

In practice, `createSyncExtension(...)` is the main entry point. It already includes BroadcastChannel cross-tab sync.

```typescript
import { type } from 'arktype';
import { createWorkspace, defineTable } from '@epicenter/workspace';
import { indexeddbPersistence } from '@epicenter/workspace/extensions/persistence/indexeddb';
import {
	createSyncExtension,
	toWsUrl,
} from '@epicenter/workspace/extensions/sync/websocket';

const tabs = defineTable(
	type({
		id: 'string',
		url: 'string',
		_v: '1',
	}),
);

const workspace = createWorkspace({
	id: 'epicenter.tabs',
	tables: { tabs },
})
	.withExtension('persistence', indexeddbPersistence)
	.withExtension(
		'sync',
		createSyncExtension({
			url: (docId) => toWsUrl(`https://sync.epicenter.so/rooms/${docId}`),
		}),
	);

void workspace;
```

### Markdown materializer

The markdown materializer is exported at `@epicenter/workspace/extensions/materializer/markdown`. It is a workspace-only extension because it needs access to `tables`.

```typescript
import { type } from 'arktype';
import { createWorkspace, defineTable } from '@epicenter/workspace';
import { filesystemPersistence } from '@epicenter/workspace/extensions/persistence/sqlite';
import {
	createMarkdownMaterializer,
	slugFilename,
} from '@epicenter/workspace/extensions/materializer/markdown';

const notes = defineTable(
	type({
		id: 'string',
		title: 'string',
		body: 'string',
		_v: '1',
	}),
);

const workspace = createWorkspace({
	id: 'epicenter.notes',
	tables: { notes },
})
	.withExtension(
		'persistence',
		filesystemPersistence({
			filePath: '/tmp/epicenter/notes-workspace.db',
		}),
	)
	.withWorkspaceExtension('markdown', (ctx) =>
		createMarkdownMaterializer(ctx, { dir: '/tmp/epicenter/markdown' })
			.table('notes', { serialize: slugFilename('title') }),
	);

void workspace;

### SQLite materializer

The SQLite materializer is exported at `@epicenter/workspace/extensions/materializer/sqlite`. It mirrors workspace table rows into queryable SQLite tables with optional FTS5 full-text search. Like the markdown materializer, it uses a builder pattern with `.table()` opt-in.

```typescript
import { Database } from 'bun:sqlite';
import { createWorkspace, defineTable } from '@epicenter/workspace';
import { filesystemPersistence } from '@epicenter/workspace/extensions/persistence/sqlite';
import { createSqliteMaterializer } from '@epicenter/workspace/extensions/materializer/sqlite';

const posts = defineTable(
	type({
		id: 'string',
		title: 'string',
		body: 'string',
		published: 'boolean',
		_v: '1',
	}),
);

const workspace = createWorkspace({
	id: 'epicenter.blog',
	tables: { posts },
})
	.withExtension(
		'persistence',
		filesystemPersistence({ filePath: '/tmp/epicenter/blog.db' }),
	)
	.withWorkspaceExtension('sqlite', (ctx) =>
		createSqliteMaterializer(ctx, { db: new Database('/tmp/epicenter/blog.db') })
			.table('posts', { fts: ['title', 'body'] }),
	);

// After whenReady, query the materialized data:
// workspace.extensions.sqlite.search('posts', 'hello');
// workspace.extensions.sqlite.count('posts');
// workspace.extensions.sqlite.rebuild('posts');
```

The `MirrorDatabase` interface is structurally compatible with `bun:sqlite`'s `Database` and `better-sqlite3`'s `Database`—no wrapper needed. Pass your driver directly.

## Workspace Dependencies

Workspaces depend on each other the normal way: regular imports.

There is no special dependency graph inside the workspace package. If one action needs another workspace, import the other workspace client or factory and call it directly.

```typescript
import Type from 'typebox';
import { defineMutation } from '@epicenter/workspace';

declare const authWorkspace: {
	actions: {
		users: {
			getById: (input: { id: string }) => { id: string; name: string } | null;
		};
	};
};

declare const blogWorkspace: {
	tables: {
		posts: {
			set: (row: {
				id: string;
				title: string;
				authorId: string;
				_v: 1;
			}) => void;
		};
	};
};

const createPost = defineMutation({
	title: 'Create Post',
	description: 'Create a post for an existing author.',
	input: Type.Object({
		id: Type.String(),
		title: Type.String(),
		authorId: Type.String(),
	}),
	handler: ({ id, title, authorId }) => {
		const author = authWorkspace.actions.users.getById({ id: authorId });
		if (!author) return null;

		blogWorkspace.tables.posts.set({
			id,
			title,
			authorId,
			_v: 1,
		});

		return { id };
	},
});

void createPost;
```

That example uses `declare` stubs so the snippet compiles on its own, but the real pattern is just plain module composition.

## Actions

Actions are the current abstraction for developer-facing operations.

They have four important properties:

1. They are callable functions.
2. They carry metadata (`type`, `title`, `description`, `input`).
3. They close over the client by normal JavaScript closure.
4. They are attached to the workspace with `.withActions(...)`.

### Query actions

Use `defineQuery(...)` for reads.

```typescript
import { type } from 'arktype';
import Type from 'typebox';
import {
	createWorkspace,
	defineQuery,
	defineTable,
} from '@epicenter/workspace';

const posts = defineTable(
	type({
		id: 'string',
		title: 'string',
		published: 'boolean',
		_v: '1',
	}),
);

const workspace = createWorkspace({
	id: 'epicenter.actions.queries',
	tables: { posts },
}).withActions(({ tables }) => ({
	posts: {
		list: defineQuery({
			title: 'List Posts',
			description: 'List all posts.',
			handler: () => tables.posts.getAllValid(),
		}),

		getById: defineQuery({
			title: 'Get Post',
			description: 'Get one post by ID.',
			input: Type.Object({ id: Type.String() }),
			handler: ({ id }) => tables.posts.get(id),
		}),
	},
}));

const actionType = workspace.actions.posts.list.type;
void actionType;
void workspace;
```

### Mutation actions

Use `defineMutation(...)` for writes or side effects.

```typescript
import { type } from 'arktype';
import Type from 'typebox';
import {
	createWorkspace,
	defineMutation,
	defineTable,
	generateId,
} from '@epicenter/workspace';

const posts = defineTable(
	type({
		id: 'string',
		title: 'string',
		published: 'boolean',
		_v: '1',
	}),
);

const workspace = createWorkspace({
	id: 'epicenter.actions.mutations',
	tables: { posts },
}).withActions(({ tables }) => ({
	posts: {
		create: defineMutation({
			title: 'Create Post',
			description: 'Create a new post row.',
			input: Type.Object({ title: Type.String() }),
			handler: ({ title }) => {
				const id = generateId();
				tables.posts.set({ id, title, published: false, _v: 1 });
				return { id };
			},
		}),

		publish: defineMutation({
			title: 'Publish Post',
			description: 'Mark a post as published.',
			input: Type.Object({ id: Type.String() }),
			handler: ({ id }) => tables.posts.update(id, { published: true }),
		}),
	},
}));

void workspace;
```

### Input validation

Action inputs are TypeBox today.

That point matters because older docs implied a wider schema surface than the current implementation. `defineQuery` and `defineMutation` are typed around `typebox` `TSchema` inputs, so the safe example is:

```typescript
import Type from 'typebox';
import { defineQuery } from '@epicenter/workspace';

const searchPosts = defineQuery({
	title: 'Search Posts',
	description: 'Search posts by query string.',
	input: Type.Object({ query: Type.String(), limit: Type.Optional(Type.Number()) }),
	handler: ({ query, limit }) => ({ query, limit: limit ?? 10 }),
});

void searchPosts;
```

No-input actions are just as valid:

```typescript
import { defineMutation } from '@epicenter/workspace';

const clearCache = defineMutation({
	title: 'Clear Cache',
	description: 'Clear a local cache.',
	handler: () => {
		return { cleared: true };
	},
});

void clearCache;
```

### Action properties

Every action exposes:

- `action.type` — `'query'` or `'mutation'`
- `action.title` — optional UI-facing label
- `action.description` — optional adapter-facing description
- `action.input` — optional TypeBox schema

And the action itself is callable. There is no separate `.handler` property on the returned object.

### Type guards and iteration

```typescript
import Type from 'typebox';
import {
	defineMutation,
	defineQuery,
	isAction,
	isMutation,
	isQuery,
	iterateActions,
	type Actions,
} from '@epicenter/workspace';

const actions = {
	posts: {
		list: defineQuery({ handler: () => [] as string[] }),
		create: defineMutation({
			input: Type.Object({ title: Type.String() }),
			handler: ({ title }) => ({ title }),
		}),
	},
} satisfies Actions;

for (const [action, path] of iterateActions(actions)) {
	if (isAction(action)) {
		console.log(path.join('.'), action.type);
	}
}

const listAction = actions.posts.list;
if (isQuery(listAction)) {
	console.log(listAction.type);
}

const createAction = actions.posts.create;
if (isMutation(createAction)) {
	console.log(createAction.type);
}
```

## Providers

Historically, Epicenter called many of these things “providers.” In the current package surface, the better mental model is “extensions.” This section lists the public extension entry points the package actually exports.

| Import path | What it exports | Public today |
| --- | --- | --- |
| `@epicenter/workspace` | Core workspace API, actions, ids, dates, types | Yes |
| `@epicenter/workspace/extensions/persistence/indexeddb` | `indexeddbPersistence` | Yes |
| `@epicenter/workspace/extensions/persistence/sqlite` | `filesystemPersistence` | Yes |
| `@epicenter/workspace/extensions/sync/websocket` | `createSyncExtension`, `toWsUrl`, sync types | Yes |
| `@epicenter/workspace/extensions/sync/broadcast-channel` | BroadcastChannel sync extension | Yes |
| `@epicenter/workspace/extensions/materializer/markdown` | `createMarkdownMaterializer`, serializers | Yes |
| `@epicenter/workspace/extensions/materializer/sqlite` | `createSqliteMaterializer`, `generateDdl`, types | Yes |

### Create workspace

The builder is usable immediately. You do not need a separate “finalize” step.

```typescript
import { type } from 'arktype';
import { createWorkspace, defineTable } from '@epicenter/workspace';

const notes = defineTable(
	type({
		id: 'string',
		title: 'string',
		_v: '1',
	}),
);

const workspace = createWorkspace({
	id: 'epicenter.examples.builder',
	tables: { notes },
});

workspace.tables.notes.set({ id: '1', title: 'Ready immediately', _v: 1 });

void workspace;
```

If you add extensions, use `whenReady` as the async boundary.

## Architecture & Lifecycle

### Client initialization lifecycle

When you call `createWorkspace(...)`, here is the actual lifecycle:

```
┌─────────────────────────────────────────────────────────────┐
│ 1. CREATE Y.Doc                                            │
│    • guid = workspace id                                   │
│    • tables, kv, and awareness helpers are created         │
└─────────────────────────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│ 2. CREATE DOCUMENT MANAGERS                                │
│    • Only for tables that called .withDocument()           │
│    • Managers are eager; document Y.Docs open lazily       │
└─────────────────────────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│ 3. APPLY BUILDER CHAIN                                     │
│    • withExtension / withWorkspaceExtension /              │
│      withDocumentExtension / withActions                   │
│    • each step returns a fresh builder                     │
└─────────────────────────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│ 4. RESOLVE whenReady                                       │
│    • composite promise across all registered extensions    │
│    • persistence loads first, sync can wait on it          │
└─────────────────────────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│ 5. LIVE CLIENT                                             │
│    • tables / kv / documents / awareness / extensions      │
│    • actions callable directly through client.actions      │
└─────────────────────────────────────────────────────────────┘
```

### `batch(fn)`

`client.batch(fn)` groups workspace mutations into a single Yjs transaction.

```typescript
import { type } from 'arktype';
import { createWorkspace, defineTable } from '@epicenter/workspace';

const posts = defineTable(
	type({
		id: 'string',
		title: 'string',
		_v: '1',
	}),
);

const tags = defineTable(
	type({
		id: 'string',
		name: 'string',
		_v: '1',
	}),
);

const workspace = createWorkspace({
	id: 'epicenter.examples.batch',
	tables: { posts, tags },
});

workspace.batch(() => {
	workspace.tables.posts.set({ id: 'p1', title: 'One transaction', _v: 1 });
	workspace.tables.tags.set({ id: 't1', name: 'docs', _v: 1 });
});

void workspace;
```

Yjs transactions do not roll back on throw. They batch notifications; they are not SQL transactions.

### `whenReady`, `clearLocalData`, and `dispose`

| API | What it means |
| --- | --- |
| `whenReady` | Composite readiness promise across all installed extensions |
| `clearLocalData()` | Calls extension `clearLocalData` hooks in LIFO order |
| `dispose()` | Tears down observers, connections, and extension resources |

`dispose()` preserves data. It cleans up resources. If you want to wipe persisted local state, that is what `clearLocalData()` is for.

### Cleanup lifecycle

```
┌─────────────────────────────────────────────────────────────┐
│ dispose() called                                           │
└─────────────────────────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│ 1. Close open document handles                             │
│    • document providers disconnect                         │
│    • document observers stop                               │
└─────────────────────────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│ 2. Dispose extensions in LIFO order                        │
│    • sockets close                                         │
│    • persistence adapters flush / detach                   │
│    • status emitters stop                                  │
└─────────────────────────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│ 3. Destroy awareness + Y.Doc                               │
└─────────────────────────────────────────────────────────────┘
```

## Client vs Server

`@epicenter/workspace` is the core client/workspace library.

The public root export does not currently ship a built-in server helper. Older docs implied otherwise; that is stale.

What the package does give you is the raw material a server adapter needs:

- `client.actions`
- `iterateActions(...)`
- `describeWorkspace(...)`
- action metadata (`type`, `input`, `description`)
- direct access to workspace tables, KV, documents, and awareness

If you want HTTP, CLI, or MCP on top, build or import an adapter around those primitives.

## API Reference

### Workspace definition

```typescript
import {
	defineKv,
	defineTable,
	defineWorkspace,
	type WorkspaceDefinition,
} from '@epicenter/workspace';
```

Core definition helpers:

- `defineTable(schema)`
- `defineTable(v1, v2, ...).migrate(fn)`
- `defineKv(schema, defaultValue)`
- `defineWorkspace({ id, tables, kv, awareness })`

### Client creation

```typescript
import {
	createWorkspace,
	type WorkspaceClient,
	type WorkspaceClientBuilder,
} from '@epicenter/workspace';
```

The builder returned by `createWorkspace(...)` is already a usable client.

### Client properties

The important runtime properties are:

- `client.id`
- `client.ydoc`
- `client.definitions`
- `client.tables`
- `client.documents`
- `client.kv`
- `client.awareness`
- `client.extensions`
- `client.actions` when attached through `.withActions(...)`
- `client.whenReady`

Lifecycle and utility methods:

- `client.batch(fn)`
- `client.loadSnapshot(update)`
- `client.applyEncryptionKeys(keys)`
- `client.clearLocalData()`
- `client.dispose()`

### Document content model

Open document handles expose content via `handle.content`, typed by the content strategy.

For timeline strategy (`content: timeline`):

- `handle.content.read()`
- `handle.content.write(text)`
- `handle.content.appendText(text)`
- `handle.content.asText()`
- `handle.content.asRichText()`
- `handle.content.asSheet()`
- `handle.content.currentType`
- `handle.content.observe(...)`
- `handle.content.restoreFromSnapshot(binary)`

For plainText strategy (`content: plainText`), `handle.content` is `Y.Text`.
For richText strategy (`content: richText`), `handle.content` is `Y.XmlFragment`.

Document managers live at `client.documents.{tableName}.{documentName}` and expose:

- `open(rowOrGuid)`
- `close(rowOrGuid)`
- `closeAll()`

### Actions

```typescript
import {
	defineMutation,
	defineQuery,
	isAction,
	isMutation,
	isQuery,
	iterateActions,
	type Action,
	type Actions,
	type Mutation,
	type Query,
} from '@epicenter/workspace';
```

### Table operations

```typescript
import {
	type GetResult,
	type InvalidRowResult,
	type RowResult,
	type TableHelper,
	type UpdateResult,
	type ValidRowResult,
} from '@epicenter/workspace';
```

Public table helper methods:

- `parse(id, input)`
- `set(row)`
- `update(id, partial)`
- `get(id)`
- `getAll()`
- `getAllValid()`
- `getAllInvalid()`
- `filter(predicate)`
- `find(predicate)`
- `delete(id)`
- `clear()`
- `observe(callback)`
- `count()`
- `has(id)`

### KV operations

```typescript
import { type KvChange, type KvHelper } from '@epicenter/workspace';
```

Public KV helper methods:

- `get(key)`
- `set(key, value)`
- `delete(key)`
- `observe(key, callback)`
- `observeAll(callback)`

### Awareness

```typescript
import {
	type AwarenessDefinitions,
	type AwarenessHelper,
	type AwarenessState,
	type InferAwarenessValue,
} from '@epicenter/workspace';
```

Public awareness helper methods:

- `setLocal(state)`
- `setLocalField(key, value)`
- `getLocal()`
- `getLocalField(key)`
- `getAll()`
- `peers()`
- `observe(callback)`
- `raw`

### Introspection

```typescript
import {
	describeWorkspace,
	standardSchemaToJsonSchema,
	type ActionDescriptor,
	type SchemaDescriptor,
	type WorkspaceDescriptor,
} from '@epicenter/workspace';
```

`describeWorkspace(client)` gives you a serializable description of tables, KV, awareness, and actions. `standardSchemaToJsonSchema(...)` converts compatible standard schemas to JSON Schema.

### IDs and dates

```typescript
import {
	DateTimeString,
	dateTimeStringNow,
	generateGuid,
	generateId,
	type DateIsoString,
	type Guid,
	type Id,
	type TimezoneId,
} from '@epicenter/workspace';
```

### Storage keys

```typescript
import {
	KV_KEY,
	TableKey,
	type KvKey,
	type TableKeyType,
} from '@epicenter/workspace';
```

These matter when you are writing low-level tooling against raw Yjs structures.

### Drizzle re-exports

```typescript
import {
	and,
	asc,
	desc,
	eq,
	gt,
	gte,
	inArray,
	isNotNull,
	isNull,
	like,
	lt,
	lte,
	ne,
	not,
	or,
	sql,
} from '@epicenter/workspace';
```

These are convenience re-exports for extension code and mirror/query packages that already depend on Drizzle.

## MCP Integration

The core package does not export an MCP server. What it does export is the metadata you need to build one.

The current pieces are:

- actions with `type`, `title`, `description`, and `input`
- `iterateActions(...)` to flatten a nested action tree
- `describeWorkspace(...)` for schema introspection
- `standardSchemaToJsonSchema(...)` for schema conversion where supported

That is enough to build adapters that expose workspace actions over HTTP, CLI, or MCP without coupling the core package to one transport.

### Setup

```typescript
import Type from 'typebox';
import {
	defineMutation,
	defineQuery,
	iterateActions,
	type Actions,
} from '@epicenter/workspace';

const actions: Actions = {
	posts: {
		list: defineQuery({
			title: 'List Posts',
			description: 'List all posts.',
			handler: () => [] as Array<{ id: string; title: string }>,
		}),

		create: defineMutation({
			title: 'Create Post',
			description: 'Create a post.',
			input: Type.Object({ title: Type.String() }),
			handler: ({ title }) => ({ id: title.toLowerCase() }),
		}),
	},
};

for (const [action, path] of iterateActions(actions)) {
	console.log({
		name: path.join('.'),
		type: action.type,
		title: action.title,
		description: action.description,
		hasInput: action.input !== undefined,
	});
}
```

That is the public adapter surface today.

## Contributing

### Local development

From the repo root:

```bash
bun install
```

Type-check the workspace package itself:

```bash
bun run typecheck
```

If you're working on the package from another local project, use Bun's normal workspace linking flow. Nothing about the current API requires a special README-only workflow.

### Running tests

From the repo root:

```bash
bun test packages/workspace
```

Or run the package test suite directly from `packages/workspace` if you prefer the local context.

### More information

Useful internal docs live nearby:

- `src/workspace/README.md` — mental model for the lower-level workspace layer
- `docs/` — package-specific architecture notes
- `specs/` — historical design docs and implementation specs

## Related Packages

If your app's data model is inherently files and folders—a code editor, a note vault with nested directories, anything where users expect `mkdir` and path resolution—[`@epicenter/filesystem`](../filesystem) builds that abstraction on top of this package. It imports `defineTable` to create a `filesTable`, wraps workspace tables and documents into POSIX-style operations (`writeFile`, `mv`, `rm`, `stat`), and plugs into the same extension system.

Most apps won't need it. If you know the shape of every record upfront, workspace tables are the right default. See [Your Data Is Probably a Table, Not a File](../../docs/articles/your-data-is-probably-a-table-not-a-file.md) for the full decision matrix.

## License

MIT
