# Workspace API

A typed interface over Y.js for apps that need to evolve their data schema over time.

## The Idea

This is a wrapper around Y.js that handles schema versioning. Local-first apps can't run migration scripts, so data has to evolve gracefully. Old data coexists with new. The Workspace API bakes that into the design: define your schemas once with versions, write a migration function, and everything else is typed.

It's structured in two layers. Start at the top, drop down when you need control:

```
┌────────────────────────────────────────────────┐
│  Your App                                      │
├────────────────────────────────────────────────┤
│  defineWorkspace() → createWorkspace()         │ ← Public API
│  ↓ Result: WorkspaceClient                     │
│  { tables, kv, documents, awareness, extensions } │
├────────────────────────────────────────────────┤
│  createTable(ykv, def)                         │ ← Internal building blocks
│  createKv(ykv, defs)                            │   (used by createWorkspace
│  createEncryptedYkvLww(yarray, { key })          │    and tests)
├────────────────────────────────────────────────┤
│  Y.Doc (raw CRDT)                              │ ← Escape hatch
│  ↓ Storage: table:posts, table:users, kv      │
└────────────────────────────────────────────────┘
```

## The Pattern: define vs create

This codebase uses two prefixes consistently. `define*` is pure, no Y.Doc, no side effects. `create*` does instantiation:

```typescript
// Pure schema definitions
const posts = defineTable(type({ id: 'string', title: 'string', _v: '1' }));

const workspace = defineWorkspace({ id: 'my-app', tables: { posts } });

// Creates Y.Doc and returns a typed client
const client = createWorkspace(workspace);
```

For most apps, just call `createWorkspace(definition)` and you're done. It's synchronous, returns immediately, and everything is typed.

## If You Need More

### Extensions

Extensions add capabilities (persistence, sync, indexing) without baking them into the core. Three registration methods target different scopes:

```typescript
const client = createWorkspace({
	id: 'my-app',
	tables: { posts },
})
	// Dual-scope: registers for BOTH the workspace Y.Doc and every content Y.Doc.
	// The factory only receives { ydoc, whenReady }—the minimal shared contract.
	.withExtension('persistence', indexeddbPersistence)
	.withExtension('broadcast', broadcastChannelSync)

	// Workspace-only: receives the full ExtensionContext (tables, kv, awareness, etc.)
	.withWorkspaceExtension('sync', createSyncExtension({ url: '...' }))
	.withWorkspaceExtension('sqliteIndex', createSqliteIndex())

	// Document-only: receives DocumentContext (timeline, ydoc, id, whenReady, extensions)
	.withDocumentExtension('indexer', docIndexer);
```

`withExtension` is sugar—it calls both `withWorkspaceExtension` and `withDocumentExtension` with the same factory. If a factory needs scope-specific fields (tables, awareness, timeline), register it with the scoped method instead.

Each factory returns a flat object with custom exports alongside optional `whenReady` and `destroy`. The framework normalizes defaults internally.

```typescript
// What each scope receives:
//
// withExtension          → { ydoc, whenReady }  (SharedExtensionContext)
// withWorkspaceExtension → { id, ydoc, tables, kv, awareness, documents,
//                          definitions, extensions, whenReady, batch,
//                          loadSnapshot }  (ExtensionContext)
// withDocumentExtension  → { id, ydoc, timeline, extensions,
//                          whenReady }  (DocumentContext)
```

### Internal Building Blocks

The workspace is composed from two internal building blocks, `createTable(ykv, definition)` and `createKv(ykv, definitions)`. These take a pre-created encrypted store and return typed CRUD helpers. They're not publicly exported because the store type (`YKeyValueLwwEncrypted`) is internal, but they're useful in tests:

```typescript
import { createTable } from './create-table.js';
import { createEncryptedYkvLww } from '../shared/y-keyvalue/y-keyvalue-lww-encrypted.js';

const yarray = ydoc.getArray(TableKey('posts'));
const ykv = createEncryptedYkvLww(yarray, {});
const posts = createTable(ykv, postsDefinition);

posts.set({ id: '1', title: 'Hello', _v: 1 });
```

You lose the workspace wrapper and automatic lifecycle, but keep full type safety and control.

## Design Decisions

The code makes specific bets about what matters. Worth knowing upfront:

**Row-level atomicity.** `set()` replaces the entire row. No field-level updates. This keeps consistency simple when data migrates. You don't have to ask "should I merge old fields with new?" Every write is a complete row in the latest schema. If you're updating a field, read it first:

```typescript
const result = posts.get('1');
if (result.status === 'valid') {
	posts.set({ ...result.row, views: result.row.views + 1 });
}
```

**Migration on read, not on write.** Old data transforms when you load it, not when you write. Old rows stay old in storage until explicitly rewritten. This enables rollback and means you don't pay the migration cost at startup.

**No write validation.** Writes aren't validated at runtime. TypeScript's job is to ensure the types are right; if you write garbage, reads will catch it and return invalid. Validation at write time is mostly overhead—the real bugs come from data corruption you didn't expect.

**No field-level observation.** You observe entire tables or KV keys, not individual fields. This keeps the API simple. Let your UI framework handle field reactivity.

**Why `_v` instead of `v`.** The underscore prefix signals "framework metadata, not user data" (same convention as `_id` in MongoDB). Users intuitively avoid underscore-prefixed fields for business data, which prevents accidental collisions with framework internals. Historically, this also avoided collision with the old `EncryptedBlob.v` field, but that rationale no longer applies—`EncryptedBlob` is now a branded bare `Uint8Array` detected via `instanceof Uint8Array && value[0] === 1`.

For detailed rationale on all of this, see [the guide](docs/articles/20260127T120000-static-workspace-api-guide.md).

## Document Content

Tables with `.withDocument()` create per-row Y.Docs for content. The content type is determined by a content strategy passed to `.withDocument()`: `plainText` returns `Y.Text`, `richText` returns `Y.XmlFragment`, and `timeline` returns a `Timeline` with mode-switching support.

The handle is the canonical interface. Content is accessed via `handle.content`—fully typed by the strategy. For `timeline` strategy: `handle.content.read()`/`handle.content.write()` for string I/O, `handle.content.asText()` for Y.Text editor binding, `handle.content.asRichText()` for Y.XmlFragment binding, `handle.content.asSheet()` for spreadsheet binding, and `handle.content.batch()` for batching mutations. For `plainText`/`richText`, `handle.content` IS the Yjs shared type—bind it directly to your editor.

See `specs/20260418T120000-withdocument-content-strategy.md` for the full design.

## Testing

The tests are in `*.test.ts` files next to the implementation. Use `new Y.Doc()` for in-memory tests. Migrations are validated by reading old data and checking the result. Look at existing tests for patterns.

## Go Deeper

- [API Guide](docs/articles/20260127T120000-static-workspace-api-guide.md) - Examples, patterns, when to use what
- [Specification](specs/20260126T120000-static-workspace-api.md) - Full API reference
- [Storage Internals](specs/20260125T120000-versioned-table-kv-specification.md) - How versioning works under the hood
