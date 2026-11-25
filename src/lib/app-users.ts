import crypto from 'node:crypto';
import type PocketBase from 'pocketbase';

/**
 * Creating an app user: a record in one of the app's auth collections.
 *
 * Kept apart from the command so the whole decision — which fields exist, what
 * a `--set` value means, create or update — runs against any PocketBase client,
 * the local one, a deployed one through the tunnel, or a fake in a test.
 */

/** PocketBase's default minimum for an auth collection's password field. */
const DEFAULT_MIN_PASSWORD = 8;

/** Fields every auth collection has that are set through their own flags. */
const RESERVED_FIELDS = new Set([
	'id',
	'email',
	'password',
	'passwordConfirm',
	'tokenKey',
	'verified',
	'created',
	'updated'
]);

export interface CollectionField {
	name: string;
	type: string;
	min?: number;
}

export interface AuthCollection {
	name: string;
	fields: CollectionField[];
	/** Shortest password the collection accepts. */
	minPassword: number;
	/** Whether there is a `name` field to put `--name` in. */
	hasName: boolean;
}

export interface AppUserInput {
	collection: string;
	email: string;
	/** Unset on an update means "leave the password alone". */
	password?: string;
	name?: string;
	/** Unset on an update means "leave it alone"; a new account is verified unless told otherwise. */
	verified?: boolean;
	/** `--set` pairs, as typed. */
	set?: Record<string, string>;
	/** Change the account when the email already has one, instead of refusing. */
	update?: boolean;
}

export interface AppUserOutcome {
	action: 'created' | 'updated';
	id: string;
	/** Field names that were written, never their values. */
	fields: string[];
	passwordChanged: boolean;
}

/** Only the two PocketBase services this needs, so a test can stand in for them. */
export type UsersClient = Pick<PocketBase, 'collection' | 'collections' | 'filter'>;

function statusOf(error: unknown): number | undefined {
	return typeof error === 'object' && error !== null && 'status' in error
		? Number((error as { status: unknown }).status)
		: undefined;
}

/** What PocketBase said was wrong with each field, which its top-level message leaves out. */
function fieldErrors(error: unknown): string {
	const data = (error as { response?: { data?: Record<string, { message?: string }> } })?.response
		?.data;
	if (!data || typeof data !== 'object') return '';
	return Object.entries(data)
		.map(([field, detail]) => `  ${field}: ${detail?.message ?? 'invalid'}`)
		.join('\n');
}

/**
 * A long random password for an account nobody chose one for. Printed once by
 * the command and stored nowhere else.
 */
export function generatePassword(): string {
	return crypto.randomBytes(18).toString('base64url');
}

/** Split repeated `--set key=value` flags. Only the first `=` separates. */
export function parseSetPairs(pairs: string[]): Record<string, string> {
	const result: Record<string, string> = {};
	for (const pair of pairs) {
		const eq = pair.indexOf('=');
		const key = eq > 0 ? pair.slice(0, eq).trim() : '';
		if (!key) {
			throw new Error(`--set takes key=value, and "${pair}" is not that.`);
		}
		result[key] = pair.slice(eq + 1);
	}
	return result;
}

/**
 * Turn a `--set` value into what the field stores. The field's type decides
 * where it can: `--set code=0123` on a text field stays the string it was
 * typed as, and `--set admin=yes` on a bool is an error rather than a string
 * PocketBase would quietly read as false.
 */
export function coerceValue(raw: string, field: CollectionField): unknown {
	switch (field.type) {
		case 'bool':
			if (raw === 'true') return true;
			if (raw === 'false') return false;
			throw new Error(`${field.name} is a bool: use ${field.name}=true or ${field.name}=false.`);
		case 'number': {
			const value = Number(raw);
			if (raw.trim() === '' || Number.isNaN(value)) {
				throw new Error(`${field.name} is a number, and "${raw}" is not one.`);
			}
			return value;
		}
		case 'json':
			try {
				return JSON.parse(raw);
			} catch {
				return raw;
			}
		case 'text':
		case 'email':
		case 'url':
		case 'editor':
		case 'date':
		case 'select':
		case 'relation':
		case 'file':
			return raw;
		default:
			// A field type this CLI does not know: the plain reading of the value.
			if (raw === 'true') return true;
			if (raw === 'false') return false;
			if (raw.trim() !== '' && !Number.isNaN(Number(raw))) return Number(raw);
			return raw;
	}
}

