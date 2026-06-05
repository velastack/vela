import { loadFlash } from 'sveltekit-flash-message/server';
import { defineBaseMetaTags } from 'svelte-meta-tags';

export const load = loadFlash(async ({ locals, url }) => {
	const canonical = new URL(url.pathname, url.origin).href;

	const baseTags = defineBaseMetaTags({
		title: '',
		titleTemplate: `%s | ${locals.meta.appName}`,
		description: '',
		canonical,
		openGraph: {
			type: 'website',
			url: canonical,
			images: [
				{
					url: `${locals.meta.appURL}/og.jpg`,
					alt: locals.meta.appName,
					width: 1200,
					height: 630
				}
			]
		}
	});

	return {
		meta: locals.meta,
		...baseTags
	};
});
