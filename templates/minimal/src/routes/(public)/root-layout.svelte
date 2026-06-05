<script lang="ts">
	import { toggleMode } from 'mode-watcher';
	import * as Navbar from '$lib/components/ui/navbar';
	import { Button } from '$lib/components/ui/button';

	let { children, data } = $props();
</script>

<div class="min-h-dvh grid grid-rows-[max-content_1fr_max-content] root-layout">
	<Navbar.Root>
		<Navbar.Brand href="/">
			<Navbar.Logo src="/favicon.svg" alt="Logo" />
		</Navbar.Brand>

		<Navbar.MobileToggle />

		<Navbar.List>
			<Navbar.Item>
				<Button class="w-full justify-start md:justify-center md:w-auto" href="/" variant="ghost">
					Home
				</Button>
			</Navbar.Item>
		</Navbar.List>
	</Navbar.Root>

	{@render children?.()}

	<footer class="border-t border-border py-4">
		<div
			class="mx-auto flex max-w-7xl px-4 flex-col items-center justify-between gap-3 sm:flex-row"
		>
			<p class="text-muted-foreground text-sm">
				&copy; {new Date().getFullYear()}
				{data.meta.appName}. All rights reserved.
			</p>
			<nav class="flex items-center gap-4 text-sm">
				<Button onclick={toggleMode} variant="ghost" size="icon">
					<Navbar.Mode />
				</Button>
				<a href="/privacy" class="underline-offset-4 hover:underline">Privacy</a>
				<a href="/terms" class="underline-offset-4 hover:underline">Terms</a>
			</nav>
		</div>
	</footer>
</div>

<style lang="postcss">
	@reference "tailwindcss";

	.root-layout :global(section[data-role='content']) {
		@apply container mx-auto max-w-7xl px-4 py-8 w-full;
	}
</style>
