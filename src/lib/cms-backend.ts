import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import pc from 'picocolors';
import { findWorkspaceRoot, localDataDir } from './workspace.ts';

/**
 * The slice of `@velastack/cms/backend` the CLI drives.
 *
 * Declared here rather than imported because the package is the project's
 * dependency, not the CLI's: `vela enable cms` installs it into the app, and
 * `vela cms editor …` has to open the same database that app serves, through
 * the same version of the package. Resolving from the project also means a
 * global `vela` and a project-pinned one behave identically.
 */
export interface CmsEditor {
	id: string;
	email: string;
	name: string;
}

export interface CmsEditorStore {
	create(input: {
		email: string;
		password: string;
		name?: string;
		projects?: string[];
	}): Promise<CmsEditor>;
	setPassword(idOrEmail: string, password: string): Promise<void>;
	list(): CmsEditor[];
	projectsFor(idOrEmail: string): string[];
}

export interface CmsBackend {
	editors: CmsEditorStore;
	close(): void;
}

interface CmsBackendModule {
	createCmsBackend(options: { dbPath: string; uploadDir: string }): CmsBackend;
}

/**
 * The project id a single-tenant mount resolves every request to. It is the
 * backend's own default, so an editor granted this id can sign in to the app
 * `vela enable cms` produced without any further configuration.
 */
export const DEFAULT_PROJECT = 'default';

/** Where the app keeps the CMS database, as `dataPath('cms.sqlite')` resolves it. */
export function cmsDatabasePath(root: string): string {
	return path.join(localDataDir(root), 'cms.sqlite');
}

async function loadBackendModule(root: string): Promise<CmsBackendModule> {
	let entry: string;
	try {
		entry = createRequire(path.join(root, 'package.json')).resolve('@velastack/cms/backend');
	} catch {
		throw new Error(
			`@velastack/cms is not installed in this project.\n\n` +
				`Run ${pc.cyan('vela enable cms')} first.`
		);
	}
	return (await import(pathToFileURL(entry).href)) as CmsBackendModule;
}

/**
 * Open the project's CMS backend, run `fn` against it, and close it.
 *
 * Opens the database at the same path the app uses — `<data dir>/cms.sqlite`,
 * resolved from the workspace root rather than the working directory so the
 * command can be run from a subdirectory — and so writes to the editors the
 * running app signs in against.
 */
export async function withCmsBackend<T>(
	fn: (backend: CmsBackend) => Promise<T>,
	cwd: string = process.cwd()
): Promise<T> {
	const root = findWorkspaceRoot(cwd);
	if (!root) {
		throw new Error('Could not find workspace root (no package.json found)');
	}

	const { createCmsBackend } = await loadBackendModule(root);

	// These commands manage the editors of a backend this app hosts. A project
	// that reads from a hosted CMS has none here; its editors live with the host.
	if (!fs.existsSync(path.join(root, 'src', 'lib', 'server', 'cms.ts'))) {
		throw new Error(
			`This project does not host a CMS backend (no src/lib/server/cms.ts).\n\n` +
				`If it reads from a hosted CMS, manage its editors there. ` +
				`To host the backend in this app, run ${pc.cyan('vela enable cms')} without --endpoint.`
		);
	}
	const dataDir = localDataDir(root);
	// A missing driver throws a message naming better-sqlite3 and how to
	// install it, which is exactly what should be shown.
	const backend = createCmsBackend({
		dbPath: path.join(dataDir, 'cms.sqlite'),
		uploadDir: path.join(dataDir, 'uploads')
	});

	try {
		return await fn(backend);
	} finally {
		backend.close();
	}
}
