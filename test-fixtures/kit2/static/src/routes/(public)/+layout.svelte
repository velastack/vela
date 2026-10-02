<script lang="ts">
	import RootLayout from './root-layout.svelte';

	let { data, children } = $props();
</script>

<RootLayout {data}>
	{@render children?.()}
</RootLayout>
