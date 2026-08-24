/**
 * Site-wide metadata.
 *
 * A static build has no backend to read this from, so this file is the source of
 * truth. Set `url` to where the site is actually deployed — canonical links and
 * Open Graph image URLs are built from it at prerender time.
 */
export const site = {
	name: '~APP_NAME~',
	url: 'http://localhost:5173'
};
