import { describe, expect, test } from 'vitest';
import {
	cmsEndpointFor,
	decideLink,
	linkNextSteps,
	normalizeCmsUrl,
	type CreateLinkOutcome
} from './link-on-create.ts';

const at = (overrides: Partial<Parameters<typeof decideLink>[0]>) =>
	decideLink({ needsCms: false, loggedIn: false, interactive: true, ...overrides });

describe('decideLink', () => {
	test('--link none never links, whatever the state', () => {
		expect(at({ link: 'none', loggedIn: true })).toEqual({ kind: 'none' });
		expect(at({ link: 'none', needsCms: true, interactive: false })).toEqual({ kind: 'none' });
	});

	test('--link new creates with a key and fails without one', () => {
		expect(at({ link: 'new', loggedIn: true, interactive: false })).toEqual({ kind: 'create' });
		expect(at({ link: 'new' })).toMatchObject({ kind: 'error', message: /vela login/ });
	});

	test('--link <id> links an existing project with a key and fails without one', () => {
		expect(at({ link: '2tj321uzke7k7fn', loggedIn: true })).toEqual({
			kind: 'existing',
			projectId: '2tj321uzke7k7fn'
		});
		expect(at({ link: '2tj321uzke7k7fn' })).toMatchObject({ kind: 'error' });
	});

	test('at a terminal, a logged-in user is linked without being asked', () => {
		expect(at({ loggedIn: true })).toEqual({ kind: 'create' });
		expect(at({ loggedIn: true, needsCms: true })).toEqual({ kind: 'create' });
	});

	test('at a terminal, logged out: a CMS template asks, another template stays quiet', () => {
		expect(at({ needsCms: true })).toEqual({ kind: 'prompt-cms' });
		expect(at({})).toEqual({ kind: 'none' });
	});

	// A CI job holding a deploy key must not mint a project per run.
	test('off a terminal nothing is created unless a flag says so', () => {
		expect(at({ interactive: false, loggedIn: true })).toEqual({ kind: 'none' });
		expect(at({ interactive: false, loggedIn: true, needsCms: true })).toMatchObject({
			kind: 'none',
			warn: expect.stringContaining('--link new')
		});
		expect(at({ interactive: false, needsCms: true })).toMatchObject({
			kind: 'none',
			warn: expect.stringContaining('https://velastack.dev')
		});
	});
});

describe('cmsEndpointFor', () => {
	test('is the hosted CMS of a velastack.dev project', () => {
		expect(cmsEndpointFor('2tj321uzke7k7fn')).toMatch(/\/v1\/projects\/2tj321uzke7k7fn\/cms$/);
	});
});

describe('normalizeCmsUrl', () => {
	test('trims and drops trailing slashes', () => {
		expect(normalizeCmsUrl(' https://cms.example/v1/projects/p/cms/ ')).toBe(
			'https://cms.example/v1/projects/p/cms'
		);
	});
});

describe('linkNextSteps', () => {
	const base: CreateLinkOutcome = {
		cmsEndpoint: '',
		cmsSource: 'none',
		templateCms: false,
		loggedIn: false,
		interactive: true
	};
	const linked = {
		projectId: 'p',
		teamId: 't',
		projectName: 'Ellery Street',
		dashboardUrl: 'https://velastack.dev/personal/ellery-street'
	};

	test('a linked CMS template points at the editors page', () => {
		const steps = linkNextSteps({
			...base,
			linked,
			templateCms: true,
			cmsEndpoint: 'https://velastack.dev/v1/projects/p/cms',
			cmsSource: 'linked',
			loggedIn: true
		});
		expect(steps).toEqual([expect.stringContaining(`${linked.dashboardUrl}/cms/editors`)]);
	});

	test('a linked plain template points at deploy', () => {
		expect(linkNextSteps({ ...base, linked, loggedIn: true })).toEqual([
			expect.stringContaining('`vela deploy`')
		]);
	});

	test('an external CMS only needs the admin bar hint', () => {
		expect(
			linkNextSteps({
				...base,
				templateCms: true,
				cmsEndpoint: 'https://cms.example/v1/projects/p/cms',
				cmsSource: 'flag'
			})
		).toEqual(['Open any page with `?edit` and sign in from the admin bar.']);
	});

	test('a CMS template left blind says where to get one', () => {
		expect(linkNextSteps({ ...base, templateCms: true })).toEqual([
			expect.stringContaining('https://velastack.dev')
		]);
	});

	test('a logged-out user at a terminal learns about vela login', () => {
		expect(linkNextSteps(base)).toEqual([expect.stringContaining('`vela login`')]);
		expect(linkNextSteps({ ...base, interactive: false })).toEqual([]);
	});
});
