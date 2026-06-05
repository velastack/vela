<script lang="ts">
	let { data } = $props();
</script>

<main class="flex-1">
	<section class="px-6 py-16 md:py-24">
		<div class="mx-auto max-w-4xl text-center">
			<a href="/" class="inline-flex items-center gap-2 font-medium">
				<span
					class="bg-primary text-primary-foreground inline-flex size-6 items-center justify-center rounded-md"
				>
					<img src="/favicon.svg" alt="logo" class="size-4" />
				</span>
				{data.meta.appName}
			</a>

			<h1 class="mt-6 text-4xl font-semibold tracking-tight sm:text-5xl">
				A modern way to get things done
			</h1>
			<p class="text-muted-foreground mt-4 text-lg">
				Everything you need to launch faster, collaborate better, and stay focused.
			</p>

			<div class="mt-8 flex items-center justify-center gap-3">
				<a
					href="/signup"
					class="bg-primary text-primary-foreground inline-flex items-center rounded-md px-5 py-2.5"
				>
					Get started
				</a>
				<a
					href="/login"
					class="border border-border text-foreground inline-flex items-center rounded-md px-5 py-2.5"
				>
					Sign in
				</a>
			</div>
		</div>
	</section>

	<section class="px-6 pb-16 md:pb-24">
		<div class="mx-auto grid max-w-5xl gap-6 sm:grid-cols-2 lg:grid-cols-3">
			<div class="bg-card text-card-foreground rounded-lg border p-6">
				<h3 class="font-medium">Fast</h3>
				<p class="text-muted-foreground mt-2">
					Simple workflows that help you move from idea to done.
				</p>
			</div>
			<div class="bg-card text-card-foreground rounded-lg border p-6">
				<h3 class="font-medium">Flexible</h3>
				<p class="text-muted-foreground mt-2">
					Works for teams of any size and adapts to your process.
				</p>
			</div>
			<div class="bg-card text-card-foreground rounded-lg border p-6">
				<h3 class="font-medium">Secure</h3>
				<p class="text-muted-foreground mt-2">
					Built with best practices and modern standards in mind.
				</p>
			</div>
		</div>
	</section>
</main>
