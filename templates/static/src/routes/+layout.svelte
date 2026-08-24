<script lang="ts">
	import '../app.css';

	import favicon from '$lib/assets/favicon.svg';

	import { ModeWatcher } from 'mode-watcher';
	import { page } from '$app/state';
	import { Toaster } from '$lib/components/ui/sonner';
	import { MetaTags, deepMerge } from 'svelte-meta-tags';

	let { data, children } = $props();

	let metaTags = $derived(deepMerge(data.baseMetaTags, page.data.pageMetaTags));
</script>

<svelte:head>
	<title>{data.meta.appName}</title>
	<link rel="icon" href={favicon} />
</svelte:head>

<MetaTags {...metaTags} />
<ModeWatcher />
<Toaster />

{@render children?.()}
