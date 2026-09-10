import { isProd } from './instance.ts';

/**
 * Whether `vela destroy deployment` may go ahead, and on what say-so.
 *
 * Two removals cannot be undone by deploying again: production, and anything
 * with `--purge`, which takes the database. On a terminal those ask for the app
 * name typed in full. Off a terminal, `--yes` used to stand in for that prompt,
 * which is how a workflow passing `--yes` on every event removed a live site on
 * 2026-09-10. Now only `--confirm <app-name>` does: the same words the terminal
 * would ask for, written into the workflow on purpose.
 */
export interface DestroyRequest {
	appName: string;
	envTag: string;
	purge: boolean;
	yes: boolean;
	/** `--confirm`, as typed. */
	confirm?: string;
	/** Whether a prompt can be shown at all. */
	interactive: boolean;
}

export type DestroyDecision =
	| { kind: 'proceed' }
	/** Ask on the terminal; `byName` means the app name must be typed. */
	| { kind: 'prompt'; byName: boolean }
	| { kind: 'refuse'; message: string };

/** A preview's data is disposable by definition; purging it needs no more say-so than removing it. */
function isPreview(envTag: string): boolean {
	return envTag.startsWith('preview--');
}

export function destroyDecision(request: DestroyRequest): DestroyDecision {
	const { appName, purge, yes, confirm, interactive } = request;
	const dangerous = isProd(request.envTag) || (purge && !isPreview(request.envTag));
	const what = describe(request);

	if (confirm !== undefined) {
		if (confirm === appName) return { kind: 'proceed' };
		return {
			kind: 'refuse',
			message: `\`--confirm ${confirm}\` does not name this app. Removing ${what} takes \`--confirm ${appName}\`.`
		};
	}

	if (dangerous) {
		if (yes) {
			return {
				kind: 'refuse',
				message:
					`\`--yes\` is not enough to remove ${what}.\n\n` +
					`Pass \`--confirm ${appName}\` as well — the app name, the same thing a terminal would ask you to type.`
			};
		}
		if (interactive) return { kind: 'prompt', byName: true };
		return {
			kind: 'refuse',
			message:
				`Removing ${what} needs a confirmation, and there is no terminal to ask on.\n\n` +
				`Pass \`--confirm ${appName}\` — the app name, the same thing a terminal would ask you to type.`
		};
	}

	if (yes) return { kind: 'proceed' };
	if (interactive) return { kind: 'prompt', byName: false };
	return {
		kind: 'refuse',
		message: `Removing ${what} needs a confirmation, and there is no terminal to ask on. Pass \`--yes\`.`
	};
}

function describe({ appName, envTag, purge }: DestroyRequest): string {
	const target = isProd(envTag) ? 'production' : `the ${envTag} environment`;
	return purge ? `${target} of ${appName} and its database` : `${target} of ${appName}`;
}
