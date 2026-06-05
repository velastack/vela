import * as p from '@clack/prompts';
import pc from 'picocolors';
import { UnsupportedError } from './errors.ts';

type MaybePromise = () => Promise<void> | void;

export async function runCommand(action: MaybePromise, failureMessage?: string): Promise<void> {
	try {
		await action();
	} catch (e) {
		if (e instanceof UnsupportedError) {
			const padding = Math.max(...e.reasons.map((r) => r.id.length), 0);
			const message = e.reasons
				.map((r) => `  ${r.id.padEnd(padding)}  ${pc.redBright(r.reason)}`)
				.join('\n');
			p.log.error(`${e.name}\n\n${message}`);
			p.log.message();
		} else if (e instanceof Error) {
			const prefix = failureMessage ? `${failureMessage} ` : '';
			p.log.error(`${prefix}${e.message}`);
			p.log.message();
		}
		p.cancel('Operation failed.');
		process.exitCode = 1;
	}
}

export function notImplemented(name: string) {
	return runCommand(async () => {
		p.log.warn(`\`${name}\` is not yet implemented — see ${pc.cyan('https://docs.velastack.dev')}`);
	});
}
