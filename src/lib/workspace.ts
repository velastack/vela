import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { APP_DIR, PUBLIC_DIR, DATA_DIR } from './constants.ts';
import { readComponentsJson } from './components-json.ts';
import { readPackageJson } from './package-json.ts';

export type Ui = 'shadcn' | 'plain';

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
	cms: boolean;
	/** The workflow runtime; in the base template since 0.13, so older projects lack it. */
	workflows: boolean;
	/** The component kit generators can assume; `plain` means native elements. */
	ui: Ui;
}

/**
 * The route groups the project has, as directory names under `src/routes`.
 * `null` means there is no such group, as in a SvelteKit project vela did not
 * create, so patterns place default routes directly under `src/routes`.
 */
export interface RouteGroups {
	public: string | null;
	app: string | null;
}

export interface Workspace {
	workspaceRootDir: string;
	routesDir: string;
	publicRoutesDir: string;
	appRoutesDir?: string;
	routeGroups: RouteGroups;
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

/**
 * Where this project keeps the state that is not source.
 *
 * The same directory on a server is `shared/pb_data`, which is the whole reason
 * `vela` puts it in the environment as `VELA_DATA_DIR` instead of letting an app
 * work it out from its own working directory. That one is the project root here
 * and a release directory there, so an app that derives the path lands its
 * database inside a release — where the next deploy leaves it behind and the
 * pruner eventually deletes it.
 */
/**
 * Whether the project has API routes of its own. The minimal template ships
 * `src/routes/api/README.md`, so the directory existing proves nothing; only
 * entries besides that README count.
 */
export function hasApiRoutes(root: string): boolean {
	const dir = path.join(root, 'src', 'routes', 'api');
	if (!fs.existsSync(dir)) return false;
	return fs.readdirSync(dir).some((entry) => entry !== 'README.md');
}

export function localDataDir(from: string = process.cwd()): string {
	return path.join(findWorkspaceRoot(from) ?? from, DATA_DIR);
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

	const routeGroups = detectRouteGroups(workspaceRootDir);
	const publicRoutesDir = path.join(routesDir, routeGroups.public ?? '');
	const isAppMode = routeGroups.app !== null;
	const appRoutesDir = routeGroups.app ? path.join(routesDir, routeGroups.app) : undefined;

	const isPaymentsMode = fs.existsSync(
		path.join(workspaceRootDir, routesDir, 'webhooks', 'stripe')
	);

	const features = detectFeatures(workspaceRootDir, { isAppMode, isPaymentsMode });

	return {
		workspaceRootDir,
		routesDir,
		publicRoutesDir,
		appRoutesDir,
		routeGroups,
		isAppMode,
		isPaymentsMode,
		features
	};
}

export function detectRouteGroups(root: string): RouteGroups {
	const group = (name: string) =>
		fs.existsSync(path.join(root, 'src', 'routes', name)) ? name : null;
	return { public: group(PUBLIC_DIR), app: group(APP_DIR) };
}

/**
 * shadcn markup needs both halves: `components.json` is what `shadcn-svelte
 * add` reads, and the dependency is what the installed components import. A
 * project with neither gets native elements, which need nothing installed.
 */
export function detectUi(root: string): Ui {
	const pkg = readPackageJson(path.join(root, 'package.json'));
	const hasDep = (name: string) => Boolean(pkg.dependencies?.[name] || pkg.devDependencies?.[name]);
	const shadcn =
		readComponentsJson(root) !== undefined && (hasDep('shadcn-svelte') || hasDep('bits-ui'));
	return shadcn ? 'shadcn' : 'plain';
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
		api: hasApiRoutes(root),
		apiKeys: has('src/routes/api/api-keys') || has('src/routes/(app)/api-keys'),
		backend: has(DATA_DIR),
		i18n: has('wuchale.config.js') || hasDep('wuchale'),
		teams: has('src/routes/(app)/teams') || has('src/lib/teams'),
		payments: isPaymentsMode,
		blog: hasDep('mdsvex'),
		contentNegotiation: hasDep('sveltekit-negotiate'),
		cms: hasDep('@velastack/cms'),
		workflows: has('src/lib/server/workflows.ts'),
		ui: detectUi(root)
	};
}
