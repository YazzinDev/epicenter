<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { Spinner } from '@epicenter/ui/spinner';
	import type { PlainTextHandle } from '@epicenter/workspace';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import TrashIcon from '@lucide/svelte/icons/trash-2';
	import { workspace } from '$lib/client';
	import { skillsState } from '$lib/state/skills-state.svelte';
	import CodeMirrorEditor from './CodeMirrorEditor.svelte';

	let expandedRefId = $state<string | null>(null);
	let refContent = $state<PlainTextHandle | null>(null);

	let refError = $state<string | null>(null);

	$effect(() => {
		const id = expandedRefId;
		if (!id) {
			refContent = null;
			refError = null;
			return;
		}
		let cancelled = false;
		refContent = null;
		refError = null;
		workspace.documents.references.content.open(id).then(
			(openedContent) => {
				if (cancelled) return;
				if (expandedRefId !== id) return;
				refContent = openedContent;
			},
			(err) => {
				if (cancelled) return;
				console.error('Failed to open reference document:', err);
				refError =
					err instanceof Error ? err.message : 'Failed to open document';
			},
		);

		return () => {
			cancelled = true;
			if (refContent) {
				workspace.documents.references.content.close(id);
			}
			refContent = null;
		};
	});
</script>

{#if skillsState.selectedSkillId}
	<div class="border-t p-4">
		<div class="mb-3 flex items-center justify-between">
			<h3 class="text-sm font-medium text-muted-foreground">References</h3>
			<Button
				variant="ghost"
				size="sm"
				onclick={() => {
					if (!skillsState.selectedSkillId) return;
					const id = skillsState.createReference(skillsState.selectedSkillId, 'new-reference.md');
					expandedRefId = id;
				}}
			>
				<PlusIcon class="mr-1 size-3.5" />
				Add Reference
			</Button>
		</div>

		{#if skillsState.selectedReferences.length === 0}
			<p class="text-xs text-muted-foreground">
				No references yet. Add reference files for additional documentation.
			</p>
		{:else}
			<div class="space-y-2">
				{#each skillsState.selectedReferences as ref (ref.id)}
					<div class="rounded-md border">
						<div class="flex items-center justify-between px-3 py-2">
							<button
								class="flex-1 text-left font-mono text-sm hover:underline"
								onclick={() => {
									expandedRefId = expandedRefId === ref.id ? null : ref.id;
								}}
							>
								{ref.path}
							</button>
							<Button
								variant="ghost"
								size="icon-xs"
								onclick={() => {
									if (expandedRefId === ref.id) expandedRefId = null;
									skillsState.deleteReference(ref.id);
								}}
							>
								<TrashIcon class="size-3.5 text-muted-foreground" />
							</Button>
						</div>
						{#if expandedRefId === ref.id}
							<div class="h-48 border-t">
								{#if refError}
									<div class="flex h-full items-center justify-center">
										<p class="text-sm text-destructive">{refError}</p>
									</div>
								{:else if refContent}
									<CodeMirrorEditor ytext={refContent.binding} />
								{:else}
									<div class="flex h-full items-center justify-center">
										<Spinner class="size-4 text-muted-foreground" />
									</div>
								{/if}
							</div>
						{/if}
					</div>
				{/each}
			</div>
		{/if}
	</div>
{/if}
