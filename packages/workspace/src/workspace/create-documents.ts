/**
 * createDocuments() — runtime document manager factory.
 *
 * Creates a bidirectional link between a table and its associated content Y.Docs.
 * It:
 * 1. Manages Y.Doc creation and provider lifecycle for each content document
 * 2. Watches content documents → calls `onUpdate` callback and writes returned fields to the row
 * 3. Watches the table → automatically cleans up documents when rows are deleted
 *
 * Most users never call this directly — `createWorkspace()` wires it automatically
 * when tables have `.withDocument()` declarations. Advanced users can use it standalone.
 *
 * @example
 * ```typescript
 * import { createDocuments, createTables, defineTable } from '@epicenter/workspace';
 * import * as Y from 'yjs';
 * import { type } from 'arktype';
 *
 * const filesTable = defineTable(
 *   type({ id: 'string', name: 'string', updatedAt: 'number', _v: '1' }),
 * ).withDocument('content', {
 *   guid: 'id',
 *   onUpdate: () => ({ updatedAt: Date.now() }),
 * });
 *
 * const ydoc = new Y.Doc({ guid: 'my-workspace' });
 * const tables = createTables(ydoc, { files: filesTable });
 *
 * const contentDocuments = createDocuments({
 *   id: 'my-workspace',
 *   tableName: 'files',
 *   documentName: 'content',
 *   guidKey: 'id',
 *   onUpdate: () => ({ updatedAt: Date.now() }),
 *   tableHelper: tables.files,
 *   ydoc,
 * });
 *
 * const content = await contentDocuments.open(someRow);
 * content.read();          // read content as string
 * content.write('new content');  // replace content
 * ```
 *
 * @module
 */

import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import {
	defineExtension,
	disposeLifo,
	type Extension,
	type MaybePromise,
	startDisposeLifo,
} from './lifecycle.js';
import type {
	BaseRow,
	ContentHandle,
	ContentStrategy,
	DocumentExtensionRegistration,
	Documents,
	TableHelper,
} from './types.js';

/**
 * Sentinel symbol used as the Y.js transaction origin when the documents
 * manager writes metadata (e.g., updatedAt) to the table. The update handler
 * checks `origin === DOCUMENTS_ORIGIN` to avoid re-triggering itself.
 *
 * Not part of the public API—internal to the workspace package.
 */
export const DOCUMENTS_ORIGIN = Symbol('documents');

/**
 * Internal entry for an open document.
 * Tracks the Y.Doc, resolved extensions (with required whenReady/dispose),
 * the updatedAt observer teardown, and the composite whenReady promise.
 */
type DocEntry<TBinding extends ContentHandle = ContentHandle> = {
	ydoc: Y.Doc;
	// biome-ignore lint/suspicious/noExplicitAny: runtime storage uses wide type
	extensions: Record<string, Extension<any>>;
	unobserve: () => void;
	whenReady: Promise<TBinding>;
};

/**
 * Configuration for `createDocuments()`.
 *
 * @typeParam TRow - The row type of the bound table
 */
export type CreateDocumentsConfig<
	TRow extends BaseRow,
	TBinding extends ContentHandle = ContentHandle,
> = {
	/**
	 * The workspace identifier. Passed through to `DocumentContext.id`.
	 *
	 * Extensions use this for persistence paths, sync room names, and other
	 * workspace-scoped identifiers. An empty string may cause
	 * collisions or silent failures in extensions.
	 */
	id: string;
	/** The table this document belongs to (e.g., 'files', 'notes'). */
	tableName: string;
	/** The document name from `.withDocument()` (e.g., 'content', 'body'). */
	documentName: string;
	/** Column name storing the Y.Doc GUID. */
	guidKey: keyof TRow & string;
	/** Content strategy — receives the document Y.Doc, returns the content object from `open()`. */
	content: ContentStrategy<TBinding>;
	/**
	 * Called on every content Y.Doc change (local and remote). Return the
	 * fields to write to the table row. The row write fires `table.observe`,
	 * which is how materializers and other consumers react to content changes.
	 * Return at least one field -- returning `{}` is a silent no-op.
	 */
	onUpdate: () => Partial<Omit<TRow, 'id'>>;
	/** The table helper — needed to update the row and observe row deletions. */
	tableHelper: TableHelper<TRow>;
	/** The workspace Y.Doc — needed for transact() when bumping updatedAt. */
	ydoc: Y.Doc;
	/**
	 * Document extension registrations (from `withDocumentExtension()` calls).
	 * Each registration has a key and factory.
	 */
	documentExtensions?: DocumentExtensionRegistration[];
};


