import { Command } from 'commander';
import { helpConfig } from './help.ts';
import { notImplemented } from './run.ts';

export const STUB = Symbol('stub');

interface StubCommand extends Command {
	[STUB]?: true;
}

export function isStub(cmd: Command): boolean {
	return (cmd as StubCommand)[STUB] === true;
}

export function stubCommand(name: string, description: string, fullName?: string): Command {
	const cmd: StubCommand = new Command(name)
		.description(description)
		.configureHelp(helpConfig)
		.action(() => notImplemented(fullName ?? name));
	cmd[STUB] = true;
	return cmd;
}
