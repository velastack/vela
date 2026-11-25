import { faker } from '@faker-js/faker';

/**
 * Collections the patterns create and keep for themselves: rows are written by
 * the app or mirrored from a provider, never filled in by hand, and invented
 * ones are wrong at best (a fake OAuth link, an API key nobody holds, a Stripe
 * customer Stripe has never heard of, an invite to nowhere).
 *
 * - `oauth_accounts`: enable auth, the OAuth identities linked to a user
 * - `api_keys`: enable api-keys, hashed keys
 * - `stripe_*`: enable payments / subscriptions, mirrors of Stripe objects
 * - `team_invites`, `team_invite_links`: enable teams, pending invitations
 *
 * `vela fixtures generate` leaves them out unless `--only` names one, or a
 * collection it does generate requires a relation to one.
 */
export const INTERNAL_COLLECTIONS: readonly string[] = [
	'oauth_accounts',
	'api_keys',
	'stripe_customers',
	'stripe_payment_methods',
	'stripe_products',
	'stripe_prices',
	'stripe_subscriptions',
	'team_invites',
	'team_invite_links'
];

export interface FixtureField {
	name: string;
	type: string;
	required?: boolean;
	collectionId?: string;
}

export interface FixtureCollection {
	id: string;
	name: string;
	type: string;
	fields: FixtureField[];
}

export interface FixtureSelection<C extends FixtureCollection> {
	/** Collections to generate records for. */
	selected: C[];
	/** Pattern-internal collections that were left out. */
	internalSkipped: string[];
}

/**
 * Which collections a run generates for. System collections (`_` prefix) and
 * views never are. `only` is taken as given; otherwise the internal list and
 * `skip` are left out, except an internal collection that something generated
 * requires a relation to, since those records could not be created without it.
 * A name in `only`, `skip` or `counts` that is not a collection is an error.
 */
export function selectFixtureCollections<C extends FixtureCollection>(
	collections: C[],
	options: { only?: string[]; skip?: string[]; counts?: Record<string, number> } = {}
): FixtureSelection<C> {
	const eligible = collections.filter((c) => !c.name.startsWith('_') && c.type !== 'view');
	const names = new Set(eligible.map((c) => c.name));
	const check = (flag: string, given: string[] | undefined) => {
		const unknown = (given ?? []).filter((name) => !names.has(name));
		if (unknown.length > 0) {
			throw new Error(
				`${flag}: no collection named ${unknown.join(', ')}. Collections: ${[...names].sort().join(', ') || 'none'}.`
			);
		}
	};
	check('--only', options.only);
	check('--skip', options.skip);
	check('--count-for', Object.keys(options.counts ?? {}));

	const internalPresent = INTERNAL_COLLECTIONS.filter((name) => names.has(name));

	if (options.only && options.only.length > 0) {
		const only = new Set(options.only);
		const skipped = new Set(options.skip ?? []);
		return {
			selected: eligible.filter((c) => only.has(c.name) && !skipped.has(c.name)),
			internalSkipped: []
		};
	}

	const explicit = new Set(options.skip ?? []);
	const left = new Set([...internalPresent, ...explicit]);
	const byId = new Map(eligible.map((c) => [c.id, c]));
	for (let changed = true; changed;) {
		changed = false;
		for (const collection of eligible) {
			if (left.has(collection.name)) continue;
			for (const field of collection.fields) {
				if (field.type !== 'relation' || !field.required || !field.collectionId) continue;
				const target = byId.get(field.collectionId);
				if (target && left.has(target.name) && !explicit.has(target.name)) {
					left.delete(target.name);
					changed = true;
				}
			}
		}
	}

	return {
		selected: eligible.filter((c) => !left.has(c.name)),
		internalSkipped: internalPresent.filter((name) => left.has(name))
	};
}

/** `songs=64` from `--count-for`, added to what earlier values gave. */
export function parseCountFor(
	value: string,
	previous: Record<string, number> = {}
): Record<string, number> {
	const match = /^([A-Za-z0-9_]+)=(\d+)$/.exec(value.trim());
	const count = match ? Number(match[2]) : NaN;
	if (!match || count < 1 || count > 999) {
		throw new Error(`expected <collection>=<count> with a count between 1 and 999, got "${value}"`);
	}
	return { ...previous, [match[1]]: count };
}

