import fs from 'node:fs';
import path from 'node:path';
import {
	Node,
	Project,
	SyntaxKind,
	type Expression,
	type ImportDeclaration,
	type ObjectLiteralExpression,
	type SourceFile
} from 'ts-morph';
import { detect, type AgentName } from 'package-manager-detector';
import {
	createSveltekitArg,
	findSvelteConfig,
	formatLikeSource,
	inspectViteSveltekit
} from './config-target.ts';
import { KIT3_MIGRATE_COMMAND, kitMajor } from './kit-version.ts';
import { readPackageJson, sortKeys, writePackageJson, type PkgJson } from './package-json.ts';
import { getUserAgent, installDependencies, isInstalled } from './package-manager.ts';

/**
 * The SvelteKit adapter a server deploy needs, and how to get a project onto it.
 *
 * `vela deploy` runs the build as a Node server, so it needs the output
 * `@sveltejs/adapter-node` produces. What `sv create` ships instead is
 * `@sveltejs/adapter-auto`, which only recognises hosted
 * platforms and writes nothing at all on a machine of your own. Rather than
 * fail after the build with "no build/index.js", the deploy detects the adapter
 * before building and switches an undecided project to adapter-node. A project
 * that chose something else on purpose - adapter-static, Vercel, Cloudflare -
 * is left alone and told why.
 */

export const ADAPTER_NODE = '@sveltejs/adapter-node';
export const ADAPTER_AUTO = '@sveltejs/adapter-auto';
export const ADAPTER_STATIC = '@sveltejs/adapter-static';
/** The range written into a project that had no adapter-node before. */
export const ADAPTER_NODE_RANGE = '^6.0.0';

export type AdapterKind = 'node' | 'auto' | 'static' | 'other' | 'none';

export interface AdapterInfo {
	kind: AdapterKind;
	/** The vite config whose `sveltekit({...})` call SvelteKit reads its config from. */
	file: string;
	/** Module specifier of the adapter import, when the property points at one. */
	specifier?: string;
}

export const ADAPTER_SNIPPET = `import adapter from '${ADAPTER_NODE}';

// ...
adapter: adapter()`;

/** A config that cannot or must not be switched. Carries the snippet to apply by hand. */
export class AdapterError extends Error {
	constructor(
		message: string,
		public readonly snippet: string = ADAPTER_SNIPPET
	) {
		super(message);
		this.name = 'AdapterError';
	}
}

interface KitTarget {
	sourceFile: SourceFile;
	filePath: string;
	/**
	 * Where `adapter` lives: the inline `sveltekit({...})` argument, or `kit` in
	 * a svelte.config. Null only for a svelte.config with no `kit` at all, which
	 * has no adapter and is never edited.
	 */
	kit: ObjectLiteralExpression | null;
	/** A `{}` argument was created on a bare `sveltekit()` - the one case the file is reformatted. */
	created: boolean;
	originalText: string;
	/**
	 * A `svelte.config.*`, which is a SvelteKit 2 project. Read so a project
	 * already on adapter-node deploys; never written, since the switch would
	 * be Kit 2 code vela no longer generates.
	 */
	readOnly: boolean;
}

/**
 * Where the project's SvelteKit config is. An inline `sveltekit({...})`
 * argument in vite.config wins on either major: it is the only place Kit 3
 * reads from, and Kit 2 ignores a svelte.config beside one. Otherwise a
 * SvelteKit 2 project's svelte.config is read, not written. A Kit 3 project
 * that still has one cannot start, so it is sent to the migration instead.
 * A bare `sveltekit()` with no svelte.config gets an argument created.
 */
function resolveKitTarget(root: string): KitTarget {
	const svelteConfig = findSvelteConfig(root);
	const major = kitMajor(root);
	if (svelteConfig && major !== null && major >= 3) {
		throw new AdapterError(
			`${path.basename(svelteConfig)} found: SvelteKit 3 reads its config only from\n` +
				`sveltekit({...}) in vite.config and will not start while this file exists.\n\n` +
				`Migrate it first:`,
			KIT3_MIGRATE_COMMAND
		);
	}

	const vite = inspectViteSveltekit(root);
	if (!vite?.inlineArg && svelteConfig) return resolveSvelteConfigTarget(svelteConfig);
	if (vite?.inlineArg) {
		return {
			sourceFile: vite.sourceFile,
			filePath: vite.filePath,
			kit: vite.inlineArg,
			created: false,
			originalText: vite.sourceFile.getFullText(),
			readOnly: false
		};
	}

	if (vite?.sveltekitCall) {
		const name = path.basename(vite.filePath);
		if (vite.nonObjectArg) {
			throw new AdapterError(`${name} passes sveltekit() something other than an object literal.`);
		}
		const originalText = vite.sourceFile.getFullText();
		const kit = createSveltekitArg(vite);
		if (!kit)
			throw new AdapterError(`${name} has a sveltekit() call vela cannot add an argument to.`);
		return {
			sourceFile: vite.sourceFile,
			filePath: vite.filePath,
			kit,
			created: true,
			originalText,
			readOnly: false
		};
	}

	throw new AdapterError(`No vite.config with a sveltekit() plugin found in ${root}.`);
}

