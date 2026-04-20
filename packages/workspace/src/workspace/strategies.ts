/**
 * Built-in content strategies for `.withDocument()`.
 *
 * Each strategy is a `ContentStrategy` — a function that receives the document's
 * Y.Doc and returns a typed content object directly from `open()`.
 *
 * Every strategy satisfies `ContentHandle` — consumers can always `read()` and
 * `write()` without touching Y.Doc internals. Editor-specific bindings are
 * available via `.binding` (PlainTextHandle, RichTextHandle) or mode-switching
 * methods (Timeline).
 *
 * @module
 */
import * as Y from 'yjs';
import { createTimeline, type Timeline } from '../timeline/timeline.js';
import { xmlFragmentToPlaintext } from '../timeline/richtext.js';
import type { PlainTextHandle, RichTextHandle } from './types.js';
/**
 * Plain text content strategy.
 *
 * Returns a `PlainTextHandle` wrapping Y.Text with `read()`, `write()`, and
 * a `binding` getter. Use for documents that are always plain text — markdown
 * files, code, skill instructions, plain notes.
 *
 * `write()` handles `ydoc.transact()` internally, so consumers never need
 * direct Y.Doc access. The `binding` property exposes the raw Y.Text for
 * editor integration (CodeMirror via y-codemirror, Monaco, etc.).
 *
 * @example
 * ```typescript
 * const filesTable = defineTable(
 *   type({ id: 'string', name: 'string', updatedAt: 'number', _v: '1' }),
 * ).withDocument('content', {
 *   content: plainText,
 *   guid: 'id',
 *   onUpdate: () => ({ updatedAt: Date.now() }),
 * });
 *
 * // At runtime:
 * const content = await workspace.documents.files.content.open(file);
 * content.read();             // string
 * content.write('hello');     // replaces content, transact handled internally
 * editor.bind(content.binding); // Y.Text for editor binding
 * ```
 */
export const plainText: (ydoc: Y.Doc) => PlainTextHandle = (ydoc) => {
	const ytext = ydoc.getText('content');
	return {
		get binding() {
			return ytext;
		},
		read() {
			return ytext.toString();
		},
		write(text: string) {
			ydoc.transact(() => {
				ytext.delete(0, ytext.length);
				ytext.insert(0, text);
			});
		},
	};
};

/**
 * Rich text content strategy.
 *
 * Returns a `RichTextHandle` wrapping Y.XmlFragment with `read()`, `write()`,
 * and a `binding` getter. Use for documents edited with ProseMirror, TipTap,
 * or other block editors via y-prosemirror.
 *
 * `write(text)` clears the fragment and inserts a paragraph node with the
 * given text — matching the behavior of Timeline's richtext write. The
 * `binding` property exposes the raw Y.XmlFragment for y-prosemirror.
 *
 * @example
 * ```typescript
 * const notesTable = defineTable(
 *   type({ id: 'string', title: 'string', updatedAt: 'number', _v: '1' }),
 * ).withDocument('body', {
 *   content: richText,
 *   guid: 'id',
 *   onUpdate: () => ({ updatedAt: Date.now() }),
 * });
 *
 * // At runtime:
 * const content = await workspace.documents.notes.body.open(note);
 * content.read();                // string (strips formatting)
 * content.write('hello');        // replaces content
 * const plugins = [ySyncPlugin(content.binding)]; // Y.XmlFragment for ProseMirror
 * ```
 */
export const richText: (ydoc: Y.Doc) => RichTextHandle = (ydoc) => {
	const fragment = ydoc.getXmlFragment('content');
	return {
		get binding() {
			return fragment;
		},
		read() {
			return xmlFragmentToPlaintext(fragment);
		},
		write(text: string) {
			ydoc.transact(() => {
				while (fragment.length > 0) {
					fragment.delete(0, 1);
				}
				const paragraph = new Y.XmlElement('paragraph');
				const textNode = new Y.XmlText(text);
				paragraph.insert(0, [textNode]);
				fragment.insert(0, [paragraph]);
			});
		},
	};
};

/**
 * Timeline content strategy — multi-mode document with format switching.
 *
 * Returns the existing Timeline object, which already satisfies `ContentHandle`
 * (`read()` and `write()` are built in). Supports runtime switching between
 * text, richtext, and sheet modes via `asText()` / `asRichText()` / `asSheet()`.
 *
 * Use for documents that need runtime mode switching — e.g., opensidian files
 * that toggle between source markdown and rich text editing, or spreadsheet
 * files that can also be viewed as CSV text.
 *
 * @example
 * ```typescript
 * const filesTable = defineTable(
 *   type({ id: 'string', name: 'string', updatedAt: 'number', _v: '1' }),
 * ).withDocument('content', {
 *   content: timeline,
 *   guid: 'id',
 *   onUpdate: () => ({ updatedAt: Date.now() }),
 * });
 *
 * // At runtime:
 * const content = await workspace.documents.files.content.open(file);
 * content.asText();      // Y.Text for CodeMirror binding
 * content.asRichText();  // Y.XmlFragment for ProseMirror binding
 * content.asSheet();     // SheetBinding for spreadsheet
 * content.read();        // string (mode-dependent)
 * content.write('hello');
 * ```
 */
export const timeline: (ydoc: Y.Doc) => Timeline = (ydoc) =>
	createTimeline(ydoc);
