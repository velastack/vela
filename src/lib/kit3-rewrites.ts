import fs from 'node:fs';
import path from 'node:path';
import { sourceFiles, VELA_ENV_VARS } from './vela-env.ts';

/**
 * Code changes SvelteKit 3 needs that `sv migrate sveltekit-3` only flags (in
 * MIGRATION_TASKS.md) or misses. Each is a text edit scoped to a shape it can
 * recognise for certain; anything it cannot rewrite safely gets an
 * `@migration-task` comment instead, the marker sv uses for the same purpose.
 *
 * - `goto(url, { noScroll, keepFocus })` → `{ reset: false }`
 * - `goto(url, { invalidateAll })` → `{ refreshAll }`
 * - `invalidateAll()` from `$app/navigation` → `refreshAll()`
 * - `vi.mock('$app/environment')` / `vi.doMock(...)` → `'$app/env'`
 * - `new URL(page.url)` → `new URL(page.url.href)` (`page.url` is a ReadonlyURL)
 *
 * Every rewrite is idempotent: its input shape is gone afterwards, and a
 * comment already in place is not added twice.
 */

export const MIGRATION_TASK_MARKER = '@migration-task';

export interface CodeRewrite {
	/** Project-relative path. */
	file: string;
	/** What changed, one line each, with the line number. */
	changes: string[];
	/** `@migration-task` comments added. */
	tasks: string[];
}

interface Edit {
	start: number;
	end: number;
	text: string;
}

