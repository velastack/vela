<script lang="ts">
	import { cn } from '$lib/utils.js';
	let { children = undefined, class: className = '' } = $props();
</script>

<li class={cn('flex items-center', className)}>{@render children?.()}</li>
