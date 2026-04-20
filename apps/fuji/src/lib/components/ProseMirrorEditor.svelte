<script lang="ts">
	import { baseKeymap, toggleMark } from 'prosemirror-commands';
	import {
		inputRules,
		wrappingInputRule,
		textblockTypeInputRule,
		smartQuotes,
		emDash,
		ellipsis,
	} from 'prosemirror-inputrules';
	import { keymap } from 'prosemirror-keymap';
	import { Schema, type MarkSpec } from 'prosemirror-model';
	import {
		addListNodes,
		splitListItem,
		liftListItem,
		sinkListItem,
	} from 'prosemirror-schema-list';
	import { schema as basicSchema } from 'prosemirror-schema-basic';
	import { EditorState, Plugin } from 'prosemirror-state';
	import { Decoration, DecorationSet, EditorView } from 'prosemirror-view';
	import 'prosemirror-view/style/prosemirror.css';
	import { ySyncPlugin, yUndoPlugin, undo, redo } from 'y-prosemirror';
	import type * as Y from 'yjs';

	let {
		yxmlfragment,
		placeholder = 'Start writing…',
		onWordCountChange,
	}: {
		yxmlfragment: Y.XmlFragment;
		placeholder?: string;
		onWordCountChange?: (count: number) => void;
	} = $props();

	let element: HTMLDivElement | undefined = $state();

	// ─── Schema ──────────────────────────────────────────────────────────────

	const extraMarks = {
		strikethrough: {
			parseDOM: [
				{ tag: 's' },
				{ tag: 'del' },
				{ style: 'text-decoration=line-through' },
			],
			toDOM() {
				return ['s', 0];
			},
		},
		underline: {
			parseDOM: [{ tag: 'u' }, { style: 'text-decoration=underline' }],
			toDOM() {
				return ['u', 0];
			},
		},
	} satisfies Record<string, MarkSpec>;

	const schema = new Schema({
		nodes: addListNodes(basicSchema.spec.nodes, 'paragraph block*', 'block'),
		marks: basicSchema.spec.marks.append(extraMarks),
	});

	// ─── Plugins ─────────────────────────────────────────────────────────────

	function countWords(text: string): number {
		const trimmed = text.trim();
		if (!trimmed) return 0;
		return trimmed.split(/\s+/).length;
	}

	function createWordCountPlugin() {
		return new Plugin({
			view() {
				return {
					update(view) {
						onWordCountChange?.(countWords(view.state.doc.textContent));
					},
				};
			},
		});
	}

	function createPlaceholderPlugin(text: string) {
		return new Plugin({
			props: {
				decorations(state) {
					const { doc } = state;
					if (
						doc.childCount === 1 &&
						doc.firstChild?.isTextblock &&
						doc.firstChild.content.size === 0
					) {
						return DecorationSet.create(doc, [
							Decoration.node(0, doc.firstChild.nodeSize, {
								class: 'is-editor-empty',
								'data-placeholder': text,
							}),
						]);
					}
					return DecorationSet.empty;
				},
			},
		});
	}

	// ─── Editor lifecycle ────────────────────────────────────────────────────

	$effect(() => {
		if (!element) return;

		const view = new EditorView(element, {
			state: EditorState.create({
				schema,
				plugins: [
					ySyncPlugin(yxmlfragment),
					yUndoPlugin(),
					createPlaceholderPlugin(placeholder),
					keymap({
						'Mod-z': undo,
						'Mod-y': redo,
						'Mod-Shift-z': redo,
						'Mod-b': toggleMark(schema.marks.strong!),
						'Mod-i': toggleMark(schema.marks.em!),
						'Mod-u': toggleMark(schema.marks.underline!),
						'Mod-Shift-s': toggleMark(schema.marks.strikethrough!),
						Enter: splitListItem(schema.nodes.list_item!),
						'Mod-]': sinkListItem(schema.nodes.list_item!),
						Tab: sinkListItem(schema.nodes.list_item!),
						'Mod-[': liftListItem(schema.nodes.list_item!),
						'Shift-Tab': liftListItem(schema.nodes.list_item!),
					}),
					keymap(baseKeymap),
					inputRules({
						rules: [
							...smartQuotes,
							emDash,
							ellipsis,
							textblockTypeInputRule(
								/^(#{1,3})\s$/,
								schema.nodes.heading!,
								(match) => ({ level: match[1]!.length }),
							),
							wrappingInputRule(/^\s*([-+*])\s$/, schema.nodes.bullet_list!),
							wrappingInputRule(
								/^(\d+)\.\s$/,
								schema.nodes.ordered_list!,
								(match) => ({ order: +match[1]! }),
								(match, node) =>
									node.childCount + node.attrs.order === +match[1]!,
							),
							wrappingInputRule(/^\s*>\s$/, schema.nodes.blockquote!),
							textblockTypeInputRule(/^```$/, schema.nodes.code_block!),
						],
					}),
					createWordCountPlugin(),
				],
			}),
			attributes: {
				class:
					'prose prose-sm dark:prose-invert max-w-none focus:outline-none min-h-full',
			},
		});

		return () => view.destroy();
	});
</script>

<div bind:this={element} class="flex-1 overflow-y-auto px-6 py-4"></div>

<style>
	:global(.ProseMirror) {
		min-height: 100%;
	}
	:global(.ProseMirror p.is-editor-empty:first-child::before) {
		color: hsl(var(--muted-foreground));
		content: attr(data-placeholder);
		float: left;
		height: 0;
		pointer-events: none;
	}
</style>
