<script lang="ts">
	import { page } from '$app/state';
	import { Button } from '$lib/components/ui/button';
	import RootLayout from './(public)/root-layout.svelte';

	let { data } = $props();
</script>

<RootLayout {data}>
	<main class="mx-auto max-w-7xl px-4 w-full flex items-center justify-center">
		<div class="text-center space-y-4">
			<div class="text-9xl font-bold text-primary">
				{page.status}
			</div>
			<div class="relative">
				<h1 class="text-4xl font-bold relative inline-block bg-background">
					Oops! Something went wrong
				</h1>
			</div>
			<p class="text-xl text-muted-foreground max-w-lg mx-auto">
				{page.error?.message ||
					"We couldn't find what you were looking for. Let's get you back on track!"}
			</p>
			<div>
				<Button href="/" variant="default" size="lg">Take me home</Button>
			</div>
		</div>
	</main>
</RootLayout>
