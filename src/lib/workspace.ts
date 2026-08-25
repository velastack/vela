import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { APP_DIR, PUBLIC_DIR, DATA_DIR } from './constants.ts';
import { readPackageJson } from './package-json.ts';

export interface Features {
	auth: boolean;
	api: boolean;
	apiKeys: boolean;
	backend: boolean;
	i18n: boolean;
	teams: boolean;
	payments: boolean;
	blog: boolean;
	contentNegotiation: boolean;
}

export interface Workspace {
	workspaceRootDir: string;
	routesDir: string;
	publicRoutesDir: string;
	appRoutesDir?: string;
	isAppMode: boolean;
	isPaymentsMode: boolean;
	features: Features;
}

/**
 * Nearest ancestor holding a package.json, or null when there is none.
 */
export function findWorkspaceRoot(from: string = process.cwd()): string | null {
	let currentDir = from;

	while (currentDir !== path.parse(currentDir).root) {
		if (fs.existsSync(path.join(currentDir, 'package.json'))) return currentDir;
		currentDir = path.dirname(currentDir);
	}

	return null;
}

/**
 * Whether the project has a PocketBase backend at all.
 *
 * The `data` directory is the marker: `vela create` writes it for backend
 * templates and `vela bless` adds it to an existing project, while the static
 * template has none. Commands that would start or talk to PocketBase have to
 * check this first — a static project has no database, and therefore no
 * credentials to ask for.
 *
 * Kept in step with `Features.backend`, which is derived from the same marker.
 */
export function hasBackend(from: string = process.cwd()): boolean {
	const root = findWorkspaceRoot(from);
	return root !== null && fs.existsSync(path.join(root, DATA_DIR));
}

export async function getWorkspace(): Promise<Workspace> {
	const workspaceRootDir = findWorkspaceRoot();

	if (!workspaceRootDir) {
		throw new Error('Could not find workspace root (no package.json found)');
	}

	const routesDir = path.join('src', 'routes');
	const fullRoutesPath = path.join(workspaceRootDir, routesDir);

	if (!fs.existsSync(fullRoutesPath)) {
		throw new Error('Could not find src/routes directory');
	}

	let publicRoutesDir = path.join(routesDir, PUBLIC_DIR);
	if (!fs.existsSync(path.join(workspaceRootDir, publicRoutesDir))) {
		publicRoutesDir = routesDir;
	}

	let appRoutesDir: string | undefined;
	const appRoutesPath = path.join(fullRoutesPath, APP_DIR);
	const isAppMode = fs.existsSync(appRoutesPath);
	if (isAppMode) appRoutesDir = path.join(routesDir, APP_DIR);

	const isPaymentsMode = fs.existsSync(
		path.join(workspaceRootDir, routesDir, 'webhooks', 'stripe')
	);

	const features = detectFeatures(workspaceRootDir, { isAppMode, isPaymentsMode });

	return {
		workspaceRootDir,
		routesDir,
		publicRoutesDir,
		appRoutesDir,
		isAppMode,
		isPaymentsMode,
		features
	};
}

function detectFeatures(
	root: string,
	{ isAppMode, isPaymentsMode }: { isAppMode: boolean; isPaymentsMode: boolean }
): Features {
	const has = (rel: string) => fs.existsSync(path.join(root, rel));
	const pkg = readPackageJson(path.join(root, 'package.json'));
	const hasDep = (name: string) => Boolean(pkg.dependencies?.[name] || pkg.devDependencies?.[name]);

	return {
		auth: isAppMode,
		api: has('src/routes/api'),
		apiKeys: has('src/routes/api/api-keys') || has('src/routes/(app)/api-keys'),
		backend: has(DATA_DIR),
		i18n: has('src/lib/i18n') || has('messages'),
		teams: has('src/routes/(app)/teams') || has('src/lib/teams'),
		payments: isPaymentsMode,
		blog: hasDep('mdsvex'),
		contentNegotiation: hasDep('sveltekit-negotiate')
	};
}
