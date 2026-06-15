import fs from 'node:fs';
import path from 'node:path';
import {
	Project,
	QuoteKind,
	SyntaxKind,
	type CallExpression,
	type ObjectLiteralExpression,
	type SourceFile
} from 'ts-morph';

export const VITE_CONFIG_CANDIDATES = [
	'vite.config.ts',
	'vite.config.js',
	'vite.config.mjs',
	'vite.config.cjs'
];

export const SVELTE_CONFIG_CANDIDATES = [
	'svelte.config.ts',
	'svelte.config.js',
	'svelte.config.mjs',
	'svelte.config.cjs'
];

/** First candidate that exists under `root`, or null. */
export function probeFirstExisting(root: string, candidates: string[]): string | null {
	for (const rel of candidates) {
		const abs = path.join(root, rel);
		if (fs.existsSync(abs)) return abs;
	}
	return null;
}

export interface ViteSveltekit {
	filePath: string;
	sourceFile: SourceFile;
	sveltekitCall: CallExpression | null;
	/** Inline object argument of `sveltekit(...)`, if it's an object literal. */
	inlineArg: ObjectLiteralExpression | null;
	/** True when `sveltekit(...)` has a non-object argument we mustn't touch. */
	nonObjectArg: boolean;
}

/**
 * Load the project's `vite.config.*` (if any) and locate the `sveltekit()` call
 * plus its inline argument. Returns null when there is no vite config file.
 */
export function inspectViteSveltekit(root: string): ViteSveltekit | null {
	const filePath = probeFirstExisting(root, VITE_CONFIG_CANDIDATES);
	if (!filePath) return null;

	const project = new Project({
		compilerOptions: { allowJs: true },
		manipulationSettings: { quoteKind: QuoteKind.Single }
	});
	const sourceFile = project.addSourceFileAtPath(filePath);
	const sveltekitCall =
		sourceFile
			.getDescendantsOfKind(SyntaxKind.CallExpression)
			.find((ce) => ce.getExpression().getText() === 'sveltekit') ?? null;

	let inlineArg: ObjectLiteralExpression | null = null;
	let nonObjectArg = false;
	const arg = sveltekitCall?.getArguments()[0];
	if (arg) {
		if (arg.getKind() === SyntaxKind.ObjectLiteralExpression) {
			inlineArg = arg as ObjectLiteralExpression;
		} else {
			nonObjectArg = true;
		}
	}

	return { filePath, sourceFile, sveltekitCall, inlineArg, nonObjectArg };
}

/** Add an empty `{}` argument to a bare `sveltekit()` call and return it. */
export function createSveltekitArg(vite: ViteSveltekit): ObjectLiteralExpression | null {
	if (!vite.sveltekitCall || vite.nonObjectArg) return null;
	return vite.sveltekitCall.addArgument('{}').asKind(SyntaxKind.ObjectLiteralExpression) ?? null;
}

/**
 * Get the object-literal value of property `name`, creating it as an empty
 * object when missing. Returns null if it can't be coerced to an object literal.
 */
export function getOrCreateObjectLiteralProperty(
	obj: ObjectLiteralExpression,
	name: string,
	initializer: string
): ObjectLiteralExpression | null {
	const prop = obj.getProperty(name);
	if (!prop) {
		obj.addPropertyAssignment({ name, initializer });
		const added = obj.getProperty(name);
		if (!added || added.getKind() !== SyntaxKind.PropertyAssignment) return null;
		const init = (added as import('ts-morph').PropertyAssignment).getInitializer();
		return init && init.getKind() === SyntaxKind.ObjectLiteralExpression
			? (init as ObjectLiteralExpression)
			: null;
	}

	if (prop.getKind() !== SyntaxKind.PropertyAssignment) return null;
	const init = (prop as import('ts-morph').PropertyAssignment).getInitializer();
	if (!init) return null;
	if (init.getKind() !== SyntaxKind.ObjectLiteralExpression) {
		(prop as import('ts-morph').PropertyAssignment).setInitializer(initializer);
		const init2 = (prop as import('ts-morph').PropertyAssignment).getInitializer();
		return init2 && init2.getKind() === SyntaxKind.ObjectLiteralExpression
			? (init2 as ObjectLiteralExpression)
			: null;
	}

	return init as ObjectLiteralExpression;
}
