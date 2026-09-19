/**
 * Site-wide metadata, and the one place the app's name and public URL live.
 *
 * Set `url` to where the site is deployed: canonical links, Open Graph images
 * and feeds are built from it, including in prerendered pages. With a backend,
 * `vela dev` and `vela deploy` copy `name` into PocketBase's application name
 * for the emails it sends, so change it here rather than in the admin panel.
 */
export const site = {
	name: '~APP_NAME~',
	url: '~SITE_URL~'
};
