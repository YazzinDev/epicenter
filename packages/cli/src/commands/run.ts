/**
 * `epicenter run <action> [--args]` — invoke a workspace action by dot-path.
 *
 * Finds the action using `iterateActions()`, converts its TypeBox input schema
 * to CLI flags via `typeboxToYargsOptions()`, calls the action, and outputs
 * the result.
 */

import type { Action, Actions } from '@epicenter/workspace';
import { iterateActions } from '@epicenter/workspace';
import type { Argv } from 'yargs';
import {
	defineCommand,
	runCommand,
	withWorkspaceOptions,
} from '../util/command';
import { typeboxToYargsOptions } from '../util/typebox-to-yargs';

/**
 * @example
 * ```bash
 * epicenter run posts.getAll
 * epicenter run posts.create --title "Hello World"
 * epicenter run posts.create --title "Hi" -w my-blog
 * ```
 */
export const runActionCommand = defineCommand({
	command: 'run <action>',
	describe: 'Invoke a workspace action by dot-path',
	builder: (y: Argv) =>
		withWorkspaceOptions(y)
			.positional('action', {
				type: 'string',
				demandOption: true,
				describe: 'Action path in dot notation (e.g. posts.create)',
			})
			.strict(false),
	handler: async (argv: any) => {
		const actionPath = (argv.action as string).split('.');

		await runCommand(
			{ dir: argv.dir, workspaceId: argv.workspace },
			async (client) => {
				// Find action by dot-path — check client.actions first, then extensions
				let found: Action | undefined;
				if (client.actions) {
					for (const [action, path] of iterateActions(client.actions)) {
						if (path.join('.') === actionPath.join('.')) {
							found = action;
							break;
						}
					}
				}

				// Fall through to extensions if not found in actions
				if (!found && client.extensions) {
					for (const [extKey, extValue] of Object.entries(client.extensions)) {
						if (extValue == null || typeof extValue !== 'object') continue;
						for (const [action, path] of iterateActions(extValue as Actions)) {
							const extPath = [extKey, ...path].join('.');
							if (extPath === actionPath.join('.')) {
								found = action;
								break;
							}
						}
						if (found) break;
					}
				}

				if (!found) {
					const available: string[] = [];
					if (client.actions) {
						for (const [, path] of iterateActions(client.actions)) {
							available.push(path.join('.'));
						}
					}
					if (client.extensions) {
						for (const [extKey, extValue] of Object.entries(client.extensions)) {
							if (extValue == null || typeof extValue !== 'object') continue;
							for (const [, path] of iterateActions(extValue as Actions)) {
								available.push([extKey, ...path].join('.'));
							}
						}
					}
					const msg =
						available.length > 0
							? `Action "${argv.action}" not found. Available actions:\n  ${available.join('\n  ')}`
							: `Action "${argv.action}" not found. No actions defined in this workspace.`;
					throw new Error(msg);
				}

				// Build input from CLI args if action has input schema
				let input: Record<string, unknown> | undefined;
				if (found.input) {
					const yargsOpts = typeboxToYargsOptions(found.input);
					input = {};
					for (const key of Object.keys(yargsOpts)) {
						if (argv[key] !== undefined) {
							input[key] = argv[key];
						}
					}
				}

				if (input) {
					return await found(input);
				}
				return await (found as Action<undefined>)();
			},
			argv.format,
		);
	},
});
