<script lang="ts">
	import { createQuery } from '@tanstack/svelte-query';
	import { onDestroy } from 'svelte';
	import { rpc } from '$lib/query';
	import { services } from '$lib/services';
	import { viewTransition } from '$lib/utils/viewTransitions';

	let { id }: { id: string } = $props();

	const audioUrlQuery = createQuery(
		() => rpc.audio.getPlaybackUrl(() => id).options,
	);

	onDestroy(() => {
		// Clean up audio URL when component unmounts to prevent memory leaks
		services.blobs.audio.revokeUrl(id);
	});
</script>

{#if audioUrlQuery.data}
	<audio
		class="h-8"
		style="view-transition-name: {viewTransition.recording(id).audio}"
		controls
		src={audioUrlQuery.data}
	>
		Your browser does not support the audio element.
	</audio>
{/if}
