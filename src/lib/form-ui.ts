import path from 'node:path';
import { readPackageJson } from './package-json.ts';
import type { Ui } from './workspace.ts';

const UIS: Ui[] = ['shadcn', 'plain'];

/**
 * The `input` keys the form patterns read; see `Options.input` in
 * @velastack/patterns. `ui` is only set by an explicit `--ui`: without one the
 * patterns follow the detected `features.ui`.
 */
export interface FormInput {
	ui?: Ui;
	/** `sveltekit-flash-message` is installed, so actions may `setFlash`. */
	flash: boolean;
	/** The `vela test:server` harness is installed, so a `server.test.ts` can run. */
	serverTests: boolean;
}

/** What the form generators can assume about a project, beyond its `features`. */
export function detectFormInput(root: string): FormInput {
	const pkg = readPackageJson(path.join(root, 'package.json'));
	const hasDep = (name: string) => Boolean(pkg.dependencies?.[name] || pkg.devDependencies?.[name]);

	return {
		flash: hasDep('sveltekit-flash-message'),
		serverTests: hasDep('supertest')
	};
}

/** Detection, plus an explicit `--ui` checked against the detected `features.ui`. */
export function resolveFormInput(root: string, detectedUi: Ui, requested?: string): FormInput {
	const detected = detectFormInput(root);
	if (requested === undefined) return detected;

	if (!UIS.includes(requested as Ui)) {
		throw new Error(`Unknown --ui "${requested}". Expected one of: ${UIS.join(', ')}.`);
	}
	if (requested === 'shadcn' && detectedUi !== 'shadcn') {
		throw new Error(
			'--ui shadcn needs a shadcn-svelte project (a components.json and the shadcn-svelte package). ' +
				'Set one up with `npx sv add tailwindcss`, then `npx shadcn-svelte@latest init`, or use --ui plain.'
		);
	}
	return { ...detected, ui: requested as Ui };
}
