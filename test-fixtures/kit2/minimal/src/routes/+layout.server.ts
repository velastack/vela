import { loadFlash } from 'sveltekit-flash-message/server';
import { defineBaseMetaTags } from 'svelte-meta-tags';
import { site } from '$lib/site';

export const load = loadFlash(async ({ url }) => {
	// Built from `site.url`, not `url.origin`: every deployment and every
	// prerendered page (where the origin is SvelteKit's placeholder host) should
	// point at the one address the site is published under.
	const canonical = new URL(url.pathname, site.url).href;

	const baseTags = defineBaseMetaTags({
		title: '',
		titleTemplate: `%s | ${site.name}`,
		description: '',
		canonical,
		openGraph: {
			type: 'website',
			url: canonical,
			images: [
				{
					url: `${site.url}/og.jpg`,
					alt: site.name,
					width: 1200,
					height: 630
				}
			]
		}
	});

	return {
		...baseTags
	};
});
