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
			prerender: {
				handleHttpError: ({ path, message }) => {
					// The footer links to these before they exist; `vela legal privacy`
					// and `vela legal terms` generate them. Warn rather than fail the
					// build, but keep every other broken link fatal.
					if (path === '/privacy' || path === '/terms') {
						console.warn(`${path} not generated yet — run \`vela legal ${path.slice(1)}\``);
						return;
					}
					throw new Error(message);
				}
			}
		})
	]
});
