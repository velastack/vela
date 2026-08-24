import fs from 'node:fs';
import path from 'node:path';
import { fillTemplatePlaceholders, type TemplateValues } from './package-json.ts';

/**
 * npm never publishes files named `.gitignore` or `.npmrc` inside a package, so
 * templates store them under a publish-safe name and the real name is restored
 * when a template is copied into a project.
 *
 * Keyed by the name the file must have in the generated project.
 */
const PUBLISH_SAFE_NAMES: Record<string, string> = {
	'.gitignore': '_gitignore',
	'.npmrc': '_npmrc'
};

/** Template-relative path for a file that must land at `projectRelPath`. */
export function templateName(projectRelPath: string): string {
	const safe = PUBLISH_SAFE_NAMES[path.basename(projectRelPath)];
	if (!safe) return projectRelPath;
	const dir = path.dirname(projectRelPath);
	return dir === '.' ? safe : path.join(dir, safe);
}

/** Restore publish-safe names to their real ones after copying a template tree. */
export function restoreTemplateNames(target: string): void {
	for (const [real, safe] of Object.entries(PUBLISH_SAFE_NAMES)) {
		const from = path.join(target, safe);
		if (!fs.existsSync(from)) continue;
		fs.renameSync(from, path.join(target, real));
	}
}

/**
 * A template ships parameterized files under a `.template.` infix — the reason
 * being that `package.template.json` has to stay valid JSON (and installable
 * TypeScript) while it still holds `~TODO~` placeholders.
 */
const TEMPLATE_SOURCE = /\.template\.([^.]+)$/;

/**
 * Fill placeholders in every `*.template.*` file a copied template left behind,
 * write each to its real name, and remove the source.
 *
 * Returns the project-relative paths written, so a caller can assert the files a
 * template must produce.
 */
export function applyTemplateFiles(target: string, values: TemplateValues): string[] {
	const written: string[] = [];
	for (const source of findTemplateSources(target)) {
		const raw = fs.readFileSync(source, 'utf8');
		const dest = source.replace(TEMPLATE_SOURCE, '.$1');
		fs.writeFileSync(dest, fillTemplatePlaceholders(raw, values));
		fs.unlinkSync(source);
		written.push(path.relative(target, dest));
	}
	return written.sort();
}

function findTemplateSources(dir: string): string[] {
	const found: string[] = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === 'node_modules' || entry.name === '.git') continue;
			found.push(...findTemplateSources(full));
		} else if (entry.isFile() && TEMPLATE_SOURCE.test(entry.name)) {
			found.push(full);
		}
	}
	return found;
}
