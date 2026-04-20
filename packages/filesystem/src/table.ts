import {
	defineTable,
	type InferTableRow,
	timeline,
} from '@epicenter/workspace';
import { type } from 'arktype';
import { FileId } from './ids.js';

export const filesTable = defineTable(
	type({
		id: FileId,
		name: 'string',
		parentId: FileId.or(type.null),
		type: "'file' | 'folder'",
		size: 'number',
		createdAt: 'number',
		updatedAt: 'number',
		trashedAt: 'number | null',
		_v: '1',
	}),
).withDocument('content', {
	content: timeline,
	guid: 'id',
	onUpdate: () => ({ updatedAt: Date.now() }),
});

/** File metadata row derived from the files table definition */
export type FileRow = InferTableRow<typeof filesTable>;

/**
 * Column definition stored in a column Y.Map.
 *
 * This type documents the expected shape but cannot be enforced at runtime
 * since Y.Maps are dynamic key-value stores. Use defensive reading with
 * defaults when accessing column properties.
 */
export type ColumnDefinition = {
	/** Display name of the column */
	name: string;
	/** Column kind determines cell value interpretation */
	kind: 'text' | 'number' | 'date' | 'select' | 'boolean';
	/** Display width in pixels (stored as string) */
	width: string;
	/** Fractional index for column ordering */
	order: string;
};