const NAVIGATION_IMPORT = /import\s*\{([^}]*)\}\s*from\s*['"]\$app\/navigation['"]\s*;?/g;

/** Local names a file binds to `$app/navigation` exports. */
function navigationBindings(source: string): Map<string, string> {
	const bindings = new Map<string, string>();
	for (const match of source.matchAll(NAVIGATION_IMPORT)) {
		for (const raw of match[1]!.split(',')) {
			const spec = raw.trim();
			if (!spec) continue;
			const [name, local = name] = spec.split(/\s+as\s+/).map((s) => s.trim()) as [string, string?];
			bindings.set(local!, name);
		}
	}
	return bindings;
}

/**
 * Index just past the bracket matching the one at `open`, skipping strings,
 * template literals and comments. -1 when unbalanced.
 */
export function matchBracket(source: string, open: number): number {
	const pairs: Record<string, string> = { '(': ')', '{': '}', '[': ']' };
	const stack: string[] = [];
	for (let i = open; i < source.length; i++) {
		const c = source[i]!;
		if (c === '"' || c === "'" || c === '`') {
			i = skipString(source, i);
			if (i === -1) return -1;
			continue;
		}
		if (c === '/' && source[i + 1] === '/') {
			const nl = source.indexOf('\n', i);
			if (nl === -1) return -1;
			i = nl;
			continue;
		}
		if (c === '/' && source[i + 1] === '*') {
			const close = source.indexOf('*/', i + 2);
			if (close === -1) return -1;
			i = close + 1;
			continue;
		}
		if (pairs[c]) stack.push(pairs[c]!);
		else if (c === ')' || c === '}' || c === ']') {
			if (stack.pop() !== c) return -1;
			if (stack.length === 0) return i + 1;
		}
	}
	return -1;
}

function skipString(source: string, start: number): number {
	const quote = source[start]!;
	for (let i = start + 1; i < source.length; i++) {
		const c = source[i]!;
		if (c === '\\') {
			i++;
			continue;
		}
		if (quote === '`' && c === '$' && source[i + 1] === '{') {
			const end = matchBracket(source, i + 1);
			if (end === -1) return -1;
			i = end - 1;
			continue;
		}
		if (c === quote) return i;
	}
	return -1;
}

/** Top-level comma-separated parts of `text` (the inside of a bracket pair), with offsets. */
function splitTopLevel(text: string): Array<{ start: number; end: number; text: string }> {
	const parts: Array<{ start: number; end: number; text: string }> = [];
	let depth = 0;
	let partStart = 0;
	for (let i = 0; i < text.length; i++) {
		const c = text[i]!;
		if (c === '"' || c === "'" || c === '`') {
			const end = skipString(text, i);
			if (end === -1) break;
			i = end;
			continue;
		}
		if (c === '(' || c === '{' || c === '[') depth++;
		else if (c === ')' || c === '}' || c === ']') depth--;
		else if (c === ',' && depth === 0) {
			parts.push({ start: partStart, end: i, text: text.slice(partStart, i) });
			partStart = i + 1;
		}
	}
	if (text.slice(partStart).trim()) {
		parts.push({ start: partStart, end: text.length, text: text.slice(partStart) });
	}
	return parts;
}

function lineOf(source: string, index: number): number {
	return source.slice(0, index).split('\n').length;
}

interface GotoOutcome {
	edits: Edit[];
	changes: string[];
	/** `[index, message]` for a call that needs a person. */
	tasks: Array<[number, string]>;
}

/** Rewrite the options of every `goto(...)` bound to `$app/navigation`'s `goto`. */
function rewriteGotoCalls(source: string, gotoNames: string[]): GotoOutcome {
	const outcome: GotoOutcome = { edits: [], changes: [], tasks: [] };
	for (const local of gotoNames) {
		const call = new RegExp(String.raw`(?<![\w$.])${escapeRegExp(local)}\s*\(`, 'g');
		for (const match of source.matchAll(call)) {
			if (inComment(source, match.index!)) continue;
			const open = match.index! + match[0].length - 1;
			const close = matchBracket(source, open);
			if (close === -1) continue;
			const args = splitTopLevel(source.slice(open + 1, close - 1));
			const options = args[1];
			if (!options) continue;
			const trimmed = options.text.trim();
			const line = lineOf(source, open);
			if (!/\b(noScroll|keepFocus|invalidateAll)\b/.test(trimmed)) continue;
			if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
				outcome.tasks.push([
					open,
					'goto options are built elsewhere: replace `noScroll`/`keepFocus` with `reset` and `invalidateAll` with `refreshAll`.'
				]);
				continue;
			}
			const leading = options.text.length - options.text.trimStart().length;
			const objectStart = open + 1 + options.start + leading;
			const inner = trimmed.slice(1, -1);
			const rewritten = rewriteGotoOptions(inner);
			if (rewritten.task) {
				outcome.tasks.push([open, rewritten.task]);
				continue;
			}
			if (rewritten.inner === inner) continue;
			outcome.edits.push({
				start: objectStart + 1,
				end: objectStart + trimmed.length - 1,
				text: rewritten.inner
			});
			outcome.changes.push(`line ${line}: goto ${rewritten.summary}`);
		}
	}
	return outcome;
}

/**
 * The inside of a goto options object, with `noScroll`/`keepFocus` merged
 * into `reset` and `invalidateAll` renamed to `refreshAll`. Only literal
 * `true`/`false` values are merged; anything else is a task.
 */
