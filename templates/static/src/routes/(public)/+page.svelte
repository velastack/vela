<script lang="ts">
	import favicon from '$lib/assets/favicon.svg';

	let { data } = $props();
</script>

<main class="flex-1">
	<section class="px-6 py-16 md:py-24">
		<div class="mx-auto max-w-4xl text-center">
			<a href="/" class="inline-flex items-center gap-2 font-medium">
				<span
					class="bg-primary text-primary-foreground inline-flex size-6 items-center justify-center rounded-md"
				>
					<img src={favicon} alt="logo" class="size-4" />
				</span>
				{data.meta.appName}
			</a>

			<h1 class="mt-6 text-4xl font-semibold tracking-tight sm:text-5xl">
				{data.meta.appName} is running on VelaStack
			</h1>
			<p class="text-muted-foreground mt-4 text-lg">
				A SvelteKit site that prerenders to static HTML, so there is no server to run and nothing to
				keep alive. This page is
				<code class="bg-muted rounded px-1.5 py-0.5 font-mono text-base"
					>src/routes/(public)/+page.svelte</code
				>, and it is yours to delete.
			</p>

			<div class="mt-8 flex items-center justify-center gap-3">
				<a
					href="https://docs.velastack.dev"
					class="bg-primary text-primary-foreground inline-flex items-center rounded-md px-5 py-2.5"
				>
					Read the docs
				</a>
				<a
					href="https://velastack.dev/templates"
					class="border border-border text-foreground inline-flex items-center rounded-md px-5 py-2.5"
				>
					Browse templates
				</a>
			</div>
		</div>
	</section>

	<section class="px-6 pb-16 md:pb-24">
		<div class="mx-auto grid max-w-5xl gap-6 sm:grid-cols-2 lg:grid-cols-3">
			<div class="bg-card text-card-foreground rounded-lg border p-6">
				<h3 class="font-medium">Your address</h3>
				<p class="text-muted-foreground mt-2">
					Canonical links and Open Graph images are built from one value at prerender time. Set it
					before you ship.
				</p>
				<code
					class="bg-muted text-muted-foreground mt-4 block overflow-x-auto rounded-md px-3 py-2 font-mono text-xs"
					>src/lib/site.ts</code
				>
			</div>
			<div class="bg-card text-card-foreground rounded-lg border p-6">
				<h3 class="font-medium">Your interface</h3>
				<p class="text-muted-foreground mt-2">
					shadcn components, copied into your project. Yours to restyle, with no dependency to
					fight.
				</p>
				<code
					class="bg-muted text-muted-foreground mt-4 block overflow-x-auto rounded-md px-3 py-2 font-mono text-xs"
					>vela ui add button card dialog</code
				>
			</div>
			<div class="bg-card text-card-foreground rounded-lg border p-6">
				<h3 class="font-medium">Your deploy</h3>
				<p class="text-muted-foreground mt-2">
					Every route built to plain HTML, ready for any CDN or static host.
				</p>
				<code
					class="bg-muted text-muted-foreground mt-4 block overflow-x-auto rounded-md px-3 py-2 font-mono text-xs"
					>vela build &amp;&amp; vela deploy</code
				>
			</div>
		</div>
	</section>
</main>
