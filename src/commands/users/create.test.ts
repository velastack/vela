import { beforeEach, describe, expect, test, vi } from 'vitest';

const prompts = vi.hoisted(() => ({ text: vi.fn(), password: vi.fn() }));

vi.mock('@clack/prompts', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@clack/prompts')>();
	return {
		...actual,
		text: prompts.text,
		password: prompts.password,
		log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), message: vi.fn() },
		cancel: vi.fn()
	};
});

const { createUser } = await import('./create.ts');
const { coerceValue, parseSetPairs, resolveExtraFields } = await import('../../lib/app-users.ts');
type UsersClient = import('../../lib/app-users.ts').UsersClient;

const USERS = {
	name: 'users',
	type: 'auth',
	fields: [
		{ name: 'id', type: 'text' },
		{ name: 'password', type: 'password', min: 8 },
		{ name: 'tokenKey', type: 'text' },
		{ name: 'email', type: 'email' },
		{ name: 'verified', type: 'bool' },
		{ name: 'name', type: 'text' },
		{ name: 'admin', type: 'bool' },
		{ name: 'credits', type: 'number' },
		{ name: 'code', type: 'text' }
	]
};

function notFound(): Error {
	return Object.assign(new Error('not found'), { status: 404 });
}

/** A PocketBase client that holds collections and records in memory. */
function fakePb(options: {
	collections?: Record<string, { name: string; type: string; fields: unknown[] }>;
	records?: Array<Record<string, unknown>>;
	lookupError?: Error;
}) {
	const collections = options.collections ?? { users: USERS };
	const records = options.records ?? [];
	const calls: Array<{ op: 'create' | 'update'; id?: string; data: Record<string, unknown> }> = [];
	const pb = {
		filter: (raw: string, params: Record<string, unknown>) =>
			raw.replace('{:email}', JSON.stringify(params.email)),
		collections: {
			getOne: async (name: string) => {
				const found = collections[name];
				if (!found) throw notFound();
				return found;
			}
		},
		collection: () => ({
			getFirstListItem: async (filter: string) => {
				if (options.lookupError) throw options.lookupError;
				const found = records.find(
					(record) => filter === `email = ${JSON.stringify(record.email)}`
				);
				if (!found) throw notFound();
				return found;
			},
			create: async (data: Record<string, unknown>) => {
				calls.push({ op: 'create', data });
				const record = { id: `rec${records.length + 1}`, ...data };
				records.push(record);
				return record;
			},
			update: async (id: string, data: Record<string, unknown>) => {
				calls.push({ op: 'update', id, data });
				return { id, ...data };
			}
		})
	};
	return { pb: pb as unknown as UsersClient, calls };
}

beforeEach(() => {
	prompts.text.mockReset();
	prompts.password.mockReset();
});

describe('--set parsing', () => {
	test('splits on the first = only', () => {
		expect(parseSetPairs(['admin=true', 'note=a=b', 'empty='])).toEqual({
			admin: 'true',
			note: 'a=b',
			empty: ''
		});
	});

	test('a pair without a key is refused', () => {
		expect(() => parseSetPairs(['admin'])).toThrow(/key=value/);
		expect(() => parseSetPairs(['=x'])).toThrow(/key=value/);
	});

	test('the field type decides what a value means', () => {
		expect(coerceValue('true', { name: 'admin', type: 'bool' })).toBe(true);
		expect(coerceValue('false', { name: 'admin', type: 'bool' })).toBe(false);
		expect(() => coerceValue('yes', { name: 'admin', type: 'bool' })).toThrow(/admin=true/);
		expect(coerceValue('12.5', { name: 'credits', type: 'number' })).toBe(12.5);
		expect(() => coerceValue('lots', { name: 'credits', type: 'number' })).toThrow(/number/);
		// A text field keeps what was typed, leading zero and all.
		expect(coerceValue('0123', { name: 'code', type: 'text' })).toBe('0123');
		expect(coerceValue('true', { name: 'code', type: 'text' })).toBe('true');
		// An unknown type gets the plain reading.
		expect(coerceValue('true', { name: 'x', type: 'mystery' })).toBe(true);
		expect(coerceValue('7', { name: 'x', type: 'mystery' })).toBe(7);
		expect(coerceValue('seven', { name: 'x', type: 'mystery' })).toBe('seven');
	});

	test('an unknown field names the ones the collection has', () => {
		const collection = { name: 'users', fields: USERS.fields, minPassword: 8, hasName: true };
		expect(() => resolveExtraFields(collection, { isAdmin: 'true' })).toThrow(
			/no field named "isAdmin"[\s\S]*name, admin, credits, code/
		);
		expect(() => resolveExtraFields(collection, { email: 'a@b.c' })).toThrow(/--email/);
	});
});

