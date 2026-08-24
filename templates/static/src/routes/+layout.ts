import { defineBaseMetaTags } from 'svelte-meta-tags';
import { site } from '$lib/site';
import type { LayoutLoad } from './$types';

export const prerender = true;

export const load: LayoutLoad = ({ url }) => {
	// Built from `site.url`, not `url.origin`: during prerender the origin is
	// SvelteKit's placeholder host, which would end up in every canonical link.
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
		meta: { appName: site.name, appURL: site.url },
		...baseTags
	};
};
