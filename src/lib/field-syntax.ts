import type { Command } from 'commander';
import * as patterns from '@velastack/patterns';

export const FIELD_SYNTAX_DOCS = 'https://velastack.dev/docs/generate';

/**
 * What is printed when the installed `@velastack/patterns` predates its
 * `FIELD_SYNTAX_HELP` export: the parts of the syntax every version parses.
 */
export const FIELD_SYNTAX_FALLBACK = `Field definitions:
  name:type    one per argument, e.g. title:text body:editor price:number
  name:type!   a trailing ! makes the field required

  Types: text, editor, number, bool, email, url, date, json, file, autodate
  select(draft,published)   a select with those values
  author:users              a collection name as the type makes a relation

  Full reference: ${FIELD_SYNTAX_DOCS}`;

/**
 * The field syntax the generators parse, as the patterns library describes it.
 * Read off the namespace rather than imported by name, so the CLI still builds
 * and runs against a patterns release without the export.
 */
export function fieldSyntaxHelp(source: Record<string, unknown> = patterns): string {
	const exported = source.FIELD_SYNTAX_HELP;
	return typeof exported === 'string' && exported.trim()
		? exported.trimEnd()
		: FIELD_SYNTAX_FALLBACK;
}

/** Print the field syntax after a generator's `--help`. */
export function withFieldSyntaxHelp(command: Command): Command {
	return command.addHelpText('after', () => `\n${fieldSyntaxHelp()}`);
}
