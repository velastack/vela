import fs from 'node:fs';
import path from 'node:path';

export function addEnvVar(content: string, key: string, value: string): string {
	if (content.includes(`${key}=`)) return content;
	return appendLine(content, `${key}=${value}`);
}

export function addEnvComment(content: string, comment: string): string {
	const commented = `# ${comment}`;
	if (content.includes(commented)) return content;
	return appendLine(content, commented);
}

function appendLine(existing: string, line: string): string {
	const withNewline = !existing.length || existing.endsWith('\n') ? existing : existing + '\n';
	return withNewline + line + '\n';
}

export function writeEnvFile(
	cwd: string,
	vars: Record<string, string>,
	comments: string[] = []
): void {
	const envPath = path.join(cwd, '.env');
	let content = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
	for (const comment of comments) content = addEnvComment(content, comment);
	for (const [key, value] of Object.entries(vars)) content = addEnvVar(content, key, value);
	fs.writeFileSync(envPath, content);
}

/**
 * Set a value in a `.env` file, in place.
 *
 * `addEnvVar` above is append-only and silently does nothing when the key is
 * already present, which is right for scaffolding and wrong for `vela env set`.
 * This rewrites the existing line where there is one and appends otherwise, so
 * the comments, ordering and spacing a person put in the file survive being
 * edited by the CLI.
 */
export function upsertEnvVar(content: string, key: string, value: string): string {
	const line = `${key}=${quoteEnvValue(value)}`;
	const pattern = keyPattern(key);

	let replaced = false;
	const lines = content.split('\n').map((existing) => {
		if (replaced || !pattern.test(existing)) return existing;
		replaced = true;
		// `export KEY=` is valid dotenv, and dropping the prefix would change how
		// the file behaves when it is sourced by a shell.
		return existing.trimStart().startsWith('export ') ? `export ${line}` : line;
	});

	return replaced ? lines.join('\n') : appendLine(content, line);
}

/** Remove a key from a `.env` file, leaving the rest of it alone. */
export function removeEnvVar(content: string, key: string): string {
	const pattern = keyPattern(key);
	const lines = content.split('\n');
	const kept = lines.filter((line) => !pattern.test(line));
	if (kept.length === lines.length) return content;
	return kept.join('\n');
}

export function hasEnvVar(content: string, key: string): boolean {
	const pattern = keyPattern(key);
	return content.split('\n').some((line) => pattern.test(line));
}

function keyPattern(key: string): RegExp {
	return new RegExp(`^\\s*(?:export\\s+)?${escapeRegExp(key)}\\s*=`);
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Quote only what dotenv would otherwise misread.
 *
 * Deliberately not the systemd quoting `vela env` uses for the server: this file
 * is read by dotenv and by people, and quoting every value would churn lines
 * that did not need to change.
 */
function quoteEnvValue(value: string): string {
	if (/^[A-Za-z0-9_./:@+-]*$/.test(value)) return value;
	const escaped = value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n');
	return `"${escaped}"`;
}
