import fs from 'node:fs';
import path from 'node:path';
import { compareVersions, minVersion, type PkgJson } from './package-json.ts';

/**
 * Registry templates `vela create` cannot carry over to SvelteKit 3.
 *
 * The Kit 3 migration has to raise `@velastack/cms` to ^0.6, since 0.4 and 0.5
 * peer on Kit 2. 0.5.1 deleted `CmsRepeater`, so a template still built on it
 * fails check and build once migrated. Until the registry is updated, such a
 * template is refused before anything is written, with the way to the
 * SvelteKit 2 version.
 */

const CMS = '@velastack/cms';
const REPEATER_REMOVED_IN = { major: 0, minor: 5, patch: 0, prerelease: [] };

/** Files under `src/` that can import a component. */
const SOURCE_FILE = /\.(svelte|svx|md|[cm]?[jt]s)$/;

/**
 * A named import of `CmsRepeater` from the package or any of its subpaths.
 * `[^}]*` spans lines, so a multi-line import list still matches.
 */
const REPEATER_IMPORT =
	/\bimport\s+(?:type\s+)?\{[^}]*\bCmsRepeater\b[^}]*\}\s*from\s*['"]@velastack\/cms(?:\/[^'"]*)?['"]/;

export interface UnsupportedTemplate {
	/** The `@velastack/cms` range the template declares, when it is below 0.5. */
	cmsRange?: string;
	/** Template-relative path of a file importing `CmsRepeater`, when one does. */
	repeaterFile?: string;
}

/**
 * Why the template in `dir` (an unpacked registry template, or a project) can't
 * be migrated to SvelteKit 3, or null when it can. Reads `package.template.json`
 * as a template ships it, falling back to `package.json`.
 */
export function findKit3Blocker(dir: string): UnsupportedTemplate | null {
	const blocker: UnsupportedTemplate = {};
	const range = cmsRange(dir);
	if (range !== undefined) {
		const min = minVersion(range);
		if (min && compareVersions(min, REPEATER_REMOVED_IN) < 0) blocker.cmsRange = range;
	}
	const repeaterFile = findRepeaterImport(dir);
	if (repeaterFile) blocker.repeaterFile = repeaterFile;
	return blocker.cmsRange || blocker.repeaterFile ? blocker : null;
}

/** The refusal `vela create` prints for a template `findKit3Blocker` flagged. */
export function kit3BlockerMessage(templateName: string, blocker: UnsupportedTemplate): string {
	const why = blocker.repeaterFile
		? `it uses CmsRepeater, which @velastack/cms 0.5 removed`
		: `it depends on @velastack/cms ${blocker.cmsRange}, and CmsRepeater was removed in @velastack/cms 0.5`;
	return (
		`Template ${templateName} hasn't been updated for SvelteKit 3 yet: ${why}.\n\n` +
		`Pick another template, or create the SvelteKit 2 version with\n\n` +
		`  npx vela@0.14 create --template ${templateName}\n`
	);
}

function cmsRange(dir: string): string | undefined {
	for (const file of ['package.template.json', 'package.json']) {
		const pkgPath = path.join(dir, file);
		if (!fs.existsSync(pkgPath)) continue;
		let pkg: PkgJson;
		try {
			pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as PkgJson;
		} catch {
			return undefined;
		}
		return pkg.dependencies?.[CMS] ?? pkg.devDependencies?.[CMS];
	}
	return undefined;
}

function findRepeaterImport(dir: string): string | undefined {
	const src = path.join(dir, 'src');
	if (!fs.existsSync(src)) return undefined;
	const entries = fs.readdirSync(src, { recursive: true, withFileTypes: true });
	for (const entry of entries) {
		if (!entry.isFile() || !SOURCE_FILE.test(entry.name)) continue;
		const file = path.join(entry.parentPath, entry.name);
		const text = fs.readFileSync(file, 'utf8');
		if (text.includes('CmsRepeater') && REPEATER_IMPORT.test(text)) {
			return path.relative(dir, file);
		}
	}
	return undefined;
}
