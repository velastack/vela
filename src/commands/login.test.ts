import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { stringify } from 'devalue';
import { API_URL } from '../lib/constants.ts';

const prompts = vi.hoisted(() => ({
	select: vi.fn(),
	text: vi.fn(),
	password: vi.fn(),
	group: vi.fn()
}));

vi.mock('@clack/prompts', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@clack/prompts')>();
	return {
		...actual,
		select: prompts.select,
		text: prompts.text,
		password: prompts.password,
		group: prompts.group,
		log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), message: vi.fn() },
		cancel: vi.fn()
	};
});

const writeConfig = vi.fn();
vi.mock('../lib/config.ts', () => ({ writeConfig: (...args: unknown[]) => writeConfig(...args) }));

const { loginInteractively } = await import('./login.ts');
const { signup } = await import('./signup.ts');
const { validatePhone } = await import('../lib/account.ts');

type Call = { path: string; method: string; body: Record<string, string> };

/**
 * A stand-in for velastack.dev: `methods` is what auth-methods answers, the
 * rest is the pages the commands post to. Records every call.
 */
function site(options: {
	methods?: unknown;
	codePage?: 'welcome' | 'dashboard' | 'wrong' | 'always-wrong';
	otpId?: string;
}) {
	const calls: Call[] = [];
	const otpId = options.otpId ?? 'otp123';
	let codeAttempts = 0;

	const respond = (status: number, headers: Record<string, string> = {}, url = API_URL) => {
		const res = new Response(null, { status, headers });
		Object.defineProperty(res, 'url', { value: url });
		return res;
	};
	// Form actions answer the way SvelteKit's own client gets them: a JSON
	// action result, with the session cookie on it when the action set one.
	const redirect = (location: string, headers: Record<string, string> = {}) => {
		const res = Response.json({ type: 'redirect', status: 303, location }, { headers });
		Object.defineProperty(res, 'url', { value: API_URL });
		return res;
	};
	const failure = (text: string) =>
		Response.json({
			type: 'failure',
			status: 400,
			data: stringify({ form: { message: { type: 'error', text } } })
		});
	const session = { 'set-cookie': 'pb_auth=session; Path=/' };

	const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(
			typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
		);
		const body = Object.fromEntries(new URLSearchParams((init?.body as string) ?? ''));
		calls.push({ path: url.pathname, method: init?.method ?? 'GET', body });

		switch (url.pathname) {
			case '/api/collections/users/auth-methods':
				if (options.methods === 'down') return respond(500);
				return Response.json(options.methods ?? {});
			case '/login':
			case '/signup':
				if (body.type === 'whatsapp') return redirect(`/whatsapp/${otpId}`);
				if (body.password === 'right') return redirect('/dashboard', session);
				return failure('Failed to authenticate.');
			case `/whatsapp/${otpId}`:
				codeAttempts++;
				if (
					options.codePage === 'always-wrong' ||
					(options.codePage === 'wrong' && codeAttempts < 2)
				) {
					return failure('Invalid or expired code.');
				}
				return redirect(
					options.codePage === 'welcome' ? '/welcome?redirect=%2Fdashboard' : '/dashboard',
					session
				);
			case '/welcome':
				return redirect('/dashboard');
			case '/api-keys/new':
				return redirect('/api-keys', {
					'set-cookie': `flash=${encodeURIComponent(JSON.stringify({ apiKey: 'key1.secret' }))}; Path=/`
				});
			case '/api/collections/api_keys/records':
				return Response.json({ items: [] });
			default:
				return respond(404);
		}
	});
	vi.stubGlobal('fetch', fetchMock);
	return { calls };
}

const WHATSAPP_ON = {
	password: { enabled: true },
	whatsapp: { enabled: true, allowSignup: true, codeLength: 6, duration: 300 }
};

