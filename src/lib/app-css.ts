import fs from 'node:fs';
import path from 'node:path';
import { templatesDir } from './templates.ts';

/** The variants, keyframes and utilities shadcn-svelte's registry components rely on. */
export const SHADCN_VARIANTS_FILE = 'shadcn-variants.css';
export const SHADCN_VARIANTS_MARKER = '@custom-variant data-open';

export function shadcnVariantsBlock(): string {
	return fs.readFileSync(path.join(templatesDir(), 'ui', 'css', SHADCN_VARIANTS_FILE), 'utf8');
}

export function hasShadcnVariants(css: string): boolean {
	return css.includes(SHADCN_VARIANTS_MARKER);
}

export function appendShadcnVariants(css: string, block: string = shadcnVariantsBlock()): string {
	return `${css.trimEnd()}\n\n${block.trim()}\n`;
}

/**
 * `shadcn-svelte init` writes these into the global CSS, but a project that
 * came from `vela create` or `vela bless` never ran it, and without them the
 * `data-open:` / `data-active:` classes in registry components only half
 * work. Returns whether the file changed.
 */
export function ensureShadcnVariants(appCssPath: string): boolean {
	if (!fs.existsSync(appCssPath)) return false;
	const css = fs.readFileSync(appCssPath, 'utf8');
	if (hasShadcnVariants(css)) return false;
	fs.writeFileSync(appCssPath, appendShadcnVariants(css));
	return true;
}
