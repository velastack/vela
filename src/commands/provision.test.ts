import { describe, expect, test } from 'vitest';
import pkg from '../../package.json' with { type: 'json' };
import { provision, provisionArgs, redeployNotice } from './provision.ts';

describe('provision arguments', () => {
	test('swap is left to the script by default', () => {
		expect(provisionArgs({}, '0.42.2')).toEqual([
			'--pb-version',
			'0.42.2',
			'--node-major',
			'26',
			'--cli-version',
			pkg.version
		]);
		expect(provisionArgs({ swap: true }, '0.42.2')).not.toContain('--no-swap');
	});

	test('--no-swap reaches the script', () => {
		expect(provisionArgs({ swap: false, nodeMajor: '24' }, '0.42.2')).toEqual([
			'--pb-version',
			'0.42.2',
			'--node-major',
			'24',
			'--cli-version',
			pkg.version,
			'--no-swap'
		]);
	});

	test('the command offers --no-swap', () => {
		expect(provision.options.map((option) => option.long)).toContain('--no-swap');
	});
});

describe('after a Node major upgrade', () => {
	const state = (name: string, env: string, url: string, runtimeDependencies?: boolean) => ({
		appId: name,
		name,
		env,
		instance: env === 'prod' ? name : `${name}--${env}`,
		url,
		...(runtimeDependencies === undefined ? {} : { runtimeDependencies })
	});

	test('names the apps to redeploy, by name, target and URL', () => {
		const notice = redeployNotice(
			[
				state('soty', 'prod', 'https://soty.rocks', true),
				state('atlas', 'staging', 'https://staging.atlas.example', true),
				state('atlas', 'prod', 'https://atlas.example', true)
			],
			'24',
			'v26.13.1'
		)!;
		expect(notice).toContain('Node moved from 24 to 26.13.1. Redeploy these apps now');
		expect(notice).toContain('installed for Node 24');
		expect(notice).toContain(
			[
				'  atlas  production  https://atlas.example',
				'  atlas  staging     https://staging.atlas.example',
				'  soty   production  https://soty.rocks'
			].join('\n')
		);
		expect(notice).not.toContain('prod ');
	});

	test('leaves out an app with nothing installed, and says so', () => {
		const notice = redeployNotice(
			[
				state('soty', 'prod', 'https://soty.rocks', false),
				state('atlas', 'prod', 'https://atlas.example', true)
			],
			'24',
			'v26.13.1'
		)!;
		expect(notice).toContain('Redeploy this app now: its dependencies');
		expect(notice).toContain('  atlas  production  https://atlas.example');
		expect(notice).not.toContain('soty');
		expect(notice).toContain('One other app has nothing installed');
	});

	test('lists an app whose server script did not say either way', () => {
		const notice = redeployNotice([state('soty', 'prod', 'https://soty.rocks')], '24', 'v26.0.0')!;
		expect(notice).toContain('  soty  production  https://soty.rocks');
	});

	test('says when no app needs one', () => {
		expect(
			redeployNotice([state('soty', 'prod', 'https://soty.rocks', false)], '24', 'v26.0.0')
		).toBe(
			'Node moved from 24 to 26.0.0. No app on this server has dependencies installed, so none needs a redeploy.'
		);
	});

	test('says nothing on a server with no apps', () => {
		expect(redeployNotice([], '24', 'v26.0.0')).toBeUndefined();
	});
});
