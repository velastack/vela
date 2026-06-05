<script lang="ts">
	import { setContext } from 'svelte';
	import { cn } from '$lib/utils.js';
	let { children, class: className = '' } = $props();

	import { MOBILE_MENU_CONTEXT_KEY } from './navbar-store';

	let menuOpen = $state({ isOpen: false });

	setContext(MOBILE_MENU_CONTEXT_KEY, {
		menuOpen,
		toggleMenu: () => (menuOpen.isOpen = !menuOpen.isOpen)
	});
</script>

<nav class={cn(className)}>
	<div class="max-w-7xl flex flex-wrap items-center justify-between mx-auto p-4">
		{@render children?.()}
	</div>
</nav>