export function rewriteGotoOptions(inner: string): {
	inner: string;
	summary: string;
	task?: string;
} {
	// The trailing comma and whitespace stay where they are, whatever is removed.
	const tail = inner.match(/,?\s*$/)![0];
	const core = inner.slice(0, inner.length - tail.length);
	const keyed = splitTopLevel(core).map((p) => {
		const m = p.text.match(/^\s*(['"]?)([A-Za-z_$][\w$]*)\1\s*(?::\s*([\s\S]*?))?\s*$/);
		return {
			...p,
			key: m?.[2],
			value: m ? (m[3] ?? m[2]) : undefined,
			shorthand: m ? m[3] === undefined : false
		};
	});
	const flags = keyed.filter((p) => p.key === 'noScroll' || p.key === 'keepFocus');
	const summary: string[] = [];
	const replaced = new Map<number, string | null>();

	if (flags.length > 0) {
		const values = flags.map((f) => (f.shorthand ? undefined : f.value?.trim()));
		if (keyed.some((p) => p.key === 'reset')) {
			return {
				inner,
				summary: '',
				task: 'goto sets `reset` and `noScroll`/`keepFocus`: keep `reset` and remove the others.'
			};
		}
		if (values.some((v) => v !== 'true' && v !== 'false')) {
			return {
				inner,
				summary: '',
				task: '`noScroll`/`keepFocus` are now one `reset` option (`reset: false` keeps scroll and focus); set it from these values by hand.'
			};
		}
		const allTrue = values.every((v) => v === 'true');
		const allFalse = values.every((v) => v === 'false');
		if (!allTrue && !allFalse) {
			return {
				inner,
				summary: '',
				task: '`noScroll` and `keepFocus` disagree, and SvelteKit 3 merges them into one `reset` option; choose `reset: false` (keep both) or drop them.'
			};
		}
		const first = keyed.indexOf(flags[0]!);
		const keyIndent = flags[0]!.text.match(/^\s*/)![0];
		replaced.set(first, `${keyIndent}reset: ${allTrue ? 'false' : 'true'}`);
		for (const f of flags.slice(1)) replaced.set(keyed.indexOf(f), null);
		summary.push(
			`${flags.map((f) => `${f.key}: ${f.value!.trim()}`).join(', ')} → reset: ${allTrue ? 'false' : 'true'}`
		);
	}

	const invalidate = keyed.findIndex((p) => p.key === 'invalidateAll');
	if (invalidate !== -1) {
		const p = keyed[invalidate]!;
		if (keyed.some((q) => q.key === 'refreshAll')) {
			replaced.set(invalidate, null);
			summary.push('dropped invalidateAll (refreshAll already set)');
		} else if (p.shorthand) {
			replaced.set(invalidate, p.text.replace('invalidateAll', 'refreshAll: invalidateAll'));
			summary.push('invalidateAll → refreshAll');
		} else {
			replaced.set(invalidate, p.text.replace('invalidateAll', 'refreshAll'));
			summary.push('invalidateAll → refreshAll');
		}
	}

	if (replaced.size === 0) return { inner, summary: '' };
	const kept = keyed
		.map((p, i) => (replaced.has(i) ? replaced.get(i) : p.text))
		.filter((t): t is string => t !== null);
	let joined = kept.join(',');
	// A removed first property took the object's leading whitespace with it.
	const lead = core.match(/^\s*/)![0];
	if (!joined.startsWith(lead)) joined = lead + joined.trimStart();
	return { inner: joined + tail, summary: summary.join('; ') };
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * `invalidateAll` from `$app/navigation` → `refreshAll`, import and calls. A
 * file that uses shallow routing (`pushState`, `replaceState`, `page.state`)
 * is left as it is with a task: `invalidateAll` reset `page.state` and
 * `refreshAll` keeps it.
 */
function rewriteInvalidateAll(source: string): GotoOutcome {
	const outcome: GotoOutcome = { edits: [], changes: [], tasks: [] };
	for (const match of source.matchAll(NAVIGATION_IMPORT)) {
		const specs = splitTopLevel(match[1]!);
		const target = specs.find((s) => s.text.trim().split(/\s+as\s+/)[0] === 'invalidateAll');
		if (!target) continue;
		const local =
			target.text
				.trim()
				.split(/\s+as\s+/)[1]
				?.trim() ?? 'invalidateAll';
		const usesState = /\b(pushState|replaceState)\b|\bpage\.state\b|\$page\.state\b/.test(source);
		if (usesState) {
			outcome.tasks.push([
				match.index!,
				'`invalidateAll` is deprecated; `refreshAll` replaces it but keeps `page.state`, which this file uses. Check that is what you want, then switch.'
			]);
			continue;
		}
		const importStart = match.index! + match[0].indexOf('{') + 1;
		const hasRefresh = specs.some((s) => s.text.trim().split(/\s+as\s+/)[0] === 'refreshAll');
		const specStart = importStart + target.start;
		if (hasRefresh && local === 'invalidateAll') {
			// Drop the specifier and its comma.
			const before = source.slice(importStart, specStart);
			const commaBefore = before.lastIndexOf(',');
			const after = source.slice(specStart + target.text.length);
			if (commaBefore !== -1) {
				outcome.edits.push({
					start: importStart + commaBefore,
					end: specStart + target.text.length,
					text: ''
				});
			} else {
				const commaAfter = after.indexOf(',');
				outcome.edits.push({
					start: specStart,
					end: specStart + target.text.length + commaAfter + 1,
					text: ''
				});
			}
		} else {
			const leading = target.text.match(/^\s*/)![0];
			const renamed = local === 'invalidateAll' ? 'refreshAll' : `refreshAll as ${local}`;
			outcome.edits.push({
				start: specStart,
				end: specStart + target.text.length,
				text: leading + renamed + target.text.match(/\s*$/)![0]
			});
		}
		if (local === 'invalidateAll') {
			// Calls and bare references (`onclick={invalidateAll}`), but not an
			// object key: superForm's own `invalidateAll` option is not this one.
			const reference = /(?<![\w$.'"])invalidateAll(?![\w$])(?!\s*:)/g;
			for (const c of source.matchAll(reference)) {
				if (c.index! >= match.index! && c.index! < match.index! + match[0].length) continue;
				outcome.edits.push({
					start: c.index!,
					end: c.index! + 'invalidateAll'.length,
					text: 'refreshAll'
				});
			}
		}
		outcome.changes.push(`line ${lineOf(source, match.index!)}: invalidateAll → refreshAll`);
	}
	return outcome;
}

function applyEdits(source: string, edits: Edit[]): string {
	let out = source;
	for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
		out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
	}
	return out;
}

/** Where `index` in the source lands once `edits` are applied (it is never inside one). */
function mapIndex(edits: Edit[], index: number): number {
	let shift = 0;
	for (const edit of edits) {
		if (edit.end <= index) shift += edit.text.length - (edit.end - edit.start);
	}
	return index + shift;
}

/**
 * Put `// @migration-task <message>` above the line holding `index`, or in a
 * `.svelte` file's markup, `<!-- -->` at the top of the file naming the line.
 * Skipped when the same comment is already there.
 */
function addTaskComments(
	source: string,
	file: string,
	tasks: Array<[number, string]>
): { code: string; added: string[] } {
	const added: string[] = [];
	let code = source;
	// From the bottom up so earlier indexes stay valid.
	for (const [index, message] of [...tasks].sort((a, b) => b[0] - a[0])) {
		const line = lineOf(code, index);
		if (file.endsWith('.svelte') && !insideScript(code, index)) {
			// Markup has nowhere safe to put a comment beside an attribute, so it
			// goes at the top of the file, naming the code rather than a line
			// number that the comment itself would shift.
			const lineStart = code.lastIndexOf('\n', index - 1) + 1;
			const lineEnd = code.indexOf('\n', index);
			const excerpt = code
				.slice(lineStart, lineEnd === -1 ? undefined : lineEnd)
				.trim()
				.replace(/--/g, '- -')
				.slice(0, 80);
			const text = `${MIGRATION_TASK_MARKER} \`${excerpt}\`: ${message}`;
			if (code.includes(text)) continue;
			code = `<!-- ${text} -->\n${code}`;
			added.push(`line ${line}: ${message}`);
			continue;
		}
		const lineStart = code.lastIndexOf('\n', index - 1) + 1;
		const indent = code.slice(lineStart).match(/^[\t ]*/)![0];
		const previousLineStart = code.lastIndexOf('\n', lineStart - 2) + 1;
		const previous = code.slice(previousLineStart, lineStart);
		if (previous.includes(`${MIGRATION_TASK_MARKER} ${message}`)) continue;
		code = `${code.slice(0, lineStart)}${indent}// ${MIGRATION_TASK_MARKER} ${message}\n${code.slice(lineStart)}`;
		added.push(`line ${line}: ${message}`);
	}
	return { code, added };
}

/** Whether `index` is inside an HTML comment, or after `//` on its line. */
function inComment(source: string, index: number): boolean {
	const before = source.slice(0, index);
	if (before.lastIndexOf('<!--') > before.lastIndexOf('-->')) return true;
	const line = before.slice(before.lastIndexOf('\n') + 1);
	return /(^|[^:'"`])\/\//.test(line) || /^\s*\*/.test(line);
}

function insideScript(source: string, index: number): boolean {
	const before = source.slice(0, index);
	const open = before.lastIndexOf('<script');
	const close = before.lastIndexOf('</script');
	return open !== -1 && open > close;
}

const MOCK_ENVIRONMENT =
	/(\bvi\.(?:mock|doMock|unmock|doUnmock|importActual|importMock)\s*\(\s*)(['"])\$app\/environment\2/g;
const NEW_URL_PAGE_URL = /\bnew\s+URL\(\s*(\$?page\.url)\s*\)/g;

/** Apply every rewrite to one file's source. */
export function rewriteKit3Source(
	file: string,
	source: string
): { code: string; changes: string[]; tasks: string[] } {
	const changes: string[] = [];
	let code = source;

	code = code.replace(MOCK_ENVIRONMENT, (_whole, lead: string, quote: string, offset: number) => {
		changes.push(`line ${lineOf(code, offset)}: mock of $app/environment → $app/env`);
		return `${lead}${quote}$app/env${quote}`;
	});
	code = code.replace(NEW_URL_PAGE_URL, (_whole, url: string, offset: number) => {
		changes.push(`line ${lineOf(code, offset)}: new URL(${url}) → new URL(${url}.href)`);
		return `new URL(${url}.href)`;
	});

	let tasks: Array<[number, string]> = [];
	const bindings = navigationBindings(code);
	const gotoNames = [...bindings].filter(([, name]) => name === 'goto').map(([local]) => local);
	if (gotoNames.length > 0) {
		const goto = rewriteGotoCalls(code, gotoNames);
		code = applyEdits(code, goto.edits);
		changes.push(...goto.changes);
		tasks.push(...goto.tasks.map(([i, m]) => [mapIndex(goto.edits, i), m] as [number, string]));
	}
	if ([...bindings.values()].includes('invalidateAll')) {
		const invalidate = rewriteInvalidateAll(code);
		code = applyEdits(code, invalidate.edits);
		changes.push(...invalidate.changes);
		tasks = tasks.map(([i, m]) => [mapIndex(invalidate.edits, i), m]);
		tasks.push(
			...invalidate.tasks.map(([i, m]) => [mapIndex(invalidate.edits, i), m] as [number, string])
		);
	}
	const withTasks = addTaskComments(code, file, tasks);
	return { code: withTasks.code, changes, tasks: withTasks.added };
}

/** Run `rewriteKit3Source` over `src/**` and `test/**`. Running it twice changes nothing. */
export function rewriteKit3Code(root: string): CodeRewrite[] {
	const results: CodeRewrite[] = [];
	const files = [...sourceFiles(path.join(root, 'src')), ...sourceFiles(path.join(root, 'test'))];
	for (const file of files) {
		const source = fs.readFileSync(file, 'utf8');
		if (!/\$app\/navigation|\$app\/environment|new\s+URL\(\s*\$?page\.url\s*\)/.test(source))
			continue;
		const rel = path.relative(root, file);
		const { code, changes, tasks } = rewriteKit3Source(rel, source);
		if (code === source) continue;
		fs.writeFileSync(file, code);
		results.push({ file: rel, changes, tasks });
	}
	return results;
}

const APP_ENV_IMPORT = /import\s*\{([^}]*)\}\s*from\s*['"]\$app\/env\/(?:private|public)['"]/g;
const VELA_ENV_NAMES = new Set(VELA_ENV_VARS.map((spec) => spec.name));

/**
 * Local names a file binds to vela's own variables through `$app/env/private`
 * or `$app/env/public`. Type-only imports bind no value and are skipped.
 */
function velaEnvBindings(source: string): string[] {
	const locals: string[] = [];
	for (const match of source.matchAll(APP_ENV_IMPORT)) {
		if (/^import\s+type\b/.test(match[0])) continue;
		for (const raw of match[1]!.split(',')) {
			const spec = raw.trim();
			if (!spec || spec.startsWith('type ')) continue;
			const [name, local = name] = spec.split(/\s+as\s+/).map((s) => s.trim()) as [string, string?];
			if (VELA_ENV_NAMES.has(name)) locals.push(local!);
		}
	}
	return locals;
}

/**
 * `X ?? <default>` → `X || <default>` for vela's own variables (POCKETBASE_*,
 * WORKFLOWS_*, TEST). Their schema, `(value) => value ?? ''`, turns a missing
 * value into `''` where Kit 2 gave `undefined`, so `??` never applies:
 * `Number(WORKFLOWS_CONCURRENCY ?? 5)` would start no workers at all. `||`
 * treats `''` as missing, which is exactly what Kit 2 did with `??`.
 *
 * Only where the variable is the whole left operand (so the rewrite changes
 * nothing else), never `?? ''` (already what the schema does), and never when
 * the default holds another `??` (mixing `??` and `||` is a syntax error).
 * Anything skipped is still listed under the follow-ups. Every other
 * variable's `??` is left to the project.
 */
export function rewriteVelaEnvDefaultsSource(source: string): { code: string; changes: string[] } {
	const locals = velaEnvBindings(source);
	const changes: string[] = [];
	if (locals.length === 0) return { code: source, changes };
	const pattern = new RegExp(
		String.raw`(?<![\w$.])(${locals.map(escapeRegExp).join('|')})(\s*)\?\?(?!=)(?!\s*(?:''|""|\`\`))`,
		'g'
	);
	const edits: Edit[] = [];
	for (const match of source.matchAll(pattern)) {
		const start = match.index!;
		if (inComment(source, start)) continue;
		// The variable has to be the whole left operand: `a + X ?? 5` is `(a + X) ?? 5`.
		const before = source.slice(0, start).trimEnd();
		if (!/(?:^|[(,:[{?;]|(?<![=!<>])=|=>|\breturn|\$\{)$/.test(before)) continue;
		const end = start + match[0].length;
		const rest = source.slice(end).match(/^[^,;)}\]\n]*/)![0];
		if (rest.includes('??')) continue;
		edits.push({ start: end - 2, end, text: '||' });
		changes.push(
			`line ${lineOf(source, start)}: ${match[1]} ?? ${rest.trim()} → ${match[1]} || ${rest.trim()}`
		);
	}
	return { code: applyEdits(source, edits), changes };
}

/**
 * Run `rewriteVelaEnvDefaultsSource` over `src/**`, the code vela's variables
 * are imported into. Running it twice changes nothing.
 */
export function rewriteVelaEnvDefaults(root: string): CodeRewrite[] {
	const results: CodeRewrite[] = [];
	for (const file of sourceFiles(path.join(root, 'src'))) {
		const source = fs.readFileSync(file, 'utf8');
		if (!source.includes('$app/env/') || !source.includes('??')) continue;
		const { code, changes } = rewriteVelaEnvDefaultsSource(source);
		if (code === source) continue;
		fs.writeFileSync(file, code);
		results.push({ file: path.relative(root, file), changes, tasks: [] });
	}
	return results;
}
