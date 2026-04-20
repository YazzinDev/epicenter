<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Empty from '@epicenter/ui/empty';
	import * as StarRating from '@epicenter/ui/star-rating';
	import * as Table from '@epicenter/ui/table';
	import { SortableTableHeader } from '@epicenter/ui/table';
	import ClockIcon from '@lucide/svelte/icons/clock';
	import FileTextIcon from '@lucide/svelte/icons/file-text';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import {
		createTable as createSvelteTable,
		FlexRender,
		renderComponent,
	} from '@tanstack/svelte-table';
	import type { ColumnDef, SortingState } from '@tanstack/table-core';
	import {
		getCoreRowModel,
		getFilteredRowModel,
		getSortedRowModel,
	} from '@tanstack/table-core';
	import { goto } from '$app/navigation';
	import { entriesState, matchesEntrySearch } from '$lib/entries-state.svelte';
	import { viewState } from '$lib/view-state.svelte';
	import { relativeTime } from '$lib/format';
	import type { Entry } from '$lib/workspace';
	import BadgeList from './BadgeList.svelte';

	let { entries, title }: { entries: Entry[]; title?: string } = $props();

	const columns = [
		{
			id: 'title',
			accessorKey: 'title',
			header: ({ column }) =>
				renderComponent(SortableTableHeader, {
					column,
					headerText: 'Title',
				}),
			cell: ({ getValue }) => {
				const title = getValue<string>();
				return title || 'Untitled';
			},
		},
		{
			id: 'subtitle',
			accessorKey: 'subtitle',
			header: ({ column }) =>
				renderComponent(SortableTableHeader, {
					column,
					headerText: 'Subtitle',
				}),
			cell: ({ getValue }) => {
				const subtitle = getValue<string>();
				return subtitle || '';
			},
		},
		{
			id: 'type',
			accessorKey: 'type',
			header: ({ column }) =>
				renderComponent(SortableTableHeader, {
					column,
					headerText: 'Type',
				}),
			cell: ({ getValue }) => {
				const types = getValue<string[]>();
				if (!types.length) return '';
				return renderComponent(BadgeList, { items: types });
			},
			enableSorting: false,
		},
		{
			id: 'tags',
			accessorKey: 'tags',
			header: ({ column }) =>
				renderComponent(SortableTableHeader, {
					column,
					headerText: 'Tags',
				}),
			cell: ({ getValue }) => {
				const tags = getValue<string[]>();
				if (!tags.length) return '';
				return renderComponent(BadgeList, { items: tags });
			},
			enableSorting: false,
		},
		{
			id: 'rating',
			accessorKey: 'rating',
			header: ({ column }) =>
				renderComponent(SortableTableHeader, {
					column,
					headerText: 'Rating',
				}),
			cell: ({ getValue }) => {
				const rating = getValue<number>();
				if (!rating) return '';
				return renderComponent(StarRating.Root, {
					value: rating,
					readonly: true,
					class: 'pointer-events-none',
				});
			},
		},
		{
			id: 'date',
			accessorKey: 'date',
			header: ({ column }) =>
				renderComponent(SortableTableHeader, {
					column,
					headerText: 'Date',
				}),
			cell: ({ getValue }) => relativeTime(getValue<string>()),
		},
		{
			id: 'createdAt',
			accessorKey: 'createdAt',
			header: ({ column }) =>
				renderComponent(SortableTableHeader, {
					column,
					headerText: 'Created',
				}),
			cell: ({ getValue }) => relativeTime(getValue<string>()),
		},
		{
			id: 'updatedAt',
			accessorKey: 'updatedAt',
			header: ({ column }) =>
				renderComponent(SortableTableHeader, {
					column,
					headerText: 'Updated',
				}),
			cell: ({ getValue }) => relativeTime(getValue<string>()),
		},
	] satisfies ColumnDef<Entry>[];

	const sorting = $derived<SortingState>([
		{ id: viewState.sortBy, desc: viewState.sortBy !== 'title' },
	]);

	const table = createSvelteTable({
		getRowId: (row) => row.id,
		get data() {
			return entries;
		},
		columns,
		getCoreRowModel: getCoreRowModel(),
		getSortedRowModel: getSortedRowModel(),
		getFilteredRowModel: getFilteredRowModel(),
		onSortingChange: (updater) => {
			const next = typeof updater === 'function' ? updater(sorting) : updater;
			const primary = next[0];
			if (primary) {
				viewState.sortBy = primary.id as typeof viewState.sortBy;
			}
		},
		state: {
			get sorting() {
				return sorting;
			},
			get globalFilter() {
				return viewState.searchQuery;
			},
			get columnVisibility() {
				return {
					subtitle: false,
					createdAt: false,
					updatedAt: false,
				};
			},
		},
		globalFilterFn: (row, _columnId, filterValue) => {
			return matchesEntrySearch(row.original, filterValue);
		},
	});
</script>

<div class="flex min-h-0 flex-1 flex-col overflow-hidden">
	<!-- Toolbar -->
	<div class="flex items-center justify-between px-4 py-2">
		<h2 class="text-sm font-semibold">{title ?? 'Entries'}</h2>
		<div class="flex items-center gap-1">
			<Button
				variant="ghost"
				size="icon-sm"
				onclick={() => viewState.toggleViewMode()}
				title="Switch to timeline"
			>
				<ClockIcon class="size-4" />
			</Button>
			<Button variant="ghost" size="icon-sm" onclick={entriesState.createEntry}>
				<PlusIcon class="size-4" />
			</Button>
		</div>
	</div>

	<!-- Table -->
	<div class="flex-1 overflow-auto">
		<Table.Root
			class="[&_th:first-child]:pl-4 [&_td:first-child]:pl-4 [&_th:last-child]:pr-4 [&_td:last-child]:pr-4"
		>
			<Table.Header>
				{#each table.getHeaderGroups() as headerGroup}
					<Table.Row>
						{#each headerGroup.headers as header}
							<Table.Head colspan={header.colSpan}>
								{#if !header.isPlaceholder}
									<FlexRender
										content={header.column.columnDef.header}
										context={header.getContext()}
									/>
								{/if}
							</Table.Head>
						{/each}
					</Table.Row>
				{/each}
			</Table.Header>
			<Table.Body>
				{#if table.getRowModel().rows?.length}
					{#each table.getRowModel().rows as row (row.id)}
					<Table.Row
						role="button"
						tabindex="0"
						class="cursor-pointer transition-colors hover:bg-accent/50"
						onclick={() => goto(`/entries/${row.original.id}`)}
						onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); goto(`/entries/${row.original.id}`); } }}
					>
							{#each row.getVisibleCells() as cell}
								<Table.Cell
									class={cell.column.id === 'title' ? 'max-w-[400px] truncate' : ''}
								>
									<FlexRender
										content={cell.column.columnDef.cell}
										context={cell.getContext()}
									/>
								</Table.Cell>
							{/each}
						</Table.Row>
					{/each}
				{:else}
					<Table.Row>
						<Table.Cell colspan={columns.length}>
							<Empty.Root class="min-h-[50vh]">
								<Empty.Media>
									<FileTextIcon class="size-8 text-muted-foreground" />
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
						</Table.Cell>
					</Table.Row>
				{/if}
			</Table.Body>
		</Table.Root>
	</div>
</div>
