import path from 'node:path';
import { readComponentsJson } from './components-json.ts';
import { readPackageJson } from './package-json.ts';

export type FormUi = 'shadcn' | 'plain';

const FORM_UIS: FormUi[] = ['shadcn', 'plain'];

/** The `input` keys the form patterns read; see `Options.input` in @velastack/patterns. */
export interface FormInput {
	ui: FormUi;
	/** `sveltekit-flash-message` is installed, so actions may `setFlash`. */
	flash: boolean;
	/** The `vela test:server` harness is installed, so a `server.test.ts` can run. */
	serverTests: boolean;
}

/**
 * What the form generators can assume about a project.
 *
 * shadcn markup needs both halves: `components.json` is what `shadcn-svelte
 * add` reads, and the dependency is what the installed components import. A
 * project with neither gets native elements, which need nothing installed.
 */
export function detectFormInput(root: string): FormInput {
	const pkg = readPackageJson(path.join(root, 'package.json'));
	const hasDep = (name: string) => Boolean(pkg.dependencies?.[name] || pkg.devDependencies?.[name]);
	const shadcn =
		readComponentsJson(root) !== undefined && (hasDep('shadcn-svelte') || hasDep('bits-ui'));

	return {
		ui: shadcn ? 'shadcn' : 'plain',
		flash: hasDep('sveltekit-flash-message'),
		serverTests: hasDep('supertest')
	};
}

/** Detection, overridden by an explicit `--ui`. */
export function resolveFormInput(root: string, requested?: string): FormInput {
	const detected = detectFormInput(root);
	if (requested === undefined) return detected;

	if (!FORM_UIS.includes(requested as FormUi)) {
		throw new Error(`Unknown --ui "${requested}". Expected one of: ${FORM_UIS.join(', ')}.`);
	}
	if (requested === 'shadcn' && detected.ui !== 'shadcn') {
		throw new Error(
			'--ui shadcn needs a shadcn-svelte project (a components.json and the shadcn-svelte package). ' +
				'Run `vela bless` to set one up, or use --ui plain.'
		);
	}
	return { ...detected, ui: requested as FormUi };
}
