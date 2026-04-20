---
name: workspace-api
description: Workspace API patterns for defineTable, defineKv, versioning, migrations, data access (CRUD + observation), withActions, and extension ordering. Use when the user mentions workspace, defineTable, defineKv, createWorkspace, withActions, withExtension, defineQuery, defineMutation, connectWorkspace, or when defining schemas, reading/writing table data, observing changes, writing migrations, chaining extensions, or attaching actions to a workspace client.
metadata:
  author: epicenter
  version: '6.0'
---

# Workspace API

## Reference Repositories

- [Yjs](https://github.com/yjs/yjs) — CRDT framework (foundation of workspace data layer)

Type-safe schema definitions for tables and KV stores.

> **Related Skills**: See `yjs` for Yjs CRDT patterns and shared types. See `svelte` for reactive wrappers (`fromTable`, `fromKv`).

## When to Apply This Skill

- Defining a new table or KV store with `defineTable()` or `defineKv()`
- Adding a new version to an existing table definition
- Writing table migration functions
- Reading, writing, or observing table/KV data
- Attaching actions to a workspace client via `.withActions()`
- Chaining extensions with `.withExtension()` or `.withWorkspaceExtension()`
- Writing server-side Bun scripts with `connectWorkspace()`
## Tables

### Shorthand (Single Version)

Use when a table has only one version:

```typescript
import { defineTable } from '@epicenter/workspace';
import { type } from 'arktype';

const usersTable = defineTable(type({ id: UserId, email: 'string', _v: '1' }));
export type User = InferTableRow<typeof usersTable>;
```

Every table schema must include `_v` with a number literal. The type system enforces this — passing a schema without `_v` to `defineTable()` is a compile error.

### Variadic (Multiple Versions)

Use when you need to evolve a schema over time:

```typescript
const posts = defineTable(
	type({ id: 'string', title: 'string', _v: '1' }),
	type({ id: 'string', title: 'string', views: 'number', _v: '2' }),
).migrate((row) => {
	switch (row._v) {
		case 1:
			return { ...row, views: 0, _v: 2 };
		case 2:
			return row;
	}
});
```

## KV Stores

KV stores use `defineKv(schema, defaultValue)`. No versioning, no migration—invalid stored data falls back to the default.

```typescript
import { defineKv } from '@epicenter/workspace';
import { type } from 'arktype';

const sidebar = defineKv(type({ collapsed: 'boolean', width: 'number' }), { collapsed: false, width: 300 });
const fontSize = defineKv(type('number'), 14);
const enabled = defineKv(type('boolean'), true);
```

### KV Design Convention: One Scalar Per Key

Use dot-namespaced keys for logical groupings of scalar values:

```typescript
// ✅ Correct — each preference is an independent scalar
'theme.mode': defineKv(type("'light' | 'dark' | 'system'"), 'light'),
'theme.fontSize': defineKv(type('number'), 14),

// ❌ Wrong — structured object invites migration needs
'theme': defineKv(type({ mode: "'light' | 'dark'", fontSize: 'number' }), { mode: 'light', fontSize: 14 }),
```

With scalar values, schema changes either don't break validation (widening `'light' | 'dark'` to `'light' | 'dark' | 'system'` still validates old data) or the default fallback is acceptable (resetting a toggle takes one click).

Exception: discriminated unions and `Record<string, T> | null` are acceptable when they represent a single atomic value.

## Branded Table IDs (Required)

Every table's `id` field and every string foreign key field MUST use a branded type instead of plain `'string'`. This prevents accidental mixing of IDs from different tables at compile time.

### Pattern

Define a branded type + arktype validator + generator in the same file as the workspace definition:

```typescript
import type { Brand } from 'wellcrafted/brand';
import { type } from 'arktype';
import { generateId, type Id } from '@epicenter/workspace';

// 1. Branded type + arktype validator (co-located with workspace definition)
export type ConversationId = Id & Brand<'ConversationId'>;
export const ConversationId = type('string').as<ConversationId>();

// 2. Generator function — the ONLY place with the cast
export const generateConversationId = (): ConversationId =>
	generateId() as ConversationId;

// 3. Use in defineTable + co-locate type export
const conversationsTable = defineTable(
	type({
		id: ConversationId,              // Primary key — branded
		title: 'string',
		'parentId?': ConversationId.or('undefined'),  // Self-referencing FK
		_v: '1',
	}),
);
export type Conversation = InferTableRow<typeof conversationsTable>;

// 4. At call sites — use the generator, never cast directly
const newId = generateConversationId();  // Good
// const newId = generateId() as string as ConversationId;  // Bad
```

## Actions (`.withActions()`)

Actions wrap workspace operations as `defineMutation` (writes) or `defineQuery` (reads). Attach them via `.withActions()` on a workspace builder—the call is non-terminal, so you can chain `.withExtension()` after it.

```typescript
import { createWorkspace, defineMutation, defineQuery, defineWorkspace } from '@epicenter/workspace';

export function createBlogWorkspace() {
	return createWorkspace(blogDefinition).withActions(({ tables }) => ({
		/**
		 * Mark a post as published and record the publication timestamp.
		 *
		 * Separated from a raw `tables.posts.update()` call because publish
		 * involves setting multiple fields atomically and may trigger side
		 * effects (notifications, RSS rebuild) in future versions.
		 */
		publish: defineMutation({
			description: 'Publish a draft post',
			input: type({ id: PostId }),
			handler: ({ id }) => {
				tables.posts.update({ id, published: true, publishedAt: Date.now() });
			},
		}),
	}));
}
```

### JSDoc on Action Methods

Every action method inside `.withActions()` should have a JSDoc comment. The JSDoc and the `description` field serve **different audiences**:

- **`description`** — consumed by MCP servers, CLI help text, and OpenAPI specs. Keep it short and declarative ("Import skills from disk").
- **JSDoc** — consumed by developers hovering in an IDE. Explain *why* the action exists as a separate operation, what non-obvious behavior it has, or what assumptions it makes.

```typescript
// ❌ Parrots the description
/** Import skills from an agentskills.io-compliant directory. */
importFromDisk: defineMutation({ description: 'Import skills from an agentskills.io-compliant directory', ... })

// ✅ Adds distinct value
/**
 * Scan a directory of SKILL.md files and upsert them into the workspace.
 *
 * Skills without a `metadata.id` in their frontmatter get one generated
 * and written back to the file, so future imports produce stable IDs
 * across machines.
 */
importFromDisk: defineMutation({ description: 'Import skills from an agentskills.io-compliant directory', ... })
```

## Workspace File Structure

Each app splits workspace code into an **isomorphic `workspace/` folder** and a **runtime-specific `client.ts`**:

```
src/lib/
│
├── workspace/                          ← 100% isomorphic (safe for Node, Bun, browser)
│   ├── definition.ts                   ← Schema: defineWorkspace, defineTable, branded IDs
│   ├── workspace.ts                    ← Factory: createWorkspace(definition) + isomorphic actions
│   └── index.ts                        ← Barrel: re-exports definition + workspace only
│
└── client.ts                           ← Runtime singleton: extensions, encryption, sync,
                                           runtime-specific actions (browser APIs, Node fs, etc.)
```

```
                    ┌─────────────────────────┐
                    │     definition.ts        │
                    │  tables, KV, branded IDs │
                    └────────────┬────────────┘
                                 │ imports
                    ┌────────────▼────────────┐
                    │     workspace.ts         │
                    │  createX() factory       │
                    │  + isomorphic actions    │
                    └────────────┬────────────┘
                                 │ imports
   ┌─────────────────────────────┼─────────────────────────────┐
   │                             │                             │
   ▼                             ▼                             ▼
┌──────────────┐   ┌──────────────────┐   ┌──────────────────┐
│ client.ts    │   │ server-client.ts │   │ cli-client.ts    │
│ (browser)    │   │ (Node/Bun)       │   │ (CLI)            │
│ IndexedDB    │   │ SQLite           │   │ filesystem       │
│ WebSocket    │   │ TCP sync         │   │ persistence      │
│ Chrome APIs  │   │ Node fs APIs     │   │                  │
└──────────────┘   └──────────────────┘   └──────────────────┘
```

### Layering Rules

1. **`definition.ts`** — Pure schema. `defineWorkspace()`, `defineTable()`, `defineKv()`, branded ID types and generators. Isomorphic.
2. **`workspace.ts`** — Factory function that calls `createWorkspace(definition)`. May chain `.withActions()` for **isomorphic** actions (table reads/writes only). Isomorphic.
3. **`index.ts`** — Barrel that re-exports from `definition.ts` and `workspace.ts` only. **Never re-exports from `client.ts`.** This is the import path for `$lib/workspace` and the package.json subpath export.
4. **`client.ts`** — Lives **outside** the `workspace/` folder at `src/lib/client.ts`. Calls the factory, chains `.withEncryption()`, `.withExtension()`, and runtime-specific `.withActions()`. Exports the singleton as a named export (`export const workspace = ...`).

### Import Convention

```typescript
// Components/state that need the live workspace instance:
import { workspace, auth } from '$lib/client';

// Components that only need types or the definition:
import { type Note, NoteId } from '$lib/workspace';

// Other packages in the monorepo:
import { createHoneycrisp } from '@epicenter/honeycrisp/workspace';
import { honeycrisp } from '@epicenter/honeycrisp/definition';
```

### Package.json Subpath Exports

Each app exports a single `./workspace` subpath pointing to the barrel:

```json
{
  "exports": {
    "./workspace": "./src/lib/workspace/index.ts"
  }
}
```

The barrel is 100% isomorphic, so this single subpath is safe for any consumer (server, CLI, other apps). The separate `./definition` subpath is no longer needed since the barrel already re-exports everything from `definition.ts`.

### Isomorphic vs Runtime-Specific Actions

Isomorphic actions (table reads/writes, portable logic) belong in the exported `workspace.ts` factory. Runtime-specific actions—whether browser APIs, Chrome extension APIs, Node/Bun filesystem calls, or Tauri commands—are chained via `.withActions()` in the client file closest to that runtime.

```typescript
// workspace.ts — isomorphic actions (exported via barrel)
export function createMyApp() {
  return createWorkspace(definition).withActions(({ tables }) => ({
    devices: {
      list: defineQuery({
        title: 'List Devices',
        description: 'List all synced devices.',
        input: Type.Object({}),
        handler: () => ({ devices: tables.devices.getAllValid() }),
      }),
    },
  }));
}

// src/lib/client.ts — browser-specific actions chained at the runtime boundary
export const workspace = createMyApp()
  .withExtension('persistence', indexeddbPersistence)
  .withExtension('sync', createSyncExtension({ ... }))
  .withActions(({ tables }) => ({
    tabs: {
      close: defineMutation({
        title: 'Close Tabs',
        description: 'Close browser tabs by ID.',
        input: Type.Object({ tabIds: Type.Array(Type.Number()) }),
        handler: async ({ tabIds }) => {
          await browser.tabs.remove(tabIds);  // Chrome API
          return { closedCount: tabIds.length };
        },
      }),
    },
  }));

// OR: src/lib/server-client.ts — Node/Bun-specific at the server boundary
export const workspace = createMyApp()
  .withExtension('persistence', sqlitePersistence)
  .withActions(({ tables }) => ({
    files: {
      importFromDisk: defineMutation({
        title: 'Import Files',
        description: 'Import files from a local directory.',
        input: Type.Object({ dirPath: Type.String() }),
        handler: async ({ dirPath }) => {
          const entries = await readdir(dirPath);  // Node fs API
          // ...
        },
      }),
    },
  }));
```

## Extension Ordering

Extensions initialize in registration order. Each extension's factory receives a `whenReady` promise that resolves when all previously registered extensions have finished initializing. Whether this creates a waterfall depends on whether each extension awaits it:

| Extension | Awaits prior `whenReady`? | Behavior |
|---|---|---|
| `filesystemPersistence` | No | Starts loading SQLite immediately |
| `indexeddbPersistence` | No | Starts loading IndexedDB immediately |
| `createCliUnlock` | Yes | Waits for persistence, then applies encryption keys |
| `createSyncExtension` | Yes | Waits for everything before it, then opens WebSocket |
| `createMarkdownMaterializer` | Yes | Waits for persistence + sync, then materializes |

The standard chain is **persistence → unlock → sync**:

```
persistence starts loading ────────────────────→ done
                                                   ↓
                        unlock waits... ──────────→ applies keys → done
                                                                    ↓
                        sync waits... ─────────────────────────────→ connects
```

This ordering matters because sync only exchanges the delta between local state and the server. Without persistence loading first, every cold start downloads the full document.

```typescript
// ✅ Correct — persistence loads first, sync exchanges delta only
createWorkspace(definition)
  .withExtension('persistence', filesystemPersistence({ filePath: '...' }))
  .withWorkspaceExtension('unlock', createCliUnlock(sessions, SERVER_URL))
  .withExtension('sync', createSyncExtension({ url: ..., getToken: ... }))

// ❌ Wrong — sync starts before local state is loaded, downloads full document
createWorkspace(definition)
  .withExtension('sync', createSyncExtension({ url: ..., getToken: ... }))
  .withExtension('persistence', filesystemPersistence({ filePath: '...' }))
```

### `connectWorkspace` (CLI/Script Shortcut)

For server-side Bun scripts, `connectWorkspace` from `@epicenter/cli` handles the unlock → sync chain automatically. It is **ephemeral by design — no local persistence**, so a script can coexist with a long-running `epicenter start` daemon without fighting over the same SQLite file:

```typescript
import { connectWorkspace } from '@epicenter/cli';
import { createFujiWorkspace } from '@epicenter/fuji/workspace';

const workspace = await connectWorkspace(createFujiWorkspace);
// Ready. Authenticated. Syncing. Full doc downloaded from server.

const entries = workspace.tables.entries.getAllValid();
await workspace.dispose();
```

Writes propagate through sync to the daemon, which owns the materializer (markdown, SQLite mirror, etc.).

Use `connectWorkspace` for one-off scripts and agent-written automation. Use `epicenter.config.ts` for long-running daemons and materializers that need persistence and custom workspace-specific extensions.


## The `_v` Convention

- `_v` is a **number** discriminant field (`'1'` in arktype = the literal number `1`)
- **Required for tables** — enforced at the type level via `CombinedStandardSchema<{ id: string; _v: number }>`
- **Not used by KV stores** — KV has no versioning; `defineKv(schema, defaultValue)` is the only pattern
- In arktype schemas: `_v: '1'`, `_v: '2'`, `_v: '3'` (number literals)
- In migration returns: `_v: 2` (TypeScript narrows automatically, `as const` is unnecessary)
- Convention: `_v` goes last in the object (`{ id, ...fields, _v: '1' }`)

## References

Load these on demand based on what you're working on:

- If working with **table migrations** (migration function rules, direct-to-latest strategy, migration anti-patterns, `as const` note), read [references/table-migrations.md](references/table-migrations.md)
- If working with **table/KV CRUD or observation** (`get`, `set`, `update`, `observe`, Svelte observer guidance), read [references/table-kv-crud-observation.md](references/table-kv-crud-observation.md)
- If working with **document content APIs** (`withDocument`, `handle.read/write`, mode bindings, `handle.batch`, `handle.ydoc` anti-pattern), read [references/document-content.md](references/document-content.md)

Code references:

- `packages/workspace/src/workspace/define-table.ts`
- `packages/workspace/src/workspace/define-kv.ts`
- `packages/workspace/src/workspace/index.ts`
- `packages/workspace/src/workspace/create-tables.ts`
- `packages/workspace/src/workspace/create-kv.ts`
- `packages/workspace/src/workspace/create-workspace.ts`
