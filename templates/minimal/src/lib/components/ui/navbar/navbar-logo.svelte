<script lang="ts">
	import { cn } from '$lib/utils.js';
	let {
		src = 'https://upload.wikimedia.org/wikipedia/commons/1/1b/Svelte_Logo.svg',
		alt = 'Logo',
		class: className = ''
	} = $props();
</script>

<img {src} class={cn('h-8', className)} {alt} />
