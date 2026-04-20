<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Empty from '@epicenter/ui/empty';
	import { DateTimeString } from '@epicenter/workspace';
	import ClockIcon from '@lucide/svelte/icons/clock';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import TableIcon from '@lucide/svelte/icons/table-2';
	import { createTable as createSvelteTable } from '@tanstack/svelte-table';
	import type { ColumnDef, SortingState } from '@tanstack/table-core';
	import {
		getCoreRowModel,
		getFilteredRowModel,
		getSortedRowModel,
	} from '@tanstack/table-core';
	import { format, isToday, isYesterday } from 'date-fns';
	import { VList } from 'virtua/svelte';
	import { goto } from '$app/navigation';
	import { entriesState, matchesEntrySearch } from '$lib/entries-state.svelte';
	import { viewState } from '$lib/view-state.svelte';
	import type { Entry } from '$lib/workspace';

	let { entries, title }: { entries: Entry[]; title?: string } = $props();

	// ─── TanStack Table (sort + filter model) ──────────────────────────────

	const columns = [
		{ id: 'title', accessorKey: 'title' },
		{ id: 'rating', accessorKey: 'rating' },
		{ id: 'date', accessorKey: 'date' },
		{ id: 'createdAt', accessorKey: 'createdAt' },
		{ id: 'updatedAt', accessorKey: 'updatedAt' },
	] satisfies ColumnDef<Entry>[];

	/** Multi-sort: non-date fields sort within date groups. */
	const sorting = $derived(
		(
			{
				date: [{ id: 'date', desc: true }],
				updatedAt: [{ id: 'updatedAt', desc: true }],
				createdAt: [{ id: 'createdAt', desc: true }],
				title: [
					{ id: 'date', desc: true },
					{ id: 'title', desc: false },
				],
				rating: [
					{ id: 'date', desc: true },
					{ id: 'rating', desc: true },
				],
			} satisfies Record<typeof viewState.sortBy, SortingState>
		)[viewState.sortBy],
	);

	const table = createSvelteTable({
		getRowId: (row) => row.id,
		get data() {
			return entries;
		},
		columns,
		getCoreRowModel: getCoreRowModel(),
		getSortedRowModel: getSortedRowModel(),
		getFilteredRowModel: getFilteredRowModel(),
		state: {
			get sorting() {
				return sorting;
			},
			get globalFilter() {
				return viewState.searchQuery;
			},
		},
		globalFilterFn: (row, _columnId, filterValue) => {
			return matchesEntrySearch(row.original, filterValue);
		},
	});

	// ─── Date grouping (presentation only) ──────────────────────────────────

	/** Which date field to use for timeline headers. */
	const groupField = $derived(
		(
			{
				date: 'date',
				updatedAt: 'updatedAt',
				createdAt: 'createdAt',
				title: 'date',
				rating: 'date',
			} satisfies Record<
				typeof viewState.sortBy,
				'date' | 'updatedAt' | 'createdAt'
			>
		)[viewState.sortBy],
	);

	function getDateLabel(dts: string): string {
		const date = DateTimeString.toDate(dts);
		if (isToday(date)) return 'Today';
		if (isYesterday(date)) return 'Yesterday';
		return format(date, 'MMMM d');
	}

	type TimelineDateHeader = { kind: 'date-header'; label: string };
	type TimelineEntry = { kind: 'entry'; entry: Entry };
	type TimelineItem = TimelineDateHeader | TimelineEntry;

	/** Sorted entries with date headers inserted for the timeline. */
	const flatItems = $derived.by((): TimelineItem[] => {
		const rows = table.getRowModel().rows;
		const field = groupField;
		const items: TimelineItem[] = [];
		let currentLabel = '';

		for (const row of rows) {
			const label = getDateLabel(row.original[field]);
			if (label !== currentLabel) {
				currentLabel = label;
				items.push({ kind: 'date-header', label });
			}
			items.push({ kind: 'entry', entry: row.original });
		}

		return items;
	});
</script>

<div class="flex min-h-0 flex-1 flex-col overflow-hidden">
	<!-- Header -->
	<div class="flex items-center justify-between px-4 py-2">
		<h2 class="text-sm font-semibold">{title ?? 'Timeline'}</h2>
		<div class="flex items-center gap-1">
			<Button
				variant="ghost"
				size="icon-sm"
				onclick={() => viewState.toggleViewMode()}
				title="Switch to table"
			>
				<TableIcon class="size-4" />
			</Button>
			<Button variant="ghost" size="icon-sm" onclick={entriesState.createEntry}>
				<PlusIcon class="size-4" />
			</Button>
		</div>
	</div>

	<!-- Timeline -->
	{#if table.getRowModel().rows.length === 0}
		<div class="flex-1 overflow-y-auto">
			<Empty.Root class="flex-1">
				<Empty.Media>
					<ClockIcon class="size-8 text-muted-foreground" />
				</Empty.Media>
				{#if viewState.searchQuery}
					<Empty.Title>No entries match your search</Empty.Title>
					<Empty.Description
						>Try a different search term or clear your filters.</Empty.Description
					>
				{:else}
					<Empty.Title>No entries yet</Empty.Title>
					<Empty.Description
						>Create your first entry to get started.</Empty.Description
					>
					<Empty.Content>
						<Button
							variant="outline"
							size="sm"
							onclick={entriesState.createEntry}
						>
							<PlusIcon class="mr-1.5 size-4" />
							New Entry
						</Button>
					</Empty.Content>
				{/if}
			</Empty.Root>
		</div>
	{:else}
		<VList
			data={flatItems}
			style="height: 100%; flex: 1;"
			getKey={(item) => item.kind === 'date-header' ? `header-${item.label}` : item.entry.id}
		>
			{#snippet children(item)}
				{#if item.kind === 'date-header'}
					<div class="sticky top-0 z-10 bg-background px-6 pb-1 pt-4">
						<h3 class="text-xs font-medium text-muted-foreground">
							{item.label}
						</h3>
					</div>
				{:else}
					<div
						role="button"
						tabindex="0"
						class="group mx-4 flex cursor-pointer flex-col gap-0.5 rounded-lg p-3 text-sm transition-colors hover:bg-accent/50"
						onclick={() => goto(`/entries/${item.entry.id}`)}
						onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); goto(`/entries/${item.entry.id}`); } }}
					>
						<div class="flex items-start justify-between gap-2">
							<span class="font-medium line-clamp-1">
								{item.entry.title || 'Untitled'}
							</span>
							<span class="shrink-0 text-xs text-muted-foreground">
								{format(DateTimeString.toDate(item.entry[groupField]), 'h:mm a')}
							</span>
						</div>
						{#if item.entry.subtitle}
							<p class="line-clamp-1 text-xs text-muted-foreground">
								{item.entry.subtitle}
							</p>
						{/if}
					</div>
				{/if}
			{/snippet}
		</VList>
	{/if}
</div>
