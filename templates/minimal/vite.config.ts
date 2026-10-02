import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import { sveltekit } from '@sveltejs/kit/vite';
import adapter from '@sveltejs/adapter-node';

export default defineConfig({
	plugins: [
		tailwindcss(),
		sveltekit({
			compilerOptions: {
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},
			adapter: adapter(),
			// The public origin, which SvelteKit checks form posts against and uses
			// for prerendered pages. `vela deploy` sets VELA_ORIGIN, and the value is
			// baked in at build time. It is left unset for a deploy that serves more
			// than one host, where each request's own origin is used instead.
			...(process.env.VELA_ORIGIN ? { paths: { origin: process.env.VELA_ORIGIN } } : {})
		})
	]
});
