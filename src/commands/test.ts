import process from 'node:process';
import { Command } from 'commander';
import pc from 'picocolors';
import { x } from 'tinyexec';
import { detect } from 'package-manager-detector';
import { resolveCommand } from 'package-manager-detector/commands';
import { helpConfig } from '../lib/help.ts';
import { warnIfKit2 } from '../lib/kit-version.ts';
import { HarnessError, startTestHarness, type TestHarness } from '../lib/test-harness.ts';

/**
 * Run the server tests. The servers they need come up inside vitest, through
 * the `vela/testing` global setup the project's `vitest.config.ts` names, so
 * this is `vitest run` with vela's defaults: the `server` project, the dot
 * reporter, CI mode, and a pass on an empty suite.
 */
export const testServer = new Command('test:server')
	.description('run server tests')
	.allowUnknownOption(true)
	.allowExcessArguments(true)
	.configureHelp(helpConfig)
	.action(async (_opts, cmd) => {
		const cwd = process.cwd();
		warnIfKit2(cwd, (m) => console.warn(pc.yellow(`▲ ${m}`)));

		const extraArgs: string[] = (cmd.parent?.args ?? []).slice(1);
		// With no filter of the user's, an empty suite is a project that has not
		// written a server test yet (straight after `vela enable backend`), not a
		// failure. A filter that matches nothing is more likely a typo, and fails.
		const filtered = extraArgs.some((arg) => !arg.startsWith('-'));

		try {
			const pm = (await detect({ cwd }))?.name ?? 'npm';
			const resolved = resolveCommand(pm, 'execute', [
				'vitest',
				'run',
				'--project',
				'server',
				'--reporter=dot',
				...(filtered ? [] : ['--passWithNoTests']),
				...extraArgs
			])!;
			const resolvedArgs = resolved.args.slice();
			if (pm === 'npm') resolvedArgs.unshift('--yes');
			const result = await x(resolved.command, resolvedArgs, {
				nodeOptions: { cwd, stdio: 'inherit', env: { ...process.env, CI: '1' } }
			});
			// A failing suite is this command failing: CI reads the exit code.
			process.exitCode = result.exitCode ?? 1;
		} catch (e) {
			console.error(`${pc.redBright('✗')} ${(e as Error).message}`);
			process.exitCode = 1;
		}
	});

/**
 * Start the servers for a server-test run and keep them up until the parent
 * says stop or goes away. `vela/testing` spawns this from vitest's global
 * setup with an IPC channel; the servers' addresses go back over it, and the
 * app's own output goes to the inherited stdio.
 *
 * In its own process rather than inside vitest because the app's Vite server
 * loads the project's `vite.config.ts` with its full plugin set, which vitest
 * has already loaded for itself; two of those in one process share caches
 * they should not.
 */
export const testHarness = new Command('test:harness')
	.description('start the servers for server tests and wait (used by vela/testing)')
	.configureHelp(helpConfig)
	.action(async () => {
		const cwd = process.cwd();
		if (!process.send) {
			console.error(
				`${pc.redBright('✗')} vela test:harness is started by vitest through \`vela/testing\`. Run \`vela test:server\` instead.`
			);
			process.exit(1);
		}

		let harness: TestHarness | undefined;
		let exiting = false;
		const exit = async (code: number) => {
			if (exiting) return;
			exiting = true;
			await harness?.stop();
			process.exit(code);
		};
		process.on('exit', () => harness?.stopSync());
		// Not onTerminate: a run stopped by a signal must not exit 0.
		for (const [signal, code] of [
			['SIGINT', 130],
			['SIGTERM', 143],
			['SIGHUP', 129]
		] as const) {
			process.on(signal, () => void exit(code));
		}
		// The parent going away, however it went, ends the run.
		process.on('disconnect', () => void exit(0));
		process.on('message', (message) => {
			if (message === 'stop') void exit(0);
		});

		try {
			harness = await startTestHarness(cwd, {
				log: (message) => console.log(`${pc.greenBright('✓')} ${message}`)
			});
		} catch (e) {
			const message =
				e instanceof HarnessError
					? e.message
					: `Failed to start the test servers: ${(e as Error).message}`;
			console.error(`${pc.redBright('✗')} ${message}`);
			process.send({ type: 'error', message });
			process.exit(1);
		}

		const { pocketbaseUrl, appUrl, superuser, dataDir, env } = harness;
		process.send({
			type: 'ready',
			servers: { pocketbaseUrl, appUrl, superuser, dataDir },
			env
		});
	});
