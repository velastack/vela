import { Command } from 'commander';
import * as v from 'valibot';
import type { SshOptions } from './ssh.ts';

/** Flags every server-facing command shares. */
export const SSH_OPTION_SCHEMA = {
	identity: v.optional(v.string()),
	sshPort: v.optional(v.string()),
	acceptHostKeys: v.optional(v.boolean())
};

export function addSshOptions(command: Command): Command {
	return command
		.option('-i, --identity <file>', 'SSH private key to authenticate with')
		.option('--ssh-port <port>', 'SSH port')
		.option('--accept-host-keys', 'trust an unknown host key on first connect (CI)');
}

export function sshOptionsFrom(options: {
	identity?: string;
	sshPort?: string;
	acceptHostKeys?: boolean;
}): SshOptions {
	return {
		identityFile: options.identity,
		port: options.sshPort ? Number(options.sshPort) : undefined,
		acceptNewHostKeys: options.acceptHostKeys
	};
}
