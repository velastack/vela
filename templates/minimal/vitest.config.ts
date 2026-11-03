import { configDefaults, defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config.ts';

export default mergeConfig(
	viteConfig,
	defineConfig({
		test: {
			expect: {
				requireAssertions: true
			},
			environment: 'node',
			passWithNoTests: true,
			// Server tests reach the app over HTTP and import nothing from it, so
			// watch mode cannot see which tests an edit affects. Rerun them all.
			forceRerunTriggers: [
				'**/package.json/**',
				'**/{vitest,vite}.config.*/**',
				'src/routes/**',
				'src/lib/server/**',
				'src/hooks.server.ts',
				'data/hooks/**'
			],
			projects: [
				{
					extends: true,
					test: {
						// `server.test.ts` next to a route, `<name>.server.test.ts` elsewhere:
						// tests that run against the app and its database.
						name: 'server',
						include: ['src/**/*server.{test,spec}.{js,ts}'],
						// Starts a throwaway PocketBase and the app before the first test
						// file, and stops them after the last. Every way of running vitest
						// gets the same servers: `vela test:server`, `vitest`, `vitest --watch`,
						// an editor's test runner.
						globalSetup: ['vela/testing'],
						setupFiles: ['test/setup.ts']
					}
				},
				{
					extends: true,
					test: {
						// Every other test: pure functions, no servers, no setup file.
						name: 'unit',
						include: ['src/**/*.{test,spec}.{js,ts}'],
						exclude: [
							...configDefaults.exclude,
							'src/**/*server.{test,spec}.{js,ts}',
							'src/**/*.svelte.{test,spec}.{js,ts}'
						]
					}
				}
			]
		}
	})
);
