<script lang="ts">
	import { cn } from '$lib/utils';
	let { href, children, class: className = '' } = $props();
</script>

<a {href} class={cn('flex items-center space-x-3 rtl:space-x-reverse', className)}>
	{@render children?.()}
</a>
