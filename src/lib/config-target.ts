import fs from 'node:fs';
import path from 'node:path';
import {
	IndentationText,
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

/**
 * SvelteKit 3 reads its config only from the inline `sveltekit({...})`
 * argument and refuses to start while one of these exists. They are kept for
 * detection: a project that has one is a Kit 2 project to migrate, not a
 * config file to edit.
 */
export const SVELTE_CONFIG_CANDIDATES = [
	'svelte.config.ts',
	'svelte.config.js',
	'svelte.config.mjs',
	'svelte.config.cjs'
];

/** The file's own indentation: a tab, or the narrowest run of spaces a line starts with. */
function detectIndentation(sourceFile: SourceFile): { useTabs: boolean; size: number } {
	let spaces = 0;
	for (const line of sourceFile.getFullText().split('\n')) {
		if (line.startsWith('\t')) return { useTabs: true, size: 4 };
		const width = line.match(/^ +(?=\S)/)?.[0].length ?? 0;
		// A lone leading space is a comment continuation, not an indent.
		if (width >= 2 && (spaces === 0 || width < spaces)) spaces = width;
	}
	return spaces === 0 ? { useTabs: true, size: 4 } : { useTabs: false, size: spaces };
}

/**
 * `formatText()` in the file's own indentation. ts-morph's default is four
 * spaces, which rewrites every line of the tab-indented config `sv create`
 * writes to change one of them, and a project without prettier has nothing to
 * put that back. Mirrors `formatLikeSource` in @velastack/patterns.
 */
export function formatLikeSource(sourceFile: SourceFile): void {
	const { useTabs, size } = detectIndentation(sourceFile);
	sourceFile.formatText({ convertTabsToSpaces: !useTabs, indentSize: size, tabSize: size });
}

/**
 * Indent what ts-morph inserts the way the file already is, so an added
 * property lines up with its siblings without reformatting the file.
 */
function matchIndentation(project: Project, sourceFile: SourceFile): void {
	const { useTabs, size } = detectIndentation(sourceFile);
	const indentationText = useTabs
		? IndentationText.Tab
		: size === 2
			? IndentationText.TwoSpaces
			: size >= 8
				? IndentationText.EightSpaces
				: IndentationText.FourSpaces;
	project.manipulationSettings.set({ indentationText });
}

/** First candidate that exists under `root`, or null. */
export function probeFirstExisting(root: string, candidates: string[]): string | null {
	for (const rel of candidates) {
		const abs = path.join(root, rel);
		if (fs.existsSync(abs)) return abs;
	}
	return null;
}

/** The project's leftover `svelte.config.*`, or null. */
export function findSvelteConfig(root: string): string | null {
	return probeFirstExisting(root, SVELTE_CONFIG_CANDIDATES);
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
 * plus its inline argument, the one place SvelteKit 3 keeps its config.
 * Returns null when there is no vite config file.
 */
export function inspectViteSveltekit(root: string): ViteSveltekit | null {
	const filePath = probeFirstExisting(root, VITE_CONFIG_CANDIDATES);
	if (!filePath) return null;

	const project = new Project({
		compilerOptions: { allowJs: true },
		manipulationSettings: { quoteKind: QuoteKind.Single }
	});
	const sourceFile = project.addSourceFileAtPath(filePath);
	matchIndentation(project, sourceFile);
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
