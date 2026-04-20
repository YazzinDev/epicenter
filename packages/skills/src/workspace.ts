/**
 * @fileoverview Isomorphic workspace factory for agent skills.
 *
 * `createSkillsWorkspace()` returns a workspace client with read actions
 * for progressive skill disclosure (catalog → instructions → resources).
 * This is safe to import in any runtime (browser, Node, Bun).
 *
 * For disk I/O actions (importFromDisk, exportToDisk), import from
 * `@epicenter/skills/node` instead—that subpath re-exports a pre-built
 * `createSkillsWorkspace()` with server-side actions attached.
 *
 * @module
 */

import { createWorkspace, defineQuery } from '@epicenter/workspace';
import Type from 'typebox';
import { skillsDefinition } from './definition.js';

export { skillsDefinition } from './definition.js';

/**
 * Create an isomorphic skills workspace client with read actions.
 *
 * Returns a non-terminal builder—chain `.withExtension()` to add persistence,
 * sync, or other capabilities. Chain `.withActions()` to attach custom actions.
 *
 * Includes three read actions for progressive skill disclosure:
 * - `listSkills()` — catalog entries (cheap, no docs opened)
 * - `getSkill({ id })` — metadata + instructions (opens one Y.Doc)
 * - `getSkillWithReferences({ id })` — full skill with all references (opens 1 + N Y.Docs)
 *
 * For a pre-built workspace with disk I/O actions, import from
 * `@epicenter/skills/disk` instead.
 *
 * @example Browser — with read actions
 * ```typescript
 * import { createSkillsWorkspace } from '@epicenter/skills'
 *
 * const ws = createSkillsWorkspace()
 *   .withExtension('persistence', indexeddbPersistence)
 *
 * const skills = ws.actions.listSkills()
 * const result = await ws.actions.getSkill({ id: 'abc123' })
 * if (result) systemPrompt += result.instructions
 * ```
 *
 * @example Server — with disk I/O (use the /node subpath)
 * ```typescript
 * import { createSkillsWorkspace } from '@epicenter/skills/node'
 *
 * const ws = createSkillsWorkspace()
 *   .withExtension('persistence', indexeddbPersistence)
 *
 * await ws.actions.importFromDisk({ dir: '.agents/skills' })
 * ```
 */
export function createSkillsWorkspace() {
	return createWorkspace(skillsDefinition).withActions((client) => ({
		/**
		 * List all skills as lightweight catalog entries.
		 *
		 * Returns id, name, and description for every valid skill row.
		 * No documents are opened—this is cheap enough to call on every
		 * render cycle or at agent session startup.
		 *
		 * Mirrors tier 1 (Catalog) of the agentskills.io progressive
		 * disclosure model: ~50–100 tokens per skill.
		 */
		listSkills: defineQuery({
			description: 'List all skills (id, name, description)',
			handler: () =>
				client.tables.skills
					.getAllValid()
					.map((s) => ({ id: s.id, name: s.name, description: s.description }))
					.sort((a, b) => a.name.localeCompare(b.name)),
		}),

		/**
		 * Get a single skill's metadata and instructions.
		 *
		 * Opens the skill's instructions document (one Y.Doc) and reads
		 * the full markdown content. Returns the skill row alongside the
		 * instructions text—callers almost always need both.
		 *
		 * Mirrors tier 2 (Instructions) of the agentskills.io progressive
		 * disclosure model: <5000 tokens recommended.
		 */
		getSkill: defineQuery({
			description: 'Get skill metadata and instructions by ID',
			input: Type.Object({ id: Type.String() }),
			handler: async ({ id }) => {
				const skill = client.tables.skills.find((s) => s.id === id);
				if (!skill) return null;
				const content = await client.documents.skills.instructions.open(id);
				return { skill, instructions: content.read() };
			},
		}),

		/**
		 * Get a skill with its full instructions and all reference content.
		 *
		 * Opens the instructions document plus one content document per
		 * reference—expensive for skills with many references. Use this
		 * at agent prompt assembly time when the full skill context is
		 * needed, not for catalog browsing.
		 *
		 * Mirrors tier 3 (Resources) of the agentskills.io progressive
		 * disclosure model.
		 */
		getSkillWithReferences: defineQuery({
			description: 'Get skill with instructions and all reference content',
			input: Type.Object({ id: Type.String() }),
			handler: async ({ id }) => {
				const skill = client.tables.skills.find((s) => s.id === id);
				if (!skill) return null;
				const instructionsContent =
					await client.documents.skills.instructions.open(id);
				const refs = client.tables.references.filter((r) => r.skillId === id);
				const references = await Promise.all(
					refs.map(async (ref) => {
						const refContent =
							await client.documents.references.content.open(ref.id);
						return { path: ref.path, content: refContent.read() };
					}),
				);
				return {
					skill,
					instructions: instructionsContent.read(),
					references: references.sort((a, b) => a.path.localeCompare(b.path)),
				};
			},
		}),
	}));
}
