<script lang="ts">
	import { cn } from '$lib/utils.js';
	let { href, children, class: className = '' } = $props();
</script>

<a
	{href}
	class={cn(
		'block py-2 px-3 text-white bg-blue-700 rounded-sm md:bg-transparent md:text-blue-700 md:p-0 dark:text-white md:dark:text-blue-500',
		className
	)}
	aria-current="page">{@render children?.()}</a
>