/**
 * The `kit` object of a svelte.config: `export default { kit: {...} }`, or
 * `const config = { kit: {...} }; export default config;` as `sv create`
 * wrote it. Read-only. A shape vela cannot read is reported as such, with
 * the snippet to apply by hand.
 */
function resolveSvelteConfigTarget(filePath: string): KitTarget {
	const name = path.basename(filePath);
	const unreadable = () =>
		new AdapterError(
			`${name}: vela cannot read the adapter from this config.\n\n` +
				`vela deploy runs the app as a Node server, which needs ${ADAPTER_NODE}:`
		);
	let sourceFile: SourceFile;
	try {
		const project = new Project({
			compilerOptions: { allowJs: true },
			skipFileDependencyResolution: true
		});
		sourceFile = project.addSourceFileAtPath(filePath);
	} catch {
		throw unreadable();
	}
	const exported = sourceFile.getExportAssignment((a) => !a.isExportEquals());
	let value = unwrapExpression(exported?.getExpression());
	if (value && Node.isIdentifier(value)) {
		value = unwrapExpression(sourceFile.getVariableDeclaration(value.getText())?.getInitializer());
	}
	if (!value || !Node.isObjectLiteralExpression(value)) throw unreadable();
	const kitProp = value.getProperty('kit');
	let kit: ObjectLiteralExpression | null = null;
	if (kitProp) {
		const init = Node.isPropertyAssignment(kitProp)
			? unwrapExpression(kitProp.getInitializer())
			: undefined;
		if (!init || !Node.isObjectLiteralExpression(init)) throw unreadable();
		kit = init;
	}
	return {
		sourceFile,
		filePath,
		kit,
		created: false,
		originalText: sourceFile.getFullText(),
		readOnly: true
	};
}

function unwrapExpression(expr: Expression | undefined): Expression | undefined {
	let current = expr;
	while (
		current &&
		(Node.isParenthesizedExpression(current) ||
			Node.isAsExpression(current) ||
			Node.isSatisfiesExpression(current))
	) {
		current = current.getExpression();
	}
	return current;
}

function classify(specifier: string): AdapterKind {
	if (specifier === ADAPTER_NODE) return 'node';
	if (specifier === ADAPTER_AUTO) return 'auto';
	if (specifier === ADAPTER_STATIC) return 'static';
	return 'other';
}

/** The import a default-import identifier is bound to, if any. */
function importOf(sourceFile: SourceFile, identifier: string): ImportDeclaration | undefined {
	return sourceFile
		.getImportDeclarations()
		.find((decl) => decl.getDefaultImport()?.getText() === identifier);
}

interface AdapterProperty {
	info: AdapterInfo;
	importDecl?: ImportDeclaration;
}

/**
 * Classify the `adapter` property of the sveltekit() argument by the module its call
 * resolves to. The local name proves nothing - `import adapter from
 * '@sveltejs/adapter-vercel'` is the norm - so only the specifier counts, and
 * anything that is not a plain `<import>()` call is `other`: a conditional or
 * a value from elsewhere is a decision vela cannot see, so it does not touch it.
 */
function inspectAdapter(target: KitTarget): AdapterProperty {
	const base = { file: target.filePath };
	const prop = target.kit?.getProperty('adapter');
	if (!prop) return { info: { ...base, kind: 'none' } };

	if (prop.getKind() !== SyntaxKind.PropertyAssignment) {
		return { info: { ...base, kind: 'other' } };
	}
	const init = prop.asKindOrThrow(SyntaxKind.PropertyAssignment).getInitializer();
	if (!init || init.getKind() !== SyntaxKind.CallExpression) {
		return { info: { ...base, kind: 'other' } };
	}
	const callee = init.asKindOrThrow(SyntaxKind.CallExpression).getExpression();
	if (callee.getKind() !== SyntaxKind.Identifier) {
		return { info: { ...base, kind: 'other' } };
	}
	const importDecl = importOf(target.sourceFile, callee.getText());
	if (!importDecl) return { info: { ...base, kind: 'other' } };

	const specifier = importDecl.getModuleSpecifierValue();
	return { info: { ...base, kind: classify(specifier), specifier }, importDecl };
}

