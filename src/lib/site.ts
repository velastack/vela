import fs from 'node:fs';
import path from 'node:path';

/** Where every project keeps its name and public URL. */
export const SITE_FILE = path.join('src', 'lib', 'site.ts');

export interface SiteInfo {
	name?: string;
	url?: string;
}

/**
 * The app's name and public URL, as the project's `src/lib/site.ts` declares
 * them: `export const site = { name: '…', url: '…' }`.
 *
 * Read statically rather than imported, so the file is never executed and may
 * import whatever the app likes. Values that aren't plain strings are left
 * out. Null when there is no such file or no `site` object in it — a project
 * from before every template shipped one.
 */
export async function readSite(root: string): Promise<SiteInfo | null> {
	const file = path.join(root, SITE_FILE);
	if (!fs.existsSync(file)) return null;

	const { Project, Node } = await import('ts-morph');
	const project = new Project({ useInMemoryFileSystem: true });
	const source = project.createSourceFile('site.ts', fs.readFileSync(file, 'utf8'));

	let object = source.getVariableDeclaration('site')?.getInitializer();
	while (object && (Node.isAsExpression(object) || Node.isSatisfiesExpression(object))) {
		object = object.getExpression();
	}
	if (!object || !Node.isObjectLiteralExpression(object)) return null;

	const info: SiteInfo = {};
	for (const key of ['name', 'url'] as const) {
		const property = object.getProperty(key);
		if (!property || !Node.isPropertyAssignment(property)) continue;
		const value = property.getInitializer();
		if (Node.isStringLiteral(value) || Node.isNoSubstitutionTemplateLiteral(value)) {
			const text = value.getLiteralValue().trim();
			if (text) info[key] = text;
		}
	}
	return info;
}

/** Whether `url` is only reachable from this machine, i.e. not set yet. */
export function isLocalUrl(url: string): boolean {
	try {
		const { hostname } = new URL(url);
		return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
	} catch {
		return false;
	}
}
