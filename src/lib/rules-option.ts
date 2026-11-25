import { Option } from 'commander';

export const RULES = ['auth', 'owner', 'superuser'] as const;
export type Rules = (typeof RULES)[number];

/**
 * `--rules` for the generators that create a collection. Passed to the pattern
 * as `input.rules`, which is where the value is checked and applied; the
 * choices here are for `--help`.
 */
export function rulesOption(): Option {
	return new Option(
		'--rules <rules>',
		"who may read and write the collection through the API. auth: any signed-in user. owner: the record's owner. superuser: server only, with no API access, so pages must use the admin client."
	).choices(RULES);
}
