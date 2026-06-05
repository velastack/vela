<script lang="ts">
	import { getContext } from 'svelte';
	import { Button } from '$lib/components/ui/button';
	import MenuIcon from '@lucide/svelte/icons/menu';
	import { MOBILE_MENU_CONTEXT_KEY, type MobileMenuContext } from './navbar-store';

	const { toggleMenu } = getContext<MobileMenuContext>(MOBILE_MENU_CONTEXT_KEY);
</script>

<Button
	type="button"
	aria-controls="navbar-default"
	aria-expanded="false"
	variant="ghost"
	class="md:hidden"
	onclick={toggleMenu}
>
	<span class="sr-only">Open main menu</span>
	<MenuIcon class="size-6" />
</Button>
