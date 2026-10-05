import * as p from '@clack/prompts';
import pc from 'picocolors';
import { TargetRemovedError, UnsupportedError } from './errors.ts';

type MaybePromise = () => Promise<void> | void;

export async function runCommand(action: MaybePromise, failureMessage?: string): Promise<void> {
	try {
		await action();
	} catch (e) {
		if (e instanceof TargetRemovedError) {
			// Not a failure of the deploy so much as the absence of anything to
			// deploy to; said as such, and with its own exit status.
			p.log.warn(e.message);
			p.cancel('Nothing was deployed.');
			process.exitCode = e.exitCode;
			return;
		}
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
