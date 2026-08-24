import process from 'node:process';
import { fileURLToPath } from 'node:url';
import pkg from '../package.json' with { type: 'json' };
import { delegateToLocalCli } from './lib/delegate.ts';
import { program } from './program.ts';

const delegatedExitCode = delegateToLocalCli({
	selfPath: fileURLToPath(import.meta.url),
	selfVersion: pkg.version
});

if (delegatedExitCode !== null) {
	process.exit(delegatedExitCode);
}

program.parse();