describe('vela users create', () => {
	test('creates a verified account from flags alone, with no terminal', async () => {
		const { pb, calls } = fakePb({});
		const result = await createUser(
			pb,
			{
				email: 'ada@example.com',
				password: 'correct horse',
				name: 'Ada',
				set: ['admin=true', 'credits=3']
			},
			false
		);
		expect(calls).toEqual([
			{
				op: 'create',
				data: {
					email: 'ada@example.com',
					password: 'correct horse',
					passwordConfirm: 'correct horse',
					verified: true,
					name: 'Ada',
					admin: true,
					credits: 3
				}
			}
		]);
		expect(result).toMatchObject({ action: 'created', email: 'ada@example.com' });
		expect(result.generatedPassword).toBeUndefined();
		expect(prompts.text).not.toHaveBeenCalled();
		expect(prompts.password).not.toHaveBeenCalled();
	});

	test('generates a password when none is given, and hands it back once', async () => {
		const { pb, calls } = fakePb({});
		const result = await createUser(pb, { email: 'ada@example.com' }, false);
		expect(result.generatedPassword).toMatch(/^[\w-]{20,}$/);
		expect(calls[0]!.data.password).toBe(result.generatedPassword);
	});

	test('--no-verified leaves the email unverified', async () => {
		const { pb, calls } = fakePb({});
		await createUser(pb, { email: 'ada@example.com', verified: false }, false);
		expect(calls[0]!.data.verified).toBe(false);
	});

	test('without a terminal, a missing --email is an error naming the flag', async () => {
		const { pb, calls } = fakePb({});
		await expect(createUser(pb, {}, false)).rejects.toThrow(/--email/);
		expect(calls).toEqual([]);
	});

	test('on a terminal, asks for what the flags left out', async () => {
		prompts.text.mockResolvedValueOnce('ada@example.com').mockResolvedValueOnce('Ada');
		prompts.password.mockResolvedValueOnce('');
		const { pb, calls } = fakePb({});
		const result = await createUser(pb, {}, true);
		expect(calls[0]!.data).toMatchObject({ email: 'ada@example.com', name: 'Ada' });
		// Left empty at the prompt: generated.
		expect(result.generatedPassword).toBeTruthy();
	});

	test('an existing email fails before a password is asked for', async () => {
		const { pb, calls } = fakePb({ records: [{ id: 'rec1', email: 'ada@example.com' }] });
		await expect(createUser(pb, { email: 'ada@example.com' }, true)).rejects.toThrow(
			/already has an account in users[\s\S]*--update/
		);
		expect(prompts.password).not.toHaveBeenCalled();
		expect(calls).toEqual([]);
	});

	test('--update changes the password and fields of the existing account', async () => {
		const { pb, calls } = fakePb({ records: [{ id: 'rec1', email: 'ada@example.com' }] });
		const result = await createUser(
			pb,
			{ email: 'ada@example.com', password: 'a new password', set: ['admin=true'], update: true },
			false
		);
		expect(calls).toEqual([
			{
				op: 'update',
				id: 'rec1',
				data: { admin: true, password: 'a new password', passwordConfirm: 'a new password' }
			}
		]);
		expect(result).toMatchObject({ action: 'updated', passwordChanged: true });
	});

	test('--update without a password leaves the password alone', async () => {
		const { pb, calls } = fakePb({ records: [{ id: 'rec1', email: 'ada@example.com' }] });
		const result = await createUser(
			pb,
			{ email: 'ada@example.com', set: ['admin=false'], update: true },
			false
		);
		expect(calls[0]!.data).toEqual({ admin: false });
		expect(result.passwordChanged).toBe(false);
		expect(result.generatedPassword).toBeUndefined();
	});

	test('a failed lookup is not read as "no such account"', async () => {
		const { pb, calls } = fakePb({
			lookupError: Object.assign(new Error('connection reset'), { status: 0 })
		});
		await expect(
			createUser(pb, { email: 'ada@example.com', password: 'correct horse' }, false)
		).rejects.toThrow(/connection reset/);
		expect(calls).toEqual([]);
	});

	test('an unknown --set field stops before anything is written', async () => {
		const { pb, calls } = fakePb({});
		await expect(
			createUser(pb, { email: 'ada@example.com', set: ['isAdmin=true'] }, false)
		).rejects.toThrow(/no field named "isAdmin"/);
		expect(calls).toEqual([]);
	});

	test('a password shorter than the collection allows is refused', async () => {
		const { pb } = fakePb({});
		await expect(
			createUser(pb, { email: 'ada@example.com', password: 'short' }, false)
		).rejects.toThrow(/at least 8 characters/);
	});

	test('--collection must name an auth collection', async () => {
		const { pb } = fakePb({
			collections: {
				posts: { name: 'posts', type: 'base', fields: [] },
				_superusers: { name: '_superusers', type: 'auth', fields: [] }
			}
		});
		await expect(createUser(pb, { email: 'a@b.c' }, false)).rejects.toThrow(
			/no collection named "users"[\s\S]*vela enable auth/
		);
		await expect(createUser(pb, { email: 'a@b.c', collection: 'posts' }, false)).rejects.toThrow(
			/base collection/
		);
		await expect(
			createUser(pb, { email: 'a@b.c', collection: '_superusers' }, false)
		).rejects.toThrow(/vela admin create/);
	});

	test('--name on a collection without a name field says where to put it', async () => {
		const { pb } = fakePb({
			collections: { members: { name: 'members', type: 'auth', fields: [] } }
		});
		await expect(
			createUser(pb, { email: 'a@b.c', name: 'Ada', collection: 'members' }, false)
		).rejects.toThrow(/no `name` field/);
	});

	test('field errors from PocketBase are spelled out', async () => {
		const { pb } = fakePb({});
		const failing = {
			...pb,
			collection: () => ({
				getFirstListItem: async () => {
					throw notFound();
				},
				create: async () => {
					throw Object.assign(new Error('Failed to create record.'), {
						status: 400,
						response: { data: { invite: { message: 'Cannot be blank.' } } }
					});
				}
			})
		} as unknown as UsersClient;
		await expect(createUser(failing, { email: 'a@b.c' }, false)).rejects.toThrow(
			/invite: Cannot be blank\./
		);
	});
});
