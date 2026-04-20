<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Card from '@epicenter/ui/card';
	import { Badge } from '@epicenter/ui/badge';
	import { workspace } from '$lib/client';
	import { entriesState } from '$lib/entries-state.svelte';
	import { generateId, DateTimeString } from '@epicenter/workspace';
	import type { EntryId } from '$lib/workspace';
	import * as Y from 'yjs';
	import { toast } from 'svelte-sonner';

	// ─── Config ──────────────────────────────────────────────────────────────────

	const COUNTS = [1_000, 10_000] as const;

	/**
	 * Small chunk size for bulkSet so the browser event loop yields between
	 * chunks, giving Svelte a chance to re-render the progress bar.
	 */
	const INSERT_CHUNK_SIZE = 100;

	const TITLES = [
		'Morning Reflections',
		'Project Update',
		'Book Notes',
		'Meeting Summary',
		'Travel Plans',
		'Recipe Ideas',
		'Code Review Notes',
		'Design Critique',
		'Weekly Goals',
		'Research Findings',
		'Product Roadmap',
		'Bug Report',
		'Feature Request',
		'Architecture Decision',
		'Performance Analysis',
		'User Feedback',
		'Sprint Retrospective',
		'Technical Debt',
		'API Design',
		'Database Schema',
		'Security Audit',
		'Deployment Checklist',
		'Onboarding Guide',
		'Style Guide',
		'Release Notes',
		'Changelog',
		'Migration Plan',
		'Brainstorm',
		'Interview Notes',
		'Competitive Analysis',
	];

	const SUBTITLES = [
		'A deep dive into the details',
		'Quick thoughts on the topic',
		'Notes for future reference',
		'Draft in progress',
		'Ready for review',
		'Needs more research',
		'Follow up required',
		'Summary of key points',
		'Initial exploration',
		'Final draft',
		'Work in progress',
		'Archived',
		'For discussion',
		'Action items included',
		'',
	];

	const TYPES = ['article', 'thought', 'idea', 'research', 'journal'];
	const EXTRA_TAGS = [
		'draft',
		'published',
		'favorite',
		'personal',
		'work',
		'code',
		'design',
		'writing',
	];

	// ─── State ───────────────────────────────────────────────────────────────────

	let count = $state<1000 | 10000>(1000);
	let running = $state(false);
	let clearing = $state(false);
	let progress = $state(0);

	type Results = {
		insertTimeMs: number;
		rowCount: number;
		ydocSizeBytes: number;
		readTimeMs: number;
		filterTimeMs: number;
	};

	let results = $state<Results | null>(null);

	const stressTestCount = $derived(
		entriesState.active.filter((e) => e.tags.includes('stress-test')).length,
	);

	// ─── Helpers ─────────────────────────────────────────────────────────────────

	function pick<T>(arr: T[]): T {
		return arr[Math.floor(Math.random() * arr.length)]!;
	}

	function pickN<T>(arr: T[], min: number, max: number): T[] {
		const n = min + Math.floor(Math.random() * (max - min + 1));
		const shuffled = [...arr].sort(() => Math.random() - 0.5);
		return shuffled.slice(0, n);
	}

	const LOCAL_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

	function randomDate(): DateTimeString {
		const now = Date.now();
		const twoYearsMs = 2 * 365 * 24 * 60 * 60 * 1000;
		const ts = now - twoYearsMs + Math.random() * twoYearsMs;
		return DateTimeString.stringify(new Date(ts).toISOString(), LOCAL_TZ);
	}

	function generateEntryRow(index: number, now: DateTimeString) {
		return {
			id: generateId() as string as EntryId,
			title: `${pick(TITLES)} #${index + 1}`,
			subtitle: pick(SUBTITLES),
			type: pickN(TYPES, 0, 2),
			tags: ['stress-test', ...pickN(EXTRA_TAGS, 0, 2)],
			pinned: Math.random() < 0.05,
			rating: Math.random() < 0.7 ? 0 : Math.floor(Math.random() * 5) + 1,
			deletedAt: undefined,
			date: randomDate(),
			createdAt: now,
			updatedAt: now,
			_v: 2 as const,
		};
	}

	function formatBytes(bytes: number): string {
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
		return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	}

	function formatMs(ms: number): string {
		if (ms < 1000) return `${ms.toFixed(1)}ms`;
		return `${(ms / 1000).toFixed(2)}s`;
	}

	// ─── Actions ─────────────────────────────────────────────────────────────────

	async function generate() {
		running = true;
		progress = 0;
		results = null;

		try {
			const now = DateTimeString.now();
			const rows = Array.from({ length: count }, (_, i) => generateEntryRow(i, now));

			const insertStart = performance.now();
			await workspace.tables.entries.bulkSet(rows, {
				chunkSize: INSERT_CHUNK_SIZE,
				onProgress: (p) => {
					progress = p;
				},
			});
			const insertTimeMs = performance.now() - insertStart;

			// Read performance
			const readStart = performance.now();
			const allValid = workspace.tables.entries.getAllValid();
			const readTimeMs = performance.now() - readStart;

			// Filter performance
			const filterStart = performance.now();
			const stressEntries = workspace.tables.entries.filter((e) =>
				e.tags.includes('stress-test'),
			);
			const filterTimeMs = performance.now() - filterStart;

			// Y.Doc binary size
			const ydocSizeBytes = Y.encodeStateAsUpdate(workspace.ydoc).byteLength;

			results = {
				insertTimeMs,
				rowCount: allValid.length,
				ydocSizeBytes,
				readTimeMs,
				filterTimeMs,
			};

			toast.success(
				`Generated ${count.toLocaleString()} entries in ${formatMs(insertTimeMs)}`,
			);
		} catch (error) {
			toast.error(
				`Generation failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		} finally {
			running = false;
		}
	}

	async function clearGenerated() {
		clearing = true;

		try {
			const stressEntries = workspace.tables.entries.filter((e) =>
				e.tags.includes('stress-test'),
			);
			const ids = stressEntries.map((e) => e.id);

			await workspace.tables.entries.bulkDelete(ids);

			results = null;
			toast.success(`Cleared ${ids.length.toLocaleString()} stress-test entries`);
		} catch (error) {
			toast.error(
				`Clear failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		} finally {
			clearing = false;
		}
	}
</script>

<main class="flex h-full flex-col gap-6 overflow-auto p-6">
	<!-- Header -->
	<div>
		<h2 class="text-lg font-semibold">Stress Test</h2>
		<p class="text-sm text-muted-foreground">
			Generate bulk entries to stress test CRDT performance and UI rendering.
		</p>
	</div>

	<!-- Controls -->
	<Card.Root>
		<Card.Header>
			<Card.Title class="text-sm">Generate Entries</Card.Title>
			<Card.Description>
				All generated entries are tagged
				<Badge variant="secondary">stress-test</Badge>
				for easy cleanup.
			</Card.Description>
		</Card.Header>
		<Card.Content>
			<div class="flex flex-wrap items-center gap-3">
				<!-- Count selector -->
				{#each COUNTS as c}
					<Button
						variant={count === c ? 'default' : 'outline'}
						size="sm"
						disabled={running}
						onclick={() => (count = c)}
					>
						{c.toLocaleString()}
					</Button>
				{/each}

				<div class="h-6 w-px bg-border"></div>

				<!-- Generate -->
				<Button size="sm" disabled={running || clearing} onclick={generate}>
					{running
						? `Generating… ${Math.round(progress * 100)}%`
						: `Generate ${count.toLocaleString()} entries`}
				</Button>

				<!-- Clear -->
				{#if stressTestCount > 0}
					<Button
						variant="destructive"
						size="sm"
						disabled={running || clearing}
						onclick={clearGenerated}
					>
						{clearing
							? 'Clearing…'
							: `Clear ${stressTestCount.toLocaleString()} stress-test entries`}
					</Button>
				{/if}
			</div>
		</Card.Content>
	</Card.Root>

	<!-- Progress -->
	{#if running}
		<div class="space-y-1.5">
			<div
				class="flex items-center justify-between text-xs text-muted-foreground"
			>
				<span>Inserting entries…</span>
				<span>{Math.round(progress * 100)}%</span>
			</div>
			<div class="h-2 overflow-hidden rounded-full bg-muted">
				<div
					class="h-full rounded-full bg-primary transition-all duration-150"
					style:width="{progress * 100}%"
				></div>
			</div>
		</div>
	{/if}

	<!-- Results -->
	{#if results}
		<Card.Root>
			<Card.Header>
				<Card.Title class="text-sm">Results</Card.Title>
			</Card.Header>
			<Card.Content>
				{@const stats = [
					{ label: 'Insert time', value: formatMs(results.insertTimeMs) },
					{ label: 'Total rows', value: results.rowCount.toLocaleString() },
					{ label: 'Stress-test rows', value: stressTestCount.toLocaleString() },
					{ label: 'Y.Doc size', value: formatBytes(results.ydocSizeBytes) },
					{ label: 'getAllValid() time', value: formatMs(results.readTimeMs) },
					{ label: 'filter() time', value: formatMs(results.filterTimeMs) },
				]}
				<div class="grid grid-cols-2 gap-4 sm:grid-cols-3">
					{#each stats as stat}
						<div>
							<p class="text-xs text-muted-foreground">{stat.label}</p>
							<p class="text-lg font-semibold tabular-nums">{stat.value}</p>
						</div>
					{/each}
				</div>
			</Card.Content>
		</Card.Root>
	{/if}

	<!-- Live count -->
	<div class="text-xs text-muted-foreground">
		Total active entries: {entriesState.active.length.toLocaleString()}
		{#if stressTestCount > 0}
			· Stress-test entries: {stressTestCount.toLocaleString()}
		{/if}
	</div>
</main>
