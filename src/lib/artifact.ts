import fs from 'node:fs';
import path from 'node:path';
import { detect } from 'package-manager-detector';
import { resolveCommand } from 'package-manager-detector/commands';
import { spawnCapture } from './ssh.ts';
import { DATA_DIR, MIGRATIONS_DIR } from './constants.ts';
import type { VelaDeployConfig } from './deploy-config.ts';

export const DEFAULT_OUTPUT_DIR = 'build';

/** One entry in the release: a local path, and where it lands in the release. */
export interface ArtifactEntry {
	localPath: string;
	/** Remote subdirectory, or '' for the release root. */
	remoteDir: string;
}

export class BuildError extends Error {}

/**
 * Run the project's build. Defaults to the package manager's `build` script,
 * which in a vela project is `vela build` — the same command used locally, so
 * what ships is what was tested.
 */
export async function runBuild(cwd: string, buildCommand?: string): Promise<void> {
	if (buildCommand) {
		const result = await spawnCapture('bash', ['-lc', buildCommand], {
			cwd,
			stream: true,
			streamStdout: true
		});
		if (result.exitCode !== 0)
			throw new BuildError(`\`${buildCommand}\` exited ${result.exitCode}.`);
		return;
	}

	const pm = (await detect({ cwd }))?.name ?? 'npm';
	const resolved = resolveCommand(pm, 'run', ['build']);
	if (!resolved) throw new BuildError(`Could not work out how to run a build with ${pm}.`);
	const result = await spawnCapture(resolved.command, resolved.args, {
		cwd,
		stream: true,
		streamStdout: true
	});
	if (result.exitCode !== 0) {
		throw new BuildError(
			`\`${resolved.command} ${resolved.args.join(' ')}\` exited ${result.exitCode}.`
		);
	}
}

/**
 * Work out what goes into a release.
 *
 * The adapter output plus what PocketBase needs at runtime — nothing else. No
 * source, no dev dependencies, and deliberately no `.env`: production
 * environment lives on the server and is managed only by `vela env`.
 */
export function collectArtifact(cwd: string, config: VelaDeployConfig = {}): ArtifactEntry[] {
	const outputDir = config.outputDir ?? DEFAULT_OUTPUT_DIR;
	const entries: ArtifactEntry[] = [];
	const add = (rel: string, remoteDir = '') => {
		const localPath = path.join(cwd, rel);
		if (fs.existsSync(localPath)) entries.push({ localPath, remoteDir });
	};

	const buildPath = path.join(cwd, outputDir);
	if (!fs.existsSync(path.join(buildPath, 'index.js'))) {
		throw new BuildError(
			`No ${outputDir}/index.js after the build.\n\n` +
				`Deploying to a server needs @sveltejs/adapter-node. Install it and set it as\n` +
				`the adapter in your Vite or Svelte config, then build again.`
		);
	}
	entries.push({ localPath: buildPath, remoteDir: '' });

	add('package.json');
	add('package-lock.json');
	add('.npmrc');
	add(MIGRATIONS_DIR);
	// PocketBase hooks live under `data/` locally but next to the release on the
	// server, where `data/` is the instance's private database directory.
	const hooks = path.join(cwd, DATA_DIR, 'hooks');
	if (fs.existsSync(hooks)) entries.push({ localPath: hooks, remoteDir: 'hooks' });

	for (const extra of config.include ?? []) add(extra);

	return entries;
}

export function hasLockfile(cwd: string): boolean {
	return fs.existsSync(path.join(cwd, 'package-lock.json'));
}

/** Best-effort git metadata, recorded on the release for traceability. */
export async function gitSha(cwd: string): Promise<string> {
	const result = await spawnCapture('git', ['rev-parse', 'HEAD'], { cwd });
	return result.exitCode === 0 ? result.stdout.trim() : '';
}