/**
 * Create a runtime documents manager — a bidirectional link between table rows
 * and their content Y.Docs.
 *
 * The manager handles:
 * - Y.Doc creation with `gc: false` (required for Yjs provider compatibility)
 * - Provider lifecycle (persistence, sync) via document extension hooks
 * - Automatic `updatedAt` bumping when content documents change
 * - Automatic cleanup when rows are deleted from the table
 *
 * @param config - Documents configuration
 * @returns A `Documents<TRow>` with open/close/closeAll/guidOf methods
 */
export function createDocuments<
	TRow extends BaseRow,
	TBinding extends ContentHandle = ContentHandle,
>(
	config: CreateDocumentsConfig<TRow, TBinding>,
): Documents<TRow, TBinding> {
	const {
		id,
		tableName,
		documentName,
		guidKey,
		content,
		onUpdate,
		tableHelper,
		ydoc: workspaceYdoc,
		documentExtensions = [],
	} = config;

	const openDocuments = new Map<
		string,
		DocEntry<TBinding>
	>();

	/**
	 * Set up the table observer for row deletion cleanup.
	 * Closes the associated document when a row is deleted from the table.
	 *
	 * When guidKey is 'id' (common case), the document GUID is the row ID,
	 * so a direct Map lookup finds it. When guidKey is a different column,
	 * the row is already deleted so we can't reverse-map row ID → GUID.
	 * The fallback check (openDocuments.has(deletedId)) only catches the
	 * case where the GUID happens to equal the row ID.
	 */
	const unobserveTable = tableHelper.observe((changedIds) => {
		for (const deletedId of changedIds) {
			const result = tableHelper.get(deletedId);
			if (result.status !== 'not_found') continue;
			if (!openDocuments.has(deletedId)) continue;

			documents.close(deletedId);
		}
	});

	const documents: Documents<TRow, TBinding> = {
		async open(
			input: TRow | string,
		): Promise<TBinding> {
			const guid = typeof input === 'string' ? input : String(input[guidKey]);

			const existing = openDocuments.get(guid);
			if (existing) return existing.whenReady;

			const contentYdoc = new Y.Doc({ guid, gc: false });
			const contentAwareness = new Awareness(contentYdoc);
			const contentBinding = content(contentYdoc);

			// Call document extension factories synchronously.
			// IMPORTANT: No await between openDocuments.get() and openDocuments.set() — ensures
			// concurrent open() calls for the same guid are safe.
			// Build the extensions map incrementally so each factory sees prior
			// extensions' resolved form.
			// biome-ignore lint/suspicious/noExplicitAny: runtime storage uses wide type
			const resolvedExtensions: Record<string, Extension<any>> = {};
			const disposers: (() => MaybePromise<void>)[] = [];
			const whenReadyPromises: Promise<unknown>[] = [];

			try {
				for (const { key, factory } of documentExtensions) {
					const ctx = {
						id,
						tableName,
						documentName,
						ydoc: contentYdoc,
						awareness: { raw: contentAwareness },
						whenReady:
							whenReadyPromises.length === 0
								? Promise.resolve()
								: Promise.all(whenReadyPromises).then(() => {}),
						extensions: { ...resolvedExtensions },
					};
					const raw = factory(ctx);
					if (!raw) continue;

					const resolved = defineExtension(raw);
					resolvedExtensions[key] = resolved;
					disposers.push(resolved.dispose);
					whenReadyPromises.push(resolved.whenReady);
				}
			} catch (err) {
				startDisposeLifo(disposers);
				// ydoc.destroy() auto-destroys the Awareness via doc.on('destroy')
				contentYdoc.destroy();
				throw err;
			}

			// Attach onUpdate observer — fires on LOCAL content doc changes only.
			//
			// When a user types in ProseMirror, this fires and bumps metadata
			// (e.g., updatedAt). That change syncs to other tabs via the workspace
			// Y.Doc. Remote edits arriving via sync/broadcast are skipped — the
			// originating tab already bumped metadata, and we receive it via
			// workspace table sync.
			//
			// Without this guard, every tab independently calls onUpdate() with
			// DateTimeString.now(), producing distinct timestamps that ping-pong
			// between tabs and never converge.
			const updateHandler = (
				_update: Uint8Array,
				origin: unknown,
				_doc: Y.Doc,
				_transaction: Y.Transaction,
			) => {
				// Skip updates from the documents manager itself to avoid loops
				if (origin === DOCUMENTS_ORIGIN) return;

				// Skip transport-originated updates (sync, broadcast channel).
				// Convention: all transport origins are Symbols (SYNC_ORIGIN,
				// BC_ORIGIN). Local edits use non-Symbol origins (e.g., y-prosemirror's
				// ySyncPluginKey is a PluginKey object; direct mutations use null).
				// If a new transport is added, it MUST use a Symbol origin.
				if (typeof origin === 'symbol') return;

				// Call the user's onUpdate callback and write the returned fields
				workspaceYdoc.transact(() => {
					tableHelper.update(guid, onUpdate());
				}, DOCUMENTS_ORIGIN);
			};

			contentYdoc.on('update', updateHandler);
			const unobserve = () => contentYdoc.off('update', updateHandler);

			// Cache entry SYNCHRONOUSLY before any promise resolution
			const compositeWhenReady: Promise<void> =
				whenReadyPromises.length === 0
					? Promise.resolve()
					: Promise.all(whenReadyPromises).then(() => {});
			// Build the internal entry — consumers get contentBinding only
			const whenReady: Promise<TBinding> =
				whenReadyPromises.length === 0
					? Promise.resolve(contentBinding)
					: compositeWhenReady
							.then(() => contentBinding)
							.catch(async (err) => {
								const errors = await disposeLifo(disposers);
								unobserve();
								// ydoc.destroy() auto-destroys the Awareness via doc.on('destroy')
								contentYdoc.destroy();
								openDocuments.delete(guid);

								if (errors.length > 0) {
									console.error('Document extension cleanup errors:', errors);
								}
								throw err;
							});

			openDocuments.set(guid, {
				ydoc: contentYdoc,
				extensions: resolvedExtensions,
				unobserve,
				whenReady,
			});
			return whenReady;
		},

		async close(input: TRow | string): Promise<void> {
			const guid = typeof input === 'string' ? input : String(input[guidKey]);
			const entry = openDocuments.get(guid);
			if (!entry) return;

			// Remove from map SYNCHRONOUSLY so concurrent open() calls
			// create a fresh Y.Doc. Async cleanup follows.
			openDocuments.delete(guid);
			entry.unobserve();

			const errors = await disposeLifo(
				Object.values(entry.extensions).map((e) => e.dispose),
			);

			// ydoc.destroy() auto-destroys the Awareness via doc.on('destroy')
			entry.ydoc.destroy();

			if (errors.length > 0) {
				throw new Error(`Document extension cleanup errors: ${errors.length}`);
			}
		},

		async closeAll(): Promise<void> {
			const entries = Array.from(openDocuments.entries());
			// Clear map synchronously first
			openDocuments.clear();
			unobserveTable();

			for (const [, entry] of entries) {
				entry.unobserve();

				const errors = await disposeLifo(
					Object.values(entry.extensions).map((e) => e.dispose),
				);

				// ydoc.destroy() auto-destroys the Awareness via doc.on('destroy')
				entry.ydoc.destroy();

				if (errors.length > 0) {
					console.error('Document extension cleanup error:', errors);
				}
			}
		},
	};

	return documents;
}
