import process from 'node:process';
import { fileURLToPath } from 'node:url';
import pkg from '../package.json' with { type: 'json' };
import { normalizeArgv } from './lib/argv.ts';
import { delegateToLocalCli } from './lib/delegate.ts';
import { program } from './program.ts';

// Normalized before delegating so a pinned CLI is handed the same arguments.
const argv = normalizeArgv(process.argv.slice(2));

const delegatedExitCode = delegateToLocalCli({
	argv,
	selfPath: fileURLToPath(import.meta.url),
	selfVersion: pkg.version
});

if (delegatedExitCode !== null) {
	process.exit(delegatedExitCode);
}

program.parse(argv, { from: 'user' });