type Property = Record<string, unknown>;

export interface FixtureSchema {
	properties: Record<string, Property>;
	required: string[];
	[key: string]: unknown;
}

const isNumeric = (property: Property) => property.type === 'number' || property.type === 'integer';

/** How far a number field ranges when the schema says nothing. */
export const DEFAULT_NUMBER_RANGE = 1000;

/**
 * Make a collection's JSON schema safe to hand to the generator.
 *
 * A number field with no bounds would come out as any float there is
 * (`"year": -135.41755685582757`), so it becomes a whole number from 0 to
 * 1000; one bound given keeps it and gets the other 1000 away. A required
 * number starts at 1: PocketBase treats 0 as blank. And a `faker` hint on a
 * field that is not text is dropped: the hints are guessed from the field's
 * name (`position` reads as a job title), and a string where a number or
 * boolean belongs comes out of the generator as `null`.
 */
export function prepareFixtureSchema<S extends FixtureSchema>(schema: S): S {
	const required = new Set(schema.required);
	const properties: Record<string, Property> = {};
	for (const [name, original] of Object.entries(schema.properties)) {
		const property = { ...original };
		if (property.type !== 'string' && typeof property.faker === 'string') {
			if (!(isNumeric(property) && property.faker.startsWith('number.'))) delete property.faker;
		}
		if (isNumeric(property)) {
			const min = typeof property.minimum === 'number' ? property.minimum : undefined;
			const max = typeof property.maximum === 'number' ? property.maximum : undefined;
			if (min === undefined && max === undefined) {
				property.type = 'integer';
				property.minimum = required.has(name) ? 1 : 0;
				property.maximum = DEFAULT_NUMBER_RANGE;
			} else if (min === undefined) {
				const floor = required.has(name) ? 1 : 0;
				// From 0 (1 when required) when the maximum allows it; below that only
				// for a maximum that is itself below it.
				property.minimum = max! >= floor ? floor : max! - DEFAULT_NUMBER_RANGE;
			} else if (max === undefined) {
				property.maximum = min + DEFAULT_NUMBER_RANGE;
			}
		}
		properties[name] = property;
	}
	return { ...schema, properties };
}

/**
 * Fill what the generator left out of a record: every required field ends up
 * with a value PocketBase accepts as present. A required number is not 0 (when
 * the bounds allow anything else), a required boolean is `true`, a required
 * string is not empty. PocketBase rejects the blank value of each.
 */
export function fillRequired(record: Record<string, unknown>, schema: FixtureSchema): void {
	for (const name of schema.required) {
		const property = schema.properties[name];
		if (!property) continue;
		const value = record[name];

		if (property.type === 'boolean') {
			record[name] = true;
		} else if (isNumeric(property)) {
			const min = typeof property.minimum === 'number' ? property.minimum : 1;
			const max =
				typeof property.maximum === 'number' ? property.maximum : min + DEFAULT_NUMBER_RANGE;
			if (typeof value !== 'number' || Number.isNaN(value) || (value === 0 && max !== 0)) {
				const low = Math.ceil(min === 0 && max >= 1 ? 1 : min);
				record[name] = faker.number.int({ min: low, max: Math.max(low, Math.floor(max)) });
			}
		} else if (property.type === 'string') {
			if (typeof value !== 'string' || value === '') {
				const choices = Array.isArray(property.enum) ? (property.enum as string[]) : [];
				record[name] =
					choices.length > 0 ? faker.helpers.arrayElement(choices) : faker.lorem.words(2);
			}
		} else if (property.type === 'array') {
			if (!Array.isArray(value) || value.length === 0) {
				const items = (property.items ?? {}) as Property;
				const choices = Array.isArray(items.enum) ? (items.enum as string[]) : [];
				if (choices.length > 0) record[name] = [faker.helpers.arrayElement(choices)];
			}
		}
	}
}
