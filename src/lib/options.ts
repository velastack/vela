import * as v from 'valibot';

/**
 * Validate commander's raw options against a schema, reporting failures as a
 * plain `Error`.
 *
 * `v.parse` throws a `ValiError`, and commander invokes actions outside any
 * handler of ours, so calling it directly puts a valibot stack trace in front of
 * a user who merely mistyped a flag. Called inside `runCommand`, this instead
 * surfaces every bad flag through the CLI's normal error reporting.
 */
export function parseOptions<S extends v.GenericSchema>(schema: S, raw: unknown): v.InferOutput<S> {
	const result = v.safeParse(schema, raw);
	if (result.success) return result.output;
	const seen = new Set<string>();
	const lines = result.issues.map(describeIssue).filter((line) => {
		if (seen.has(line)) return false;
		seen.add(line);
		return true;
	});
	throw new Error(lines.join('\n'));
}

function describeIssue(issue: v.BaseIssue<unknown>): string {
	const key = optionKey(issue);
	return key ? `--${toFlag(key)}: ${issue.message}` : issue.message;
}

/** The option a nested issue belongs to — the first string key on its path. */
function optionKey(issue: v.BaseIssue<unknown>): string | undefined {
	for (const item of issue.path ?? []) {
		if (typeof item.key === 'string') return item.key;
	}
	return undefined;
}

/** `skipRoutes` is what valibot sees; `--skip-routes` is what the user typed. */
function toFlag(key: string): string {
	return key.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`);
}