beforeEach(() => {
	prompts.select.mockReset();
	prompts.text.mockReset();
	prompts.password.mockReset();
	prompts.group.mockReset();
	writeConfig.mockReset();
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('vela login', () => {
	test('signs in with a WhatsApp code through the site pages and mints a key', async () => {
		const { calls } = site({ methods: WHATSAPP_ON, codePage: 'dashboard' });
		prompts.select.mockResolvedValue('whatsapp');
		prompts.text.mockResolvedValueOnce('+1 616 555 0123').mockResolvedValueOnce('123456');

		await expect(loginInteractively()).resolves.toBe('key1.secret');

		expect(calls.map((c) => c.path)).toEqual([
			'/api/collections/users/auth-methods',
			'/login',
			'/whatsapp/otp123',
			'/api-keys/new',
			'/api/collections/api_keys/records'
		]);
		expect(calls[1]!.body).toEqual({ type: 'whatsapp', phone: '+1 616 555 0123' });
		expect(calls[2]!.body).toEqual({ otp: '123456' });
		expect(writeConfig).toHaveBeenCalledWith({ apiKey: 'key1.secret' });
		// no name asked: the account already existed
		expect(prompts.text).toHaveBeenCalledTimes(2);
	});

	test('asks a new account for its name, as the site does on /welcome', async () => {
		const { calls } = site({ methods: WHATSAPP_ON, codePage: 'welcome' });
		prompts.select.mockResolvedValue('whatsapp');
		prompts.text
			.mockResolvedValueOnce('+16165550123')
			.mockResolvedValueOnce('123456')
			.mockResolvedValueOnce('  Ada  ');

		await loginInteractively();

		const welcome = calls.find((c) => c.path === '/welcome');
		expect(welcome).toMatchObject({ method: 'POST', body: { name: 'Ada' } });
		expect(calls.map((c) => c.path).indexOf('/welcome')).toBeLessThan(
			calls.map((c) => c.path).indexOf('/api-keys/new')
		);
	});

	test('lets a wrong code be retyped', async () => {
		const { calls } = site({ methods: WHATSAPP_ON, codePage: 'wrong' });
		prompts.select.mockResolvedValue('whatsapp');
		prompts.text
			.mockResolvedValueOnce('+16165550123')
			.mockResolvedValueOnce('000000')
			.mockResolvedValueOnce('123456');

		await expect(loginInteractively()).resolves.toBe('key1.secret');
		expect(calls.filter((c) => c.path === '/whatsapp/otp123').map((c) => c.body.otp)).toEqual([
			'000000',
			'123456'
		]);
	});

	test('gives up after three wrong codes', async () => {
		site({ methods: WHATSAPP_ON, codePage: 'always-wrong' });
		prompts.select.mockResolvedValue('whatsapp');
		prompts.text.mockResolvedValueOnce('+16165550123').mockResolvedValue('000000');

		await expect(loginInteractively()).rejects.toThrow(
			'Invalid or expired code. Run `vela login` again.'
		);
		expect(prompts.text).toHaveBeenCalledTimes(4);
		expect(writeConfig).not.toHaveBeenCalled();
	});

	test('goes straight to email when the site has no WhatsApp', async () => {
		const { calls } = site({ methods: { password: { enabled: true }, otp: { enabled: false } } });
		prompts.group.mockResolvedValue({ email: 'a@b.co', password: 'right' });

		await expect(loginInteractively()).resolves.toBe('key1.secret');

		expect(prompts.select).not.toHaveBeenCalled();
		expect(calls[1]).toMatchObject({
			path: '/login',
			body: { type: 'password', email: 'a@b.co', password: 'right' }
		});
	});

	test('still logs in with email when auth-methods cannot be read', async () => {
		site({ methods: 'down' });
		prompts.group.mockResolvedValue({ email: 'a@b.co', password: 'right' });

		await expect(loginInteractively()).resolves.toBe('key1.secret');
		expect(prompts.select).not.toHaveBeenCalled();
	});

	test('a wrong password is an error, not a key', async () => {
		site({ methods: WHATSAPP_ON });
		prompts.select.mockResolvedValue('password');
		prompts.group.mockResolvedValue({ email: 'a@b.co', password: 'wrong' });

		await expect(loginInteractively()).rejects.toThrow('Failed to authenticate. Run `vela signup`');
		expect(writeConfig).not.toHaveBeenCalled();
	});
});

describe('vela signup', () => {
	test('offers WhatsApp only when the site lets unknown numbers sign up', async () => {
		site({
			methods: { ...WHATSAPP_ON, whatsapp: { ...WHATSAPP_ON.whatsapp, allowSignup: false } }
		});
		prompts.group.mockResolvedValue({
			email: 'a@b.co',
			password: 'right',
			passwordConfirm: 'right'
		});

		await signup.parseAsync([], { from: 'user' });

		expect(prompts.select).not.toHaveBeenCalled();
		expect(writeConfig).toHaveBeenCalledWith({ apiKey: 'key1.secret' });
	});

	test('signs up over WhatsApp and asks for a name', async () => {
		const { calls } = site({ methods: WHATSAPP_ON, codePage: 'welcome' });
		prompts.select.mockResolvedValue('whatsapp');
		prompts.text
			.mockResolvedValueOnce('+16165550123')
			.mockResolvedValueOnce('123456')
			.mockResolvedValueOnce('Ada');

		await signup.parseAsync([], { from: 'user' });

		expect(prompts.select.mock.calls[0]![0]).toMatchObject({
			message: 'How do you want to sign up?'
		});
		expect(calls.map((c) => c.path)).toEqual([
			'/api/collections/users/auth-methods',
			'/signup',
			'/whatsapp/otp123',
			'/welcome',
			'/api-keys/new',
			'/api/collections/api_keys/records'
		]);
		expect(calls[1]!.body).toEqual({ type: 'whatsapp', phone: '+16165550123' });
		expect(writeConfig).toHaveBeenCalledWith({ apiKey: 'key1.secret' });
	});
});

describe('validatePhone', () => {
	test.each([
		'+16165550123',
		'+1 616 555 0123',
		'+1 (616) 555-0123',
		'0016165550123',
		' +244 923 456 789 '
	])('accepts %s', (phone) => {
		expect(validatePhone(phone)).toBeUndefined();
	});

	test.each([
		'6165550123',
		'+0123456789',
		'+1234567',
		'+1616555012345678',
		'+1 616 abc',
		'',
		undefined
	])('rejects %s', (phone) => {
		expect(validatePhone(phone)).toMatch(/international format/);
	});
});

describe('postForm', () => {
	test('reads the field error when the form has no message', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () =>
				Response.json({
					type: 'failure',
					status: 400,
					data: stringify({
						form: { message: undefined, errors: { phone: ['invalid phone number'] } }
					})
				})
			)
		);
		const { postForm } = await import('../lib/account.ts');
		const makeFetchCookie = (await import('fetch-cookie')).default;
		await expect(postForm(makeFetchCookie(fetch), '/login', {})).resolves.toEqual({
			type: 'failure',
			status: 400,
			message: 'invalid phone number'
		});
	});

	test('a non-JSON answer is an error with the status', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response('<html>', { status: 502 }))
		);
		const { postForm } = await import('../lib/account.ts');
		const makeFetchCookie = (await import('fetch-cookie')).default;
		await expect(postForm(makeFetchCookie(fetch), '/login', {})).resolves.toEqual({
			type: 'error',
			message: 'velastack.dev answered 502'
		});
	});
});
