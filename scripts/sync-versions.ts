/**
 * Writes the dependency ranges `@velastack/patterns` lists into the built-in
 * templates' `package.template.json`.
 *
 *   npm run sync-versions            rewrite the templates
 *   npm run sync-versions -- --check exit 1 when a template is behind
 *
 * Patterns' `versions.json` is the one place a version is decided: its
 * patterns install from it, and its weekly bump keeps it current. The
 * templates here are a copy, kept in step by this script and held there by
 * `src/lib/template-versions.test.ts`. So after raising the
 * `@velastack/patterns` dependency, run this and commit the result.
 *
 * Only ranges change. A template decides which packages it lists; a package
 * patterns does not know is reported, since nothing would keep it current.
 */
import fs from 'node:fs';
import path from 'node:path';
import { VERSIONS } from '@velastack/patterns';

const TEMPLATES = path.resolve(import.meta.dirname, '../templates');
const DEP_KINDS = ['dependencies', 'devDependencies'] as const;
const check = process.argv.includes('--check');

let behind = 0;
const unknown: string[] = [];

for (const entry of fs.readdirSync(TEMPLATES, { withFileTypes: true })) {
	const file = path.join(TEMPLATES, entry.name, 'package.template.json');
	if (!entry.isDirectory() || !fs.existsSync(file)) continue;

	let text = fs.readFileSync(file, 'utf8');
	const pkg = JSON.parse(text) as Record<string, Record<string, string> | undefined>;
	for (const kind of DEP_KINDS) {
		for (const [name, range] of Object.entries(pkg[kind] ?? {})) {
			// `vela` is `^~VELA_VERSION~`, filled in by `vela create`.
			if (range.includes('~VELA_VERSION~')) continue;
			const wanted = VERSIONS[name];
			if (wanted === undefined) {
				unknown.push(`${entry.name}: ${name}`);
				continue;
			}
			if (wanted === range) continue;
			behind++;
			console.log(`${entry.name}: ${name} ${range} → ${wanted}`);
			// Edited as text, so the file keeps its formatting and key order.
			const line = `${JSON.stringify(name)}: ${JSON.stringify(range)}`;
			if (!text.includes(line)) throw new Error(`${file}: cannot find ${line}`);
			text = text.replace(line, `${JSON.stringify(name)}: ${JSON.stringify(wanted)}`);
		}
	}
	if (!check) fs.writeFileSync(file, text);
}

if (unknown.length > 0) {
	console.error(
		`Not in @velastack/patterns' versions.json, so nothing keeps these current:\n  ${unknown.join('\n  ')}`
	);
	process.exitCode = 1;
}
if (behind === 0) console.log('Templates match @velastack/patterns.');
else if (check) process.exitCode = 1;
