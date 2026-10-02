<script lang="ts">
	import '../app.css';

	import favicon from '#lib/assets/favicon.svg';
	import { site } from '#lib/site.js';

	import { ModeWatcher } from 'mode-watcher';
	import { page } from '$app/state';
	import { Toaster } from '#lib/components/ui/sonner/index.js';
	import { MetaTags, deepMerge } from 'svelte-meta-tags';
	import type { LayoutProps } from './$types';

	let { data, children }: LayoutProps = $props();

	let metaTags = $derived(deepMerge(data.baseMetaTags, page.data.pageMetaTags));
</script>

<svelte:head>
	<title>{site.name}</title>
	<link rel="icon" href={favicon} />
</svelte:head>

<MetaTags {...metaTags} />
<ModeWatcher />
<Toaster />

{@render children?.()}
