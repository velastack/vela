import fs from 'node:fs';
import path from 'node:path';
import { projectFileName } from './template-files.ts';

/**
 * What may already be in a directory `vela create` is pointed at: version
 * control, environment files, editor and OS droppings, a licence and a readme.
 * None of it is a project. Anything else makes the directory "not empty".
 */
const TOLERATED = [
	/^\.git$/,
	/^\.gitignore$/,
	/^\.gitattributes$/,
	/^\.github$/,
	/^\.env$/,
	/^\.env\..+$/,
	/^\.DS_Store$/,
	/^\.vscode$/,
	/^\.idea$/,
	/^\.claude$/,
	/^LICENSE/i,
	/^README/i
];

/**
 * Every file a template writes, as project-relative paths with the names they
 * end up with (`_gitignore` as `.gitignore`, `package.template.json` as
 * `package.json`).
 */
export function templateProjectFiles(templateDir: string): Set<string> {
	const files = new Set<string>();
	const walk = (dir: string) => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const rel = path.relative(templateDir, path.join(dir, entry.name));
			if (entry.isDirectory()) walk(path.join(dir, entry.name));
			// The same two things `copyTemplate` leaves behind.
			else if (entry.name !== '.DS_Store' && rel !== 'template.json') {
				files.add(projectFileName(rel));
			}
		}
	};
	walk(templateDir);
	return files;
}

/**
 * The entries of `directory` that stand in the way of creating a project
 * there, sorted; empty when `create` can go ahead without asking.
 *
 * An entry stands in the way when it is not on the tolerated list, or when it
 * is but the template would overwrite it (or, for a directory, a file inside
 * it): a `README.md` is fine until the template ships one, `.vscode` is fine
 * until its `settings.json` would be replaced. Those are reported by the path
 * that collides.
 */
export function blockingEntries(directory: string, templateDir: string): string[] {
	if (!fs.existsSync(directory)) return [];
	const written = templateProjectFiles(templateDir);
	const blocking: string[] = [];

	for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
		if (!TOLERATED.some((pattern) => pattern.test(entry.name))) {
			blocking.push(entry.name);
			continue;
		}
		// `.gitignore` is merged by `copyTemplate`, never replaced. (`.env` is
		// merged too, by `writeEnvFile`, and no template ships one; one that did
		// would be caught below like any other file.)
		if (entry.name === '.gitignore' || entry.name === '.git') continue;
		if (!entry.isDirectory()) {
			if (written.has(entry.name)) blocking.push(entry.name);
			continue;
		}
		for (const file of written) {
			if (!file.startsWith(`${entry.name}${path.sep}`)) continue;
			if (fs.existsSync(path.join(directory, file))) blocking.push(file);
		}
	}
	return blocking.sort();
}

/** `a, b, c and 4 more`: the first few entries, for a message. */
export function summarizeEntries(entries: string[], shown = 5): string {
	const head = entries.slice(0, shown).join(', ');
	const rest = entries.length - shown;
	return rest > 0 ? `${head} and ${rest} more` : head;
}

/**
 * A project's `.gitignore` with the template's lines it lacks appended.
 * The user's lines stay as they are, in their order. A comment from the
 * template comes along only with a rule under it that was missing.
 */
export function mergeGitignore(existing: string, template: string): string {
	const present = new Set(existing.split(/\r?\n/).map((line) => line.trim()));
	const additions: string[] = [];

	for (const block of template.split(/\r?\n\s*\r?\n/)) {
		const lines = block.split(/\r?\n/).filter((line) => line.trim() !== '');
		const missing = lines.filter(
			(line) => !line.trim().startsWith('#') && !present.has(line.trim())
		);
		if (missing.length === 0) continue;
		const comments = lines.filter((line) => line.trim().startsWith('#'));
		if (additions.length > 0) additions.push('');
		additions.push(...comments, ...missing);
	}

	if (additions.length === 0) return existing;
	const base = existing === '' || existing.endsWith('\n') ? existing : `${existing}\n`;
	return `${base}${base.trim() === '' ? '' : '\n'}${additions.join('\n')}\n`;
}
