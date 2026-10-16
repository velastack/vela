/**
 * `vela generate migration --ai`: edit the schema in a browser.
 *
 * Boots a throwaway PocketBase on a fresh data directory, replays the
 * project's migrations into it, serves the editor over it, and opens the
 * browser. Edits the user applies become migration files in the project's
 * migrations directory, written by PocketBase itself. The project's own
 * database is never touched, and the running `vela dev` server, if any,
 * will need a restart to pick the new files up.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import PocketBase from 'pocketbase';
import type { CollectionsClient, PocketBaseCollection } from '@velastack/schema';
import { aiSchemaEdit, aiUnavailableReason } from './ai-client.ts';
import { MIGRATIONS_DIR } from './constants.ts';
import { authWithRetries, getPocketbaseMetadata, launchPocketbase } from './pocketbase.ts';
import { startSchemaServer } from './schema-server.ts';
import { onTerminate } from './terminate.ts';

/** The engine's small client, over the PocketBase SDK. */
export function sdkClient(pb: PocketBase): CollectionsClient {
	return {
		list: () => pb.collections.getFullList() as Promise<PocketBaseCollection[]>,
		create: (body) => pb.collections.create(body) as Promise<PocketBaseCollection>,
		update: (id, body) => pb.collections.update(id, body) as Promise<PocketBaseCollection>,
		delete: async (id) => {
			await pb.collections.delete(id);
		}
	};
}

export function openBrowser(url: string): void {
	const [command, args] =
		process.platform === 'darwin'
			? ['open', [url]]
			: process.platform === 'win32'
				? ['cmd', ['/c', 'start', '', url]]
				: ['xdg-open', [url]];
	try {
		spawn(command, args, { stdio: 'ignore', detached: true })
			.on('error', () => {})
			.unref();
	} catch {
		// The URL is printed either way.
	}
}

export interface SchemaEditorOptions {
	cwd: string;
	/** Do not open a browser; print the URL only. For tests and remote shells. */
	noOpen?: boolean;
}

export async function runSchemaEditor({ cwd, noOpen = false }: SchemaEditorOptions): Promise<void> {
	const migrationsDir = path.join(cwd, MIGRATIONS_DIR);
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vela-schema-'));
	const email = `schema-${Math.random().toString(36).slice(2)}@example.com`;
	const password = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);

	const spinner = p.spinner();
	spinner.start('Starting a temporary database from your migrations');

	let stop: (() => void) | undefined;
	let cleaned = false;
	const cleanup = () => {
		if (cleaned) return;
		cleaned = true;
		stop?.();
		fs.rmSync(tempDir, { recursive: true, force: true });
	};
	// Ctrl-C, SIGTERM and SIGHUP all run cleanup and exit from here.
	onTerminate(cleanup);

	try {
		const launched = await launchPocketbase(cwd, {
			dir: path.join(tempDir, 'data'),
			migrationsDir,
			email,
			password
		});
		stop = launched.stop;
		const pb = new PocketBase(launched.url);
		await authWithRetries(pb, email, password);

		const aiReason = aiUnavailableReason(cwd);
		const server = await startSchemaServer({
			client: sdkClient(pb),
			migrationsDir,
			project: path.basename(cwd),
			...(aiReason ? { aiUnavailable: aiReason } : { ai: (body) => aiSchemaEdit(cwd, body) }),
			onApplied: (written) => {
				p.log.success(
					`Wrote ${written.length} migration ${written.length === 1 ? 'file' : 'files'}:\n` +
						written.map((f) => `  ${pc.dim(MIGRATIONS_DIR + '/')}${f}`).join('\n')
				);
				if (getPocketbaseMetadata(cwd)) {
					p.log.warn(`Restart ${pc.cyan('vela dev')} to load them.`);
				}
			}
		});
		spinner.stop('Temporary database ready');

		p.log.info(`Schema editor: ${pc.cyan(server.url)}`);
		p.log.message(
			pc.dim('Edits you apply become migration files in migrations/. Press Ctrl+C when done.')
		);
		if (!noOpen) openBrowser(server.url);

		// Serve until a signal ends the process; onTerminate runs cleanup then.
		await new Promise<never>(() => {});
	} catch (error) {
		spinner.stop('Could not start the schema editor');
		// The launch command quotes its arguments, one of which is the throwaway
		// superuser's password; it is useless to anyone but still not for logs.
		if (error instanceof Error) error.message = error.message.replaceAll(password, '<password>');
		throw error;
	} finally {
		cleanup();
	}
}
