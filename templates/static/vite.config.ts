import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import { sveltekit } from '@sveltejs/kit/vite';
import adapter from '@sveltejs/adapter-static';

export default defineConfig({
	plugins: [
		tailwindcss(),
		sveltekit({
			compilerOptions: {
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},
			adapter: adapter({
				fallback: '200.html'
			}),
			// Prerendering has no request to take an origin from, so without this
			// every canonical link and `og:url` would be built from SvelteKit's
			// placeholder host. `vela build` sets it from the domain the target is
			// deployed on; unset, `$lib/site` still carries the site's own URL.
			...(process.env.VELA_ORIGIN ? { prerender: { origin: process.env.VELA_ORIGIN } } : {})
		})
	]
});
