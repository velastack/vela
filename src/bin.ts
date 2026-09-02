import process from 'node:process';
import { normalizeArgv } from './lib/argv.ts';
import { program } from './program.ts';

program.parse(normalizeArgv(process.argv.slice(2)), { from: 'user' });
