/**
 * Fuji workspace — schema definition, branded IDs, and workspace factory.
 *
 * Fuji is a personal CMS with a 1:1 mapping to your blog. Entries are content
 * pieces—articles, thoughts, ideas—organized by tags and type, displayed in a
 * data table with an editor panel. Each entry has a rich-text content document
 * for collaborative editing via ProseMirror + y-prosemirror.
 *
 * The factory returns a non-terminal builder. Consumers chain `.withExtension()`
 * to add persistence, encryption, sync, or other capabilities.
 *
 * @example
 * ```typescript
 * import { createFujiWorkspace } from '$lib/workspace'
 *
 * const ws = createFujiWorkspace()
 *   .withExtension('persistence', indexeddbPersistence)
 *
 * // Create an entry via action (CLI, AI, or UI)
 * ws.actions.entries.create({ title: 'My Post', tags: ['draft'] })
 * ```
 */

import {
	createWorkspace,
	DateTimeString,
	defineMutation,
	defineTable,
	defineWorkspace,
	generateId,
	richText,
	type InferTableRow,
} from '@epicenter/workspace';
import { type } from 'arktype';
import Type from 'typebox';
import type { Brand } from 'wellcrafted/brand';

// ─── Branded IDs ──────────────────────────────────────────────────────────────

/**
 * Branded entry ID — nanoid generated when an entry is created.
 *
 * Prevents accidental mixing with other string IDs at compile time.
 */
export type EntryId = string & Brand<'EntryId'>;
export const EntryId = type('string').pipe((s): EntryId => s as EntryId);

// ─── Tables ───────────────────────────────────────────────────────────────────

/**
 * Entries table — content pieces in a personal CMS.
 *
 * Each entry has a title, subtitle (editorial hook for blog listings and table
 * display), type classification, and freeform tags. Both `type` and `tags` are
 * always present—an unclassified entry has empty arrays, not missing fields.
 *
 * `date` is the user-defined date associated with the entry—the "when" of the
 * content itself. For a blog post it's the publish date, for a journal entry
 * it's when it happened, for research notes it's the reference date. Always
 * present—defaults to `createdAt` on creation, editable by the user afterward.
 *
 * Entries support pinning (pinned entries sort to the top of lists) and soft
 * deletion via `deletedAt`. Soft-deleted entries move to "Recently Deleted"
 * rather than being permanently destroyed—critical for CRDT conflict safety
 * when two devices diverge.
 *
 * The rich-text content document is attached via `.withDocument('content')` and
 * keyed by entry `id` for a 1:1 mapping. Edits to the document automatically
 * touch `updatedAt`.
 */
const entriesTable = defineTable(
	type({
		id: EntryId,
		title: 'string',
		subtitle: 'string',
		type: 'string[]',
		tags: 'string[]',
		pinned: 'boolean',
		'deletedAt?': DateTimeString.or('undefined'),
		date: DateTimeString,
		createdAt: DateTimeString,
		updatedAt: DateTimeString,
		_v: '1',
	}),
	type({
		id: EntryId,
		title: 'string',
		subtitle: 'string',
		type: 'string[]',
		tags: 'string[]',
		pinned: 'boolean',
		rating: 'number',
		'deletedAt?': DateTimeString.or('undefined'),
		date: DateTimeString,
		createdAt: DateTimeString,
		updatedAt: DateTimeString,
		_v: '2',
	}),
)
	.migrate((row) => {
		switch (row._v) {
			case 1:
				return { ...row, rating: 0, _v: 2 };
			case 2:
				return row;
		}
	})
	.withDocument('content', {
		content: richText,
		guid: 'id',
		onUpdate: () => ({ updatedAt: DateTimeString.now() }),
	});

export type Entry = InferTableRow<typeof entriesTable>;

// ─── Workspace ────────────────────────────────────────────────────────────────

export const fuji = defineWorkspace({
	id: 'epicenter.fuji',
	tables: { entries: entriesTable },
});

// ─── Factory ──────────────────────────────────────────────────────────────────

