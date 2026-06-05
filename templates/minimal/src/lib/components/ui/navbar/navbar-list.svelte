<script lang="ts">
	import { cn } from '$lib/utils.js';
	import { getContext } from 'svelte';
	import { MOBILE_MENU_CONTEXT_KEY, type MobileMenuContext } from './navbar-store';

	let { children, class: className = '' } = $props();

	const { menuOpen } = getContext<MobileMenuContext>(MOBILE_MENU_CONTEXT_KEY);
</script>

<div
	class={cn('hidden w-full md:block md:w-auto', className, menuOpen.isOpen && 'block')}
	id="navbar-default"
>
	<ul
		class={cn(
			'font-medium flex flex-col p-2 md:p-0 mt-4 border rounded-lg bg-card md:flex-row md:space-x-4 rtl:space-x-reverse md:mt-0 md:border-0 md:bg-transparent'
		)}
	>
		{@render children?.()}
	</ul>
</div>