/** Which adapter the project builds with, read from the config SvelteKit would read. */
export function detectAdapter(root: string): AdapterInfo {
	return inspectAdapter(resolveKitTarget(root)).info;
}

export interface EnsureNodeAdapterOutcome {
	/** The adapter this project had before. */
	previous: AdapterKind;
	/** Basename of the config file that was rewritten, if one was. */
	configFile?: string;
	/** Dependencies removed from package.json. */
	removedDeps: string[];
	/** package.json was written. */
	packageJsonChanged: boolean;
	/** The package manager an install ran with, if one ran. */
	installedWith?: AgentName;
}

export interface EnsureNodeAdapterOptions {
	/** Run the package manager's install when package.json changed. */
	install?: boolean;
}

/**
 * Put the project on `@sveltejs/adapter-node`, if it is not already and the
 * choice can be made for it.
 *
 * adapter-auto, or no adapter at all, is a decision not yet taken: the config
 * is rewritten in place, adapter-auto is dropped from package.json, adapter-node
 * is added and installed. adapter-static or any other adapter is a decision
 * already taken, and this throws rather than override it.
 */
export async function ensureNodeAdapter(
	root: string,
	{ install = true }: EnsureNodeAdapterOptions = {}
): Promise<EnsureNodeAdapterOutcome> {
	const target = resolveKitTarget(root);
	const { info, importDecl } = inspectAdapter(target);
	const name = path.basename(target.filePath);
	const outcome: EnsureNodeAdapterOutcome = {
		previous: info.kind,
		removedDeps: [],
		packageJsonChanged: false
	};

	if (target.readOnly) {
		// A SvelteKit 2 project. Already on adapter-node, it deploys as it is:
		// package.json is left alone too, since the adapter-node vela would add
		// is the Kit 3 major. Anything else is a switch vela makes only on Kit 3.
		if (info.kind === 'node') return outcome;
		throw new AdapterError(
			`${name} found: this is a SvelteKit 2 project, and vela only changes the adapter\n` +
				`of a SvelteKit 3 one. vela deploy runs the app as a Node server, which needs\n` +
				`${ADAPTER_NODE}. Add it to ${name} yourself, or migrate the project with\n\n` +
				`  ${KIT3_MIGRATE_COMMAND}\n`
		);
	}

	switch (info.kind) {
		case 'node':
			break;
		case 'static':
			throw new AdapterError(
				`This project builds a static site with ${ADAPTER_STATIC} (${name}).\n\n` +
					`vela deploy runs the app as a Node server, which needs ${ADAPTER_NODE}. Switch\n` +
					`the adapter to deploy it here, or host the static output elsewhere.`
			);
		case 'other':
			throw new AdapterError(
				`This project's adapter${info.specifier ? ` (${info.specifier})` : ''} in ${name} is not one\n` +
					`vela will change for you.\n\n` +
					`vela deploy runs the app as a Node server, which needs ${ADAPTER_NODE}:`
			);
		case 'auto':
			switchImport(target, importDecl!);
			outcome.configFile = name;
			break;
		case 'none':
			addAdapter(target);
			outcome.configFile = name;
			break;
	}

	if (outcome.configFile) saveTarget(target);

	const pkgPath = path.join(root, 'package.json');
	if (fs.existsSync(pkgPath)) {
		const pkg = readPackageJson(pkgPath);
		const { changed, removed } = adoptNodeAdapter(pkg);
		if (changed) {
			writePackageJson(pkgPath, pkg);
			outcome.packageJsonChanged = true;
			outcome.removedDeps = removed;
		}
	}

	if (outcome.packageJsonChanged && install) {
		outcome.installedWith = await installAdapterDependencies(root);
	}

	return outcome;
}

/**
 * The install that follows a package.json change, with the project's own
 * package manager. Separate so a caller can announce the switch before the
 * install's output starts scrolling.
 */
export async function installAdapterDependencies(root: string): Promise<AgentName> {
	const agent = await packageManager(root);
	if (!isInstalled(agent)) {
		throw new AdapterError(
			`${agent} is not installed, so ${ADAPTER_NODE} couldn't be installed.\n\n` +
				`The config and package.json are already updated: install ${agent}, run \`${agent} install\`, then deploy again.`,
			''
		);
	}
	const ok = await installDependencies(agent, root, { exitOnFailure: false });
	if (!ok) {
		throw new AdapterError(
			`Installing ${ADAPTER_NODE} with ${agent} failed.\n\n` +
				`The config and package.json are already updated: run \`${agent} install\`, then deploy again.`,
			''
		);
	}
	return agent;
}

