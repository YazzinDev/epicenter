import { YAML } from 'bun';
import { convertEpicenterLinksToWikilinks } from '../../../links.js';

/**
 * Assemble a markdown string from YAML frontmatter and an optional body.
 *
 * When a body is provided, epicenter links are automatically converted to
 * wikilinks before serialization.
 *
 * Pure function — no I/O. Uses `Bun.YAML.stringify` for spec-compliant
 * serialization (handles quoting of booleans, numeric strings, special
 * characters, newlines, etc.). Undefined frontmatter values are stripped
 * (missing key); null values are preserved (YAML `null`) so nullable
 * fields survive a future round-trip.
 */
export function toMarkdown(
	frontmatter: Record<string, unknown>,
	body?: string,
): string {
	const cleaned: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(frontmatter)) {
		if (value !== undefined) {
			cleaned[key] = value;
		}
	}
	const yaml = YAML.stringify(cleaned, null, 2);
	const yamlBlock = yaml.endsWith('\n') ? yaml : `${yaml}\n`;
	const convertedBody =
		body !== undefined ? convertEpicenterLinksToWikilinks(body) : undefined;
	return convertedBody !== undefined
		? `---\n${yamlBlock}---\n\n${convertedBody}\n`
		: `---\n${yamlBlock}---\n`;
}

export type SerializeResult = {
	filename: string;
	content: string;
};
