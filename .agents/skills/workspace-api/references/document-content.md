# Document Content (Per-Row Y.Docs)

## When to Read This

Read when working with `.withDocument()` tables, content strategies, editor bindings, or batching content mutations.

## Document Content (Per-Row Y.Docs)

Tables with `.withDocument()` create a content Y.Doc per row. `open()` returns the content object directly—fully typed by the content strategy.

### Content Strategies

Each strategy determines what `open()` returns:

- **`plainText`** → `PlainTextHandle` with `read()`, `write()`, and `binding` (Y.Text)
- **`richText`** → `RichTextHandle` with `read()`, `write()`, and `binding` (Y.XmlFragment)
- **`timeline`** → `Timeline` with `read()`, `write()`, `asText()`, `asRichText()`, `asSheet()`, and more

### Reading and Writing Content

`open()` returns the content object directly:

```typescript
const content = await documents.open(fileId);

// Read content as string
const text = content.read();

// Write content (strategy handles transact internally)
content.write('hello');

// For plainText/richText — editor binding
const ytext = content.binding;    // Y.Text (plainText)
const fragment = content.binding;  // Y.XmlFragment (richText)

// For timeline — mode switching
content.asText();      // Y.Text for CodeMirror
content.asRichText();  // Y.XmlFragment for ProseMirror
content.asSheet();     // SheetBinding for spreadsheet
content.currentType;   // 'text' | 'richtext' | 'sheet' | undefined
```

For filesystem operations, `fs.readFile()` and `fs.writeFile()` open the content and delegate to `read()`/`write()` internally.

### Batching Mutations (Timeline only)

Use `content.batch()` to group multiple mutations into a single Yjs transaction:

```typescript
content.batch(() => {
  content.write('hello');
  // ...other mutations
});
```

### Anti-Patterns

**Do not access `content.ydoc` for content operations:**

```typescript
// ❌ BAD: bypasses content abstraction
const ytext = content.ydoc.getText('content');
content.ydoc.transact(() => { ... });

// ✅ GOOD: use content methods
content.read();
content.write('hello');
content.binding;  // for editor binding (plainText/richText)
```

`content.ydoc` (on Timeline) is an **escape hatch** for document extensions (persistence, sync providers) and tests. App code should never need it. This property is a follow-up candidate for removal.
