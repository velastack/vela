import { Transform } from 'node:stream';

const ANSI = /\x1b\[[0-9;]*m/g;

/**
 * The record lookup PocketBase runs to verify the token on every authenticated
 * request, as `--dev` echoes it:
 *
 *   [0.00ms] SELECT `_superusers`.* FROM `_superusers` WHERE `_superusers`.`id`='…' LIMIT 1
 *
 * One line per request says nothing the request itself doesn't, and a polling
 * worker turns it into the whole console.
 */
const AUTH_LOOKUP =
	/^\[\d+(?:\.\d+)?ms\] SELECT [`"]?_superusers[`"]?\.\* FROM [`"]?_superusers[`"]? WHERE [`"]?_superusers[`"]?\.[`"]?id[`"]?\s*=\s*'[^']*' LIMIT 1$/;

export function isAuthLookupLine(line: string): boolean {
	return AUTH_LOOKUP.test(line.replace(ANSI, '').trim());
}

/**
 * Drops the auth lookup lines from PocketBase's `--dev` output and passes
 * everything else through untouched. Works on whole lines, so a line split
 * across chunks is held until its newline arrives.
 */
export function createPocketbaseLogFilter(): Transform {
	let pending = '';
	return new Transform({
		transform(chunk, _encoding, callback) {
			const lines = (pending + chunk.toString()).split('\n');
			pending = lines.pop() ?? '';
			const kept = lines.filter((line) => !isAuthLookupLine(line));
			callback(null, kept.length ? kept.join('\n') + '\n' : undefined);
		},
		flush(callback) {
			const rest = pending;
			pending = '';
			callback(null, rest && !isAuthLookupLine(rest) ? rest : undefined);
		}
	});
}
