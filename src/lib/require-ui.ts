import { detectUi, findWorkspaceRoot } from './workspace.ts';

/**
 * Refuse, before anything is written, a command that emits shadcn-svelte
 * markup or drives `shadcn-svelte` itself in a project that has neither.
 *
 * Left to run, such a command gets as far as `shadcn-svelte add` and dies
 * there on the missing `components.json` — after the config, the layout, the
 * packages and sometimes a collection are already in. There is deliberately no
 * `vela ui init`: shadcn-svelte and Tailwind have their own installers, and the
 * message names them.
 */
export function assertShadcn(command: string, root: string | null = findWorkspaceRoot()): void {
	if (root === null || detectUi(root) === 'shadcn') return;

	throw new Error(
		`\`${command}\` needs shadcn-svelte, and this project does not have it ` +
			`(no components.json, or the package is not installed).\n\n` +
			'Nothing was changed. To set it up:\n' +
			'  1. Add Tailwind CSS:    npx sv add tailwindcss\n' +
			'  2. Add shadcn-svelte:   npx shadcn-svelte@latest init\n' +
			'Then run this again.'
	);
}