/** The object the write paths edit: always there, since only an inline vite.config target is written. */
function editableKit(target: KitTarget): ObjectLiteralExpression {
	if (target.readOnly || !target.kit)
		throw new AdapterError(`${path.basename(target.filePath)} is not a config vela edits.`);
	return target.kit;
}

/** adapter-auto → adapter-node on the existing import; the call takes no arguments either way. */
function switchImport(target: KitTarget, importDecl: ImportDeclaration): void {
	importDecl.setModuleSpecifier(ADAPTER_NODE);
	const prop = editableKit(target)
		.getPropertyOrThrow('adapter')
		.asKindOrThrow(SyntaxKind.PropertyAssignment);
	const call = prop.getInitializerIfKindOrThrow(SyntaxKind.CallExpression);
	for (let i = call.getArguments().length - 1; i >= 0; i--) call.removeArgument(i);
	dropAdapterAutoComments(target);
}

/**
 * `sv create` leaves three lines above the adapter explaining that adapter-auto
 * only supports some environments. True, and the reason it is being replaced;
 * left in place they would describe an adapter the file no longer imports.
 * Only comments that are recognisably that boilerplate go; anything else the
 * author wrote stays. Done last: replacing text forgets every node above.
 */
const ADAPTER_AUTO_COMMENT = /adapter-auto|svelte\.dev\/docs\/kit\/adapters|switch out the adapter/;

function dropAdapterAutoComments(target: KitTarget): void {
	const prop = editableKit(target).getPropertyOrThrow('adapter');
	const ranges = prop.getLeadingCommentRanges();
	if (ranges.length === 0 || !ranges.every((r) => ADAPTER_AUTO_COMMENT.test(r.getText()))) return;

	const fullStart = prop.getFullStart();
	const start = prop.getStart();
	const trivia = target.sourceFile.getFullText().slice(fullStart, start);
	const lastNewline = trivia.lastIndexOf('\n');
	// A comment on the property's own line is not the boilerplate shape.
	if (lastNewline === -1) return;
	const indent = trivia.slice(lastNewline + 1);
	target.sourceFile.replaceText([fullStart, start], `\n${indent}`);
}

/** No adapter configured: import adapter-node and set it in the sveltekit() argument. */
function addAdapter(target: KitTarget): void {
	const taken =
		importOf(target.sourceFile, 'adapter') ?? target.sourceFile.getVariableDeclaration('adapter');
	if (taken) {
		throw new AdapterError(
			`${path.basename(target.filePath)} already binds the name \`adapter\` to something that is not the SvelteKit adapter.`
		);
	}
	target.sourceFile.addImportDeclaration({
		defaultImport: 'adapter',
		moduleSpecifier: ADAPTER_NODE
	});
	editableKit(target).addPropertyAssignment({ name: 'adapter', initializer: 'adapter()' });
}

/** Write the file only if the edit changed it; format only when an argument was created from nothing. */
function saveTarget(target: KitTarget): void {
	if (target.created) formatLikeSource(target.sourceFile);
	if (target.sourceFile.getFullText() === target.originalText) return;
	target.sourceFile.saveSync();
}

/**
 * Move package.json onto adapter-node: adapter-auto goes, adapter-node is added
 * as a devDependency unless the project already lists it somewhere. Exported for
 * tests; mutates `pkg`.
 */
export function adoptNodeAdapter(pkg: PkgJson): { changed: boolean; removed: string[] } {
	const removed: string[] = [];
	let changed = false;
	for (const kind of ['dependencies', 'devDependencies'] as const) {
		const deps = pkg[kind];
		if (deps && ADAPTER_AUTO in deps) {
			delete deps[ADAPTER_AUTO];
			removed.push(ADAPTER_AUTO);
			changed = true;
		}
	}
	if (!pkg.dependencies?.[ADAPTER_NODE] && !pkg.devDependencies?.[ADAPTER_NODE]) {
		pkg.devDependencies = sortKeys({ ...pkg.devDependencies, [ADAPTER_NODE]: ADAPTER_NODE_RANGE });
		changed = true;
	}
	return { changed, removed: [...new Set(removed)] };
}

/** The lockfile a package manager writes, for telling the user what to commit. */
export function lockfileFor(agent: AgentName): string {
	switch (agent) {
		case 'pnpm':
			return 'pnpm-lock.yaml';
		case 'yarn':
			return 'yarn.lock';
		case 'bun':
			return 'bun.lock';
		case 'deno':
			return 'deno.lock';
		default:
			return 'package-lock.json';
	}
}

async function packageManager(root: string): Promise<AgentName> {
	return (await detect({ cwd: root }))?.name ?? getUserAgent() ?? 'npm';
}
