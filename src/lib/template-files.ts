import fs from 'node:fs';
import path from 'node:path';

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
