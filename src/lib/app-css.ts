import fs from 'node:fs';

/**
 * The variants, keyframes and utilities shadcn-svelte's registry components
 * rely on (`data-open:`, `data-active:`, `accordion-down`, ...). They ship in
 * the shadcn-svelte package itself, so the global CSS imports them rather than
 * carrying a copy that would drift from the installed version. `shadcn-svelte
 * apply` and `init` inject the same import.
 */
export const SHADCN_TAILWIND_CSS = 'shadcn-svelte/tailwind.css';
export const SHADCN_TAILWIND_IMPORT = `@import '${SHADCN_TAILWIND_CSS}';`;

/** Accepts either quote style: shadcn-svelte writes double quotes, the templates single. */
export function hasShadcnImport(css: string): boolean {
	return css.includes(SHADCN_TAILWIND_CSS);
}

/**
 * Adds the import after the file's leading `@import` lines so it sits with the
 * other imports Tailwind requires up front, or at the top when there are none.
 */
export function insertShadcnImport(css: string): string {
	const lines = css.split('\n');
	let lastImport = -1;
	for (const [index, line] of lines.entries()) {
		const trimmed = line.trim();
		if (trimmed.startsWith('@import')) {
			lastImport = index;
			continue;
		}
		if (trimmed === '' || trimmed.startsWith('/*') || trimmed.startsWith('//')) continue;
		break;
	}
	if (lastImport === -1) {
		return `${SHADCN_TAILWIND_IMPORT}\n${css}`;
	}
	lines.splice(lastImport + 1, 0, SHADCN_TAILWIND_IMPORT);
	return lines.join('\n');
}

/**
 * `shadcn-svelte init` writes this import into the global CSS, but a project
 * that came from `vela create` or `vela bless` never ran it, and without it the
 * `data-open:` / `data-active:` classes in registry components only half
 * work. Returns whether the file changed.
 */
export function ensureShadcnImport(appCssPath: string): boolean {
	if (!fs.existsSync(appCssPath)) return false;
	const css = fs.readFileSync(appCssPath, 'utf8');
	if (hasShadcnImport(css)) return false;
	fs.writeFileSync(appCssPath, insertShadcnImport(css));
	return true;
}
