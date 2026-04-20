import slugify from '@sindresorhus/slugify';
import filenamify from 'filenamify';
import { type SerializeResult, toMarkdown } from './markdown.js';

/** Max slug length before the ID suffix. */
const MAX_SLUG_LENGTH = 50;

/**
 * Build an ID-only filename: `{id}.md`.
 *
 * @example
 * ```typescript
 * toIdFilename('abc123') // 'abc123.md'
 * ```
 */
export function toIdFilename(id: string): string {
	return `${id}.md`;
}

/**
 * Build a human-readable filename: `{slugified-title}-{id}.md`.
 *
 * Falls back to `{id}.md` when the title is empty, undefined, or null.
 *
 * @example
 * ```typescript
 * toSlugFilename('GitHub PR Review', 'abc123')
 * // 'github-pr-review-abc123.md'
 *
 * toSlugFilename(undefined, 'abc123')
 * // 'abc123.md'
 * ```
 */
export function toSlugFilename(
	title: string | undefined | null,
	id: string,
): string {
	if (!title || title.trim().length === 0) {
		return toIdFilename(id);
	}

	const slug = slugify(title).slice(0, MAX_SLUG_LENGTH);
	const raw = slug ? `${slug}-${id}.md` : toIdFilename(id);
	return filenamify(raw, { replacement: '-' });
}

/**
 * Create a serializer that uses a row field to generate `{slug}-{id}.md` filenames.
 * All row fields are written to frontmatter.
 * @remarks Produces markdown output via toMarkdown() internally.
 */
export function slugFilename(
	fieldName: string,
): (row: Record<string, unknown>) => SerializeResult {
	return (row) => {
		const titleValue = row[fieldName];
		return {
			filename: toSlugFilename(
				typeof titleValue === 'string' ? titleValue : undefined,
				String(row.id),
			),
			content: toMarkdown({ ...row }),
		};
	};
}

/**
 * Create a serializer that moves one field into the markdown body and keeps the
 * remaining row fields in frontmatter.
 *
 * @remarks Produces markdown output via toMarkdown() internally.
 */
export function bodyField(
	fieldName: string,
): (row: Record<string, unknown>) => SerializeResult {
	return (row) => {
		const { [fieldName]: bodyValue, ...frontmatter } = row;

		return {
			filename: toIdFilename(String(row.id)),
			content: toMarkdown(
				frontmatter,
				bodyValue !== undefined && bodyValue !== null
					? String(bodyValue)
					: undefined,
			),
		};
	};
}
