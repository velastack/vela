import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import { sveltekit } from '@sveltejs/kit/vite';
import adapter from '@sveltejs/adapter-static';

/**
 * The footer links to these before they exist; `vela legal privacy` and
 * `vela legal terms` generate them. Prerendering crawls every link and fails
 * the build on a 404, so a project would not build until both were written.
 * Once generated they prerender like any other page.
 */
const PENDING_LEGAL_ROUTES = ['/privacy', '/terms'];

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
			prerender: {
				// Every other broken link still fails the build.
				handleHttpError: ({ path, status, message }) => {
					if (status === 404 && PENDING_LEGAL_ROUTES.includes(path)) return;
					throw new Error(message);
				},
				...(process.env.VELA_ORIGIN ? { origin: process.env.VELA_ORIGIN } : {})
			}
		})
	]
});
