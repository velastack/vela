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

export async function getWorkspace(): Promise<Workspace> {
	let currentDir = process.cwd();
	let workspaceRootDir = '';

	while (currentDir !== path.parse(currentDir).root) {
		if (fs.existsSync(path.join(currentDir, 'package.json'))) {
			workspaceRootDir = currentDir;
			break;
		}
		currentDir = path.dirname(currentDir);
	}

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
