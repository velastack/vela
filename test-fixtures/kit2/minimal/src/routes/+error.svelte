<script lang="ts">
	import { page } from '$app/state';
	import { Button } from '$lib/components/ui/button';
	import RootLayout from './(public)/root-layout.svelte';

	let { data } = $props();

	let notFound = $derived(page.status === 404);
	let heading = $derived(notFound ? 'Page not found' : 'Something went wrong');
	let detail = $derived(
		notFound
			? 'That page does not exist. The link may be wrong, or the page may have moved.'
			: (page.error?.message ?? 'The request could not be completed.')
	);
</script>

<RootLayout {data}>
	<main class="mx-auto max-w-7xl px-4 w-full flex items-center justify-center">
		<div class="text-center space-y-4">
			<div class="text-9xl font-bold text-primary">
				{page.status}
			</div>
			<div class="relative">
				<h1 class="text-4xl font-bold relative inline-block bg-background">
					{heading}
				</h1>
			</div>
			<p class="text-xl text-muted-foreground max-w-lg mx-auto">
				{detail}
			</p>
			<div>
				<Button href="/" variant="default" size="lg">Back to home</Button>
			</div>
		</div>
	</main>
</RootLayout>
