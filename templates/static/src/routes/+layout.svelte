<script lang="ts">
	import '../app.css';

	import { ModeWatcher } from 'mode-watcher';
	import { getFlash } from 'sveltekit-flash-message';
	import { toast } from 'svelte-sonner';
	import { page } from '$app/state';
	import { Toaster } from '$lib/components/ui/sonner';
	import { MetaTags, deepMerge } from 'svelte-meta-tags';

	let { data, children } = $props();
	const flash = getFlash(page);

	$effect(() => {
		if (!$flash || $flash.type !== 'toast') {
			return;
		}

		toast.message($flash.message);

		$flash = undefined;
	});

	let metaTags = $derived(deepMerge(data.baseMetaTags, page.data.pageMetaTags));
</script>

<svelte:head>
	<title>{data.meta.appName}</title>
</svelte:head>

<MetaTags {...metaTags} />
<ModeWatcher />
<Toaster />

{@render children?.()}
