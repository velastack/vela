<script lang="ts">
	import { cn } from '$lib/utils.js';
	let { children, class: className = '' } = $props();
</script>

<span class={cn('self-center text-2xl font-semibold whitespace-nowrap dark:text-white', className)}>
	{@render children?.()}
</span>