export function createFujiWorkspace() {
	return createWorkspace(fuji).withActions(({ tables }) => ({
		entries: {
			/**
			 * Create a new entry with sensible defaults.
			 *
			 * Generates a branded ID, sets timestamps, and returns the new ID
			 * so the caller can select it or navigate to it. Optional fields
			 * (title, subtitle, type, tags) default to empty values.
			 */
			create: defineMutation({
				title: 'Create Entry',
				description:
					'Create a new CMS entry with optional title, subtitle, type, tags, and rating.',
				input: Type.Object({
					title: Type.Optional(Type.String({ description: 'Entry title' })),
					subtitle: Type.Optional(
						Type.String({ description: 'Subtitle for blog listings' }),
					),
					type: Type.Optional(
						Type.Array(Type.String(), {
							description: 'Type classifications',
						}),
					),
					tags: Type.Optional(
						Type.Array(Type.String(), { description: 'Freeform tags' }),
					),
					rating: Type.Optional(
						Type.Number({ description: 'Rating from 0–5 (0 = unrated)' }),
					),
				}),
				handler: ({ title, subtitle, type: entryType, tags, rating }) => {
					const id = generateId() as EntryId;
					const now = DateTimeString.now();
					tables.entries.set({
						id,
						title: title ?? '',
						subtitle: subtitle ?? '',
						type: entryType ?? [],
						tags: tags ?? [],
						pinned: false,
						rating: rating ?? 0,
						deletedAt: undefined,
						date: now,
						createdAt: now,
						updatedAt: now,
						_v: 2 as const,
					});
					return { id };
				},
			}),
			/**
			 * Update entry metadata fields and auto-bump `updatedAt`.
			 *
			 * Every field edit—title, subtitle, tags, type, date—routes through
			 * this action so `updatedAt` stays consistent whether the change
			 * comes from the UI, CLI, or AI.
			 */
			update: defineMutation({
				title: 'Update Entry',
				description:
					'Update entry metadata fields. Automatically bumps updatedAt.',
				input: Type.Object({
					id: Type.String({ description: 'Entry ID to update' }),
					title: Type.Optional(Type.String({ description: 'Entry title' })),
					subtitle: Type.Optional(
						Type.String({ description: 'Subtitle for blog listings' }),
					),
					type: Type.Optional(
						Type.Array(Type.String(), {
							description: 'Type classifications',
						}),
					),
					tags: Type.Optional(
						Type.Array(Type.String(), { description: 'Freeform tags' }),
					),
					rating: Type.Optional(
						Type.Number({ description: 'Rating from 0–5 (0 = unrated)' }),
					),
					date: Type.Optional(
						Type.Unsafe<DateTimeString>({
							type: 'string',
							description: 'User-defined date for the entry',
						}),
					),
				}),
				handler: ({ id, ...fields }) => {
					return tables.entries.update(id, {
						...fields,
						updatedAt: DateTimeString.now(),
					});
				},
			}),

			/**
			 * Soft-delete an entry by setting `deletedAt` to now.
			 *
			 * The entry stays in the CRDT for conflict safety—two devices that
			 * diverge can merge without data loss. Filtered out of active views
			 * by `deletedAt !== undefined`.
			 */
			delete: defineMutation({
				title: 'Delete Entry',
				description: 'Soft-delete an entry by setting deletedAt to now.',
				input: Type.Object({
					id: Type.String({ description: 'Entry ID to soft-delete' }),
				}),
				handler: ({ id }) => {
					return tables.entries.update(id, {
						deletedAt: DateTimeString.now(),
						updatedAt: DateTimeString.now(),
					});
				},
			}),
			/**
			 * Restore a soft-deleted entry by clearing `deletedAt`.
			 *
			 * Returns the entry to the active list. The entry retains all
			 * its content and metadata from before deletion.
			 */
			restore: defineMutation({
				title: 'Restore Entry',
				description: 'Restore a soft-deleted entry by clearing deletedAt.',
				input: Type.Object({
					id: Type.String({ description: 'Entry ID to restore' }),
				}),
				handler: ({ id }) => {
					return tables.entries.update(id, {
						deletedAt: undefined,
						updatedAt: DateTimeString.now(),
					});
				},
			}),
			/**
			 * Bulk-create entries from pre-parsed data.
			 *
			 * Each item needs a title and an ISO date string. Generates IDs
			 * and timestamps, then writes all rows in a single `bulkSet` call.
			 */
			bulkCreate: defineMutation({
				title: 'Bulk Create Entries',
				description: 'Create multiple entries at once from title + date pairs.',
				input: Type.Object({
					entries: Type.Array(
						Type.Object({
							title: Type.String({ description: 'Entry title' }),
							date: Type.String({
								description:
									'ISO date string in workspace DateTimeString format',
							}),
						}),
					),
				}),
				handler: ({ entries: items }) => {
					const now = DateTimeString.now();
					const rows = items.map(({ title, date }) => ({
						id: generateId() as EntryId,
						title,
						subtitle: '',
						type: [] as string[],
						tags: [] as string[],
						pinned: false,
						rating: 0,
						deletedAt: undefined,
						date: date as DateTimeString,
						createdAt: now,
						updatedAt: now,
						_v: 2 as const,
					}));
					tables.entries.bulkSet(rows);
					return { count: rows.length };
				},
			}),
		},
	}));
}
