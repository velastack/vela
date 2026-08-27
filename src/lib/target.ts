import { branchToEnvTag, normalizeEnvTag, PROD_ENV } from './instance.ts';

/**
 * Which copy of the app a command acts on.
 *
 * A target never names a machine. `local` is the project on this computer;
 * everything else is an environment deployed somewhere, and the server behind it
 * is a binding recorded in `.vela/project.json` rather than something retyped on
 * every command.
 */
export interface LocalTarget {
	kind: 'local';
}

export interface RemoteTarget {
	kind: 'remote';
	/** Canonical name, as typed and as shown back. */
	name: string;
	/** Server-side instance suffix. Derived, never stored. */
	envTag: string;
}

/** Parsed so the grammar is settled, refused until previews are built. */
export interface PreviewTarget {
	kind: 'preview';
	branch?: string;
	envTag: string;
}

export type Target = LocalTarget | RemoteTarget | PreviewTarget;

export const LOCAL_TARGET = 'local';
export const PRODUCTION_TARGET = 'production';

/** What a command means when no `-t` is given. */
export type TargetFallback = 'local' | 'production';

export class TargetError extends Error {}

/**
 * Values that are obviously a server rather than a target.
 *
 * `-t` used to mean the SSH host, so `vela env list -t root@1.2.3.4` parsed
 * happily before this change and would otherwise go on parsing — resolving to a
 * target named after a machine instead of failing. An ssh_config alias with no
 * dots (`myserver`) is indistinguishable from a custom target name and is not
 * caught here; the dotted, `@`-bearing and numeric forms cover what people
 * actually typed.
 */
const SERVER_SHAPED = /@|^\d{1,3}(?:\.\d{1,3}){3}$|\.[a-z]{2,}$/i;

const PREVIEW = 'preview';

const TARGET_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Read a `-t/--target` value.
 *
 * `preview:<branch>` is split before any normalization: `normalizeEnvTag` turns a
 * colon into a single dash, so `preview:feature/maps` would become
 * `preview-feature-maps` while `branchToEnvTag('feature/maps')` gives
 * `preview--feature-maps`. Two spellings of one branch pointing at two different
 * instances is the kind of thing that is only discovered on a server.
 */
export function parseTarget(raw: string | undefined, fallback: TargetFallback): Target {
	const value = raw?.trim();
	if (!value) {
		return fallback === 'local' ? { kind: 'local' } : production();
	}

	if (SERVER_SHAPED.test(value)) {
		throw new TargetError(
			`${value} looks like a server, and ${bold('-t')} now selects a target rather than a machine.\n\n` +
				`Targets are ${bold('local')}, ${bold('production')}, or a name you choose such as ${bold('staging')}.\n` +
				`To point a target at a server, pass ${bold('--server')} on \`vela deploy\`.`
		);
	}

	const lower = value.toLowerCase();
	if (lower === LOCAL_TARGET) return { kind: 'local' };

	if (lower === PREVIEW || lower.startsWith(`${PREVIEW}:`)) {
		const branch = lower.slice(PREVIEW.length + 1) || undefined;
		return {
			kind: 'preview',
			branch,
			// Held for when previews are built, so the grammar and the instance
			// naming cannot drift apart in the meantime.
			envTag: branch ? branchToEnvTag(branch) : PREVIEW
		};
	}

	if (value.includes(':')) {
		throw new TargetError(
			`${value} is not a target. Only ${bold('preview')} takes a \`:branch\` suffix.`
		);
	}

	// Validated, never scrubbed. `normalizeEnvTag` would quietly turn `pre view!`
	// into `pre-view`, and a selector that silently addresses a different — and
	// therefore empty — instance reports success for a typo.
	if (!TARGET_NAME.test(lower)) {
		throw new TargetError(
			`${value} is not a target name.\n\n` +
				`Use lowercase letters, digits and single dashes, such as ${bold('staging')}.`
		);
	}

	return { kind: 'remote', name: lower, envTag: normalizeEnvTag(lower) };
}

function production(): Target {
	return { kind: 'remote', name: PRODUCTION_TARGET, envTag: PROD_ENV };
}

/** How a target reads back in output and errors. */
export function describeTarget(target: Target): string {
	switch (target.kind) {
		case 'local':
			return LOCAL_TARGET;
		case 'preview':
			return target.branch ? `${PREVIEW}:${target.branch}` : PREVIEW;
		case 'remote':
			return target.name;
	}
}

function bold(text: string): string {
	return `\`${text}\``;
}
