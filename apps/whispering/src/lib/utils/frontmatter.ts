import * as yaml from 'js-yaml';

/**
 * Parse frontmatter from markdown content.
 *
 * Extracts YAML frontmatter delimited by `---` at the start of content
 * and returns both the parsed data object and the remaining markdown body.
 * Matches gray-matter's return shape for drop-in compatibility.
 *
 * @param content - The full markdown content with optional frontmatter
 * @returns An object with `data` (parsed YAML object) and `content` (markdown body)
 *
 * @example
 * ```typescript
 * const result = parseFrontmatter('---\ntitle: Hello\n---\n# Body');
 * console.log(result.data); // { title: 'Hello' }
 * console.log(result.content); // '# Body'
 * ```
 *
 * @example
 * ```typescript
 * // Content without frontmatter
 * const result = parseFrontmatter('# Just markdown');
 * console.log(result.data); // {}
 * console.log(result.content); // '# Just markdown'
 * ```
 */
export function parseFrontmatter(content: string): {
	data: Record<string, unknown>;
	content: string;
} {
	const frontmatterRegex = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/;
	const match = content.match(frontmatterRegex);

	if (!match) {
		return { data: {}, content };
	}

	const frontmatterStr = match[1] ?? '';
	const body = match[2] ?? '';

	try {
		const data = (yaml.load(frontmatterStr) as Record<string, unknown>) ?? {};
		return { data, content: body };
	} catch {
		return { data: {}, content };
	}
}

/**
 * Stringify markdown content with YAML frontmatter.
 *
 * Combines a markdown body with a data object, serializing the data as YAML
 * frontmatter delimited by `---`. Matches gray-matter's stringify signature
 * for drop-in compatibility.
 *
 * @param body - The markdown body content
 * @param data - The data object to serialize as YAML frontmatter
 * @returns A string with YAML frontmatter format: `---\n{yaml}\n---\n{body}\n`
 *
 * @example
 * ```typescript
 * const result = stringifyFrontmatter('# Hello', { title: 'My Post' });
 * console.log(result);
 * // ---
 * // title: My Post
 * // ---
 * // # Hello
 * ```
 *
 * @example
 * ```typescript
 * // Empty body is valid
 * const result = stringifyFrontmatter('', { title: 'Draft' });
 * console.log(result);
 * // ---
 * // title: Draft
 * // ---
 * //
 * ```
 */
export function stringifyFrontmatter(
	body: string,
	data: Record<string, unknown>,
): string {
	const yamlStr = yaml.dump(data, { lineWidth: -1 }).trimEnd();
	return `---\n${yamlStr}\n---\n${body}\n`;
}
