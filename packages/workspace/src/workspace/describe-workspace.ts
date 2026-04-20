/**
 * Workspace introspection — produces a portable, JSON-serializable descriptor
 * of a workspace's tables, KV stores, awareness fields, and actions.
 *
 * Generic tools (editors, MCP clients, data browsers, plugin systems) can
 * consume this descriptor to discover and interact with arbitrary workspaces
 * they have no compile-time knowledge of.
 *
 * @example
 * ```typescript
 * import { describeWorkspace } from '@epicenter/workspace';
 *
 * const descriptor = describeWorkspace(client);
 * console.log(JSON.stringify(descriptor, null, 2));
 * // {
 * //   id: "epicenter.whispering",
 * //   tables: { recordings: { schema: { type: "object", ... } } },
 * //   kv: { settings: { schema: { ... } } },
 * //   awareness: {},
 * //   actions: [
 * //     { path: ["recordings", "create"], type: "mutation", description: "..." },
 * //   ]
 * // }
 * ```
 */

import type { StandardJSONSchemaV1 } from '@standard-schema/spec';
import type { TSchema } from 'typebox';
import { type Actions, iterateActions } from '../shared/actions.js';
import { standardSchemaToJsonSchema } from '../shared/standard-schema.js';
import type { AnyWorkspaceClient } from './types.js';

// ════════════════════════════════════════════════════════════════════════════
// DESCRIPTOR TYPES
// ════════════════════════════════════════════════════════════════════════════

/** Descriptor for a schema-bearing definition (table, KV store, or awareness field). */
export type SchemaDescriptor = {
	schema: Record<string, unknown>;
};

/** Descriptor for a single action (query or mutation). */
export type ActionDescriptor = {
	path: string[];
	type: 'query' | 'mutation';
	title?: string;
	description?: string;
	input?: TSchema;
};

/**
 * A portable, JSON-serializable descriptor of a workspace.
 *
 * Every schema field is guaranteed to be a JSON Schema object (never undefined) —
 * the `CombinedStandardSchema` type constraint on definitions ensures this.
 * Action inputs are optional since some actions have no input.
 */
export type WorkspaceDescriptor = {
	id: string;
	tables: Record<string, SchemaDescriptor>;
	kv: Record<string, SchemaDescriptor>;
	awareness: Record<string, SchemaDescriptor>;
	actions: ActionDescriptor[];
	extensions: Record<string, ActionDescriptor[]>;
};

// ════════════════════════════════════════════════════════════════════════════
// IMPLEMENTATION
// ════════════════════════════════════════════════════════════════════════════

/** Convert a record of Standard Schema entries into a record of JSON Schema descriptors. */
function describeSchemas(
	entries: Record<
		string,
		StandardJSONSchemaV1 | { schema: StandardJSONSchemaV1 }
	>,
): Record<string, SchemaDescriptor> {
	return Object.fromEntries(
		Object.entries(entries).map(([name, entry]) => [
			name,
			{
				schema: standardSchemaToJsonSchema(
					'schema' in entry ? entry.schema : entry,
				),
			},
		]),
	);
}

/** Walk an action tree and return an array of action descriptors. */
function collectActionDescriptors(actions: Actions): ActionDescriptor[] {
	const result: ActionDescriptor[] = [];
	for (const [action, path] of iterateActions(actions)) {
		result.push({
			path,
			type: action.type,
			...(action.title !== undefined && { title: action.title }),
			...(action.description !== undefined && {
				description: action.description,
			}),
			...(action.input !== undefined && { input: action.input }),
		});
	}
	return result;
}

/**
 * Produce a portable, JSON-serializable descriptor of a workspace.
 *
 * Walks `definitions.tables`, `definitions.kv`, `definitions.awareness`,
 * and `client.actions` to extract JSON Schema representations of all data shapes.
 *
 * @param client - Any workspace client (typed or untyped)
 * @returns A `WorkspaceDescriptor` that can be safely `JSON.stringify`'d
 *
 * @example
 * ```typescript
 * const descriptor = describeWorkspace(client);
 *
 * // List all table names
 * Object.keys(descriptor.tables); // ['recordings', 'transformations']
 *
 * // Get the JSON Schema for a table
 * descriptor.tables.recordings.schema; // { type: 'object', properties: { ... } }
 *
 * // Iterate actions
 * for (const action of descriptor.actions) {
 *   console.log(action.path.join('.'), action.type);
 * }
 * ```
 */
export function describeWorkspace(
	client: AnyWorkspaceClient,
): WorkspaceDescriptor {
	const actions: ActionDescriptor[] = client.actions
		? collectActionDescriptors(client.actions)
		: [];

	const extensions: Record<string, ActionDescriptor[]> = {};
	if (client.extensions) {
		for (const [extKey, extValue] of Object.entries(client.extensions)) {
			if (extValue == null || typeof extValue !== 'object' || Array.isArray(extValue)) continue;
			const extActions = collectActionDescriptors(extValue as Actions);
			if (extActions.length > 0) {
				extensions[extKey] = extActions;
			}
		}
	}

	return {
		id: client.id,
		tables: describeSchemas(client.definitions.tables),
		kv: describeSchemas(client.definitions.kv),
		awareness: describeSchemas(client.definitions.awareness),
		actions,
		extensions,
	};
}
