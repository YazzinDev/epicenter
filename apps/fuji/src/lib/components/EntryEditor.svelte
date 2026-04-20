<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { confirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import {
		localTimezone,
		NaturalLanguageDateInput,
		toDateTimeString,
	} from '@epicenter/ui/natural-language-date-input';
	import * as Popover from '@epicenter/ui/popover';
	import * as StarRating from '@epicenter/ui/star-rating';
	import { TimezoneCombobox } from '@epicenter/ui/timezone-combobox';
	import { Spinner } from '@epicenter/ui/spinner';
	import { DateTimeString } from '@epicenter/workspace';
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';
	import Trash2Icon from '@lucide/svelte/icons/trash-2';
	import { format } from 'date-fns';
	import type { RichTextHandle } from '@epicenter/workspace';
	import { goto } from '$app/navigation';
	import { workspace } from '$lib/client';
	import type { Entry } from '$lib/workspace';
	import ProseMirrorEditor from './ProseMirrorEditor.svelte';
	import TagInput from './TagInput.svelte';

	let { entry }: { entry: Entry } = $props();

	function updateEntry(
		updates: Partial<{
			title: string;
			subtitle: string;
			type: string[];
			tags: string[];
			date: DateTimeString;
			rating: number;
		}>,
	) {
		workspace.actions.entries.update({ id: entry.id, ...updates });
	}

	// Stable for this component's lifetime — parent uses {#key entryId}
	// to remount on navigation, so entry.id never changes within an instance.
	const id = entry.id;

	let richTextContent = $state<RichTextHandle | null>(null);

	$effect(() => {
		let cancelled = false;
		workspace.documents.entries.content.open(id).then((openedContent) => {
			if (cancelled) {
				workspace.documents.entries.content.close(id);
				return;
			}
			richTextContent = openedContent;
		});

		return () => {
			cancelled = true;
			if (richTextContent) {
				workspace.documents.entries.content.close(id);
			}
			richTextContent = null;
		};
	});

	let wordCount = $state(0);
	let isDatePopoverOpen = $state(false);
	let dateTz = $state(localTimezone());
</script>

<div class="flex h-full flex-col">
	<!-- Header with back button -->
	<div class="flex items-center justify-between border-b px-4 py-2">
		<div class="flex items-center gap-2">
			<Button variant="ghost" size="icon-sm" onclick={() => goto('/')}>
				<ArrowLeftIcon class="size-4" />
			</Button>
			<span class="text-sm text-muted-foreground">Back to entries</span>
		</div>
		<Button
			variant="ghost-destructive"
			size="icon-sm"
			onclick={() => {
				confirmationDialog.open({
					title: 'Delete entry?',
					description: `"${entry.title || 'Untitled'}" will be moved to recently deleted.`,
					confirm: { text: 'Delete', variant: 'destructive' },
					onConfirm: () => {
						workspace.actions.entries.delete({ id: entry.id });
						goto('/');
					},
				});
			}}
		>
			<Trash2Icon class="size-4" />
		</Button>
	</div>

	<!-- Entry metadata -->
	<div class="flex flex-col gap-3 border-b px-6 py-4">
		<input
			type="text"
			class="w-full bg-transparent text-lg font-semibold outline-none placeholder:text-muted-foreground"
			placeholder="Entry title"
			value={entry.title}
			oninput={(e) => updateEntry({ title: e.currentTarget.value })}
		>
		<input
			type="text"
			class="w-full bg-transparent text-sm text-muted-foreground outline-none placeholder:text-muted-foreground/60"
			placeholder="Subtitle — a one-liner for your blog listing"
			value={entry.subtitle}
			oninput={(e) => updateEntry({ subtitle: e.currentTarget.value })}
		>

		<div class="flex flex-wrap items-center gap-4">
			<div class="flex items-center gap-2">
				<span class="text-xs font-medium text-muted-foreground">Type</span>
				<TagInput
					values={entry.type}
					placeholder="Add type…"
					onAdd={(value) =>
						updateEntry({ type: [...entry.type, value] })}
					onRemove={(value) =>
						updateEntry({
							type: entry.type.filter((t) => t !== value),
						})}
				/>
			</div>

			<div class="flex items-center gap-2">
				<span class="text-xs font-medium text-muted-foreground">Tags</span>
				<TagInput
					values={entry.tags}
					placeholder="Add tag…"
					onAdd={(value) =>
						updateEntry({ tags: [...entry.tags, value] })}
					onRemove={(value) =>
						updateEntry({
							tags: entry.tags.filter((t) => t !== value),
						})}
				/>
			</div>

			<div class="flex items-center gap-2">
				<span class="text-xs font-medium text-muted-foreground">Date</span>
				<Popover.Root bind:open={isDatePopoverOpen}>
					<Popover.Trigger>
						{#snippet child({ props })}
							<button
								{...props}
								type="button"
								class="cursor-pointer rounded-md border bg-background px-2.5 py-1 text-sm transition hover:bg-accent"
							>
								{format(DateTimeString.toDate(entry.date), 'MMM d, yyyy · h:mm a')}
							</button>
						{/snippet}
					</Popover.Trigger>
					<Popover.Content
						side="bottom"
						align="start"
						class="w-80 space-y-3 p-3"
					>
						<NaturalLanguageDateInput
							onChoice={({ date }) => {
								updateEntry({ date: toDateTimeString(date, dateTz) });
								isDatePopoverOpen = false;
							}}
						/>
						<TimezoneCombobox bind:value={dateTz} />
					</Popover.Content>
				</Popover.Root>
			</div>

			<div class="flex items-center gap-2">
				<span class="text-xs font-medium text-muted-foreground">Rating</span>
				<StarRating.Root
					value={entry.rating}
					onValueChange={(value) => updateEntry({ rating: value })}
				/>
			</div>
		</div>
	</div>

	<!-- Editor body -->
	{#if richTextContent}
		<ProseMirrorEditor
			yxmlfragment={richTextContent.binding}
			onWordCountChange={(count) => (wordCount = count)}
		/>
	{:else}
		<div class="flex flex-1 items-center justify-center">
			<Spinner class="size-5 text-muted-foreground" />
		</div>
	{/if}

	<!-- Status bar -->
	<div
		class="flex items-center justify-between border-t px-4 py-1.5 text-xs text-muted-foreground"
	>
		<span>{wordCount} {wordCount === 1 ? 'word' : 'words'}</span>
		<div class="flex items-center gap-3">
			<span
				>Created
				{format(DateTimeString.toDate(entry.createdAt), 'MMM d, yyyy · h:mm a')}</span
			>
			<span
				>Updated
				{format(DateTimeString.toDate(entry.updatedAt), 'MMM d, yyyy · h:mm a')}</span
			>
		</div>
	</div>
</div>
