/**
 * Drop one `--` separator from the arguments.
 *
 * `npm run dev -- --open` is the idiom for forwarding flags through npm, and npm
 * strips the separator before the script sees it — so a template script running
 * `vela dev` receives a plain `--open`. Typed straight at the CLI the separator
 * survives, and commander reads everything after it as a positional argument, so
 * `vela dev -- --open` fails with "too many arguments" instead of opening a
 * browser.
 *
 * No vela command takes an argument that could be mistaken for a flag, so the
 * separator carries no meaning here. Removing it makes both spellings agree.
 */
export function normalizeArgv(argv: string[]): string[] {
	const separator = argv.indexOf('--');
	if (separator === -1) return argv;
	return [...argv.slice(0, separator), ...argv.slice(separator + 1)];
}
