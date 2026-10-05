type Reason = { id: string; reason: string };

export class UnsupportedError extends Error {
	override name = 'Unsupported Environment';
	reasons: Reason[];
	constructor(reasons: Reason[]) {
		super();
		this.reasons = reasons;
	}
}

/**
 * Exit status of a deploy refused because its target was removed after the
 * deploy began. Matches REMOVED_EXIT in templates/server/lib.sh, which is what
 * `apply.sh` exits with; the GitHub Action reads it to report a skipped
 * preview rather than a failed one. (Node also uses 3, for an internal parse
 * error in its own bootstrap, which a published CLI does not hit.)
 */
export const TARGET_REMOVED_EXIT = 3;

/** A deploy that found its target removed while it was building. Nothing was deployed. */
export class TargetRemovedError extends Error {
	override name = 'TargetRemovedError';
	readonly exitCode = TARGET_REMOVED_EXIT;
}