/** Read an auth collection's shape, or say why it cannot hold a user. */
export async function readAuthCollection(pb: UsersClient, name: string): Promise<AuthCollection> {
	let collection: { name: string; type: string; fields?: CollectionField[] };
	try {
		collection = (await pb.collections.getOne(name)) as unknown as typeof collection;
	} catch (error) {
		if (statusOf(error) === 404) {
			throw new Error(
				`This app has no collection named "${name}".\n\n` +
					(name === 'users'
						? 'Run `vela enable auth` to add sign-in, or pass --collection <name> for another auth collection.'
						: 'Pass --collection <name> with the name of an auth collection.'),
				{ cause: error }
			);
		}
		throw error;
	}
	if (collection.type !== 'auth') {
		throw new Error(
			`"${name}" is a ${collection.type} collection, and only an auth collection holds accounts that can sign in.`
		);
	}
	if (collection.name === '_superusers') {
		throw new Error(
			'_superusers holds the logins for the admin panel. Create one with `vela admin create`.'
		);
	}
	const fields = collection.fields ?? [];
	const password = fields.find((field) => field.name === 'password');
	return {
		name: collection.name,
		fields,
		minPassword: password?.min && password.min > 0 ? password.min : DEFAULT_MIN_PASSWORD,
		hasName: fields.some((field) => field.name === 'name')
	};
}

/**
 * The `--set` pairs as record data, checked against the collection: a field it
 * does not have is an error naming the ones it does, not a value silently
 * dropped by PocketBase.
 */
export function resolveExtraFields(
	collection: AuthCollection,
	set: Record<string, string>
): Record<string, unknown> {
	const settable = collection.fields.filter((field) => !RESERVED_FIELDS.has(field.name));
	const data: Record<string, unknown> = {};
	for (const [key, raw] of Object.entries(set)) {
		if (RESERVED_FIELDS.has(key)) {
			throw new Error(
				`${key} is not set with --set. Use --email, --password or --verified / --no-verified.`
			);
		}
		const field = settable.find((candidate) => candidate.name === key);
		if (!field) {
			const names = settable.map((candidate) => candidate.name);
			throw new Error(
				`${collection.name} has no field named "${key}".\n\n` +
					(names.length > 0
						? `Its fields: ${names.join(', ')}.`
						: 'It has no fields beyond email and password.')
			);
		}
		data[key] = coerceValue(raw, field);
	}
	return data;
}

/** The record id an email signs in as, or null. Only "not found" means null. */
export async function findUserByEmail(
	pb: UsersClient,
	collection: string,
	email: string
): Promise<string | null> {
	try {
		const record = await pb
			.collection(collection)
			.getFirstListItem(pb.filter('email = {:email}', { email }));
		return record.id;
	} catch (error) {
		// A dropped connection must not read as "no such account" and turn an
		// update into a create.
		if (statusOf(error) === 404) return null;
		throw error;
	}
}

/**
 * Create the account, or — with `update` — change the one the email already
 * has. Without `update` an existing email is an error: quietly resetting
 * somebody's password because a command was run twice is not a default.
 */
export async function saveAppUser(
	pb: UsersClient,
	collection: AuthCollection,
	input: AppUserInput
): Promise<AppUserOutcome> {
	const extra = resolveExtraFields(collection, input.set ?? {});
	if (input.name !== undefined && !collection.hasName) {
		throw new Error(
			`${collection.name} has no \`name\` field, so --name has nowhere to go. Use --set <field>=<value>.`
		);
	}
	if (input.password !== undefined && input.password.length < collection.minPassword) {
		throw new Error(
			`The password needs at least ${collection.minPassword} characters for ${collection.name}.`
		);
	}

	const data: Record<string, unknown> = { ...extra };
	if (input.name !== undefined) data.name = input.name;

	const existing = await findUserByEmail(pb, collection.name, input.email);
	try {
		if (existing) {
			if (!input.update) {
				throw new Error(
					`${input.email} already has an account in ${collection.name}.\n\n` +
						'Pass --update to change its password or fields.'
				);
			}
			if (input.verified !== undefined) data.verified = input.verified;
			if (input.password !== undefined) {
				data.password = input.password;
				data.passwordConfirm = input.password;
			}
			if (Object.keys(data).length === 0) {
				throw new Error(
					`Nothing to update for ${input.email}: pass --password, --name, --set or --verified.`
				);
			}
			await pb.collection(collection.name).update(existing, data);
			return {
				action: 'updated',
				id: existing,
				fields: writtenFields(data),
				passwordChanged: input.password !== undefined
			};
		}

		if (input.password === undefined) {
			throw new Error('A new account needs a password.');
		}
		const record = await pb.collection(collection.name).create({
			...data,
			email: input.email,
			password: input.password,
			passwordConfirm: input.password,
			verified: input.verified ?? true
		});
		return {
			action: 'created',
			id: record.id,
			fields: writtenFields({ ...data, verified: true }),
			passwordChanged: true
		};
	} catch (error) {
		const detail = fieldErrors(error);
		if (detail) {
			throw new Error(
				`PocketBase refused the ${existing ? 'update' : 'new account'}:\n\n${detail}`,
				{ cause: error }
			);
		}
		throw error;
	}
}

function writtenFields(data: Record<string, unknown>): string[] {
	return Object.keys(data).filter((key) => key !== 'password' && key !== 'passwordConfirm');
}
