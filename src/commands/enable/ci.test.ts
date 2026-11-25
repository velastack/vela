import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { apiKeyLines, enableCi, nextSteps, type EnableCiDeps } from './ci.ts';
import {
	checkPrerequisites,
	parseGithubRemote,
	renderDeployWorkflow,
	WORKFLOW_PATH,
	type ProjectFacts
} from '../../lib/ci-workflow.ts';
import {
	ciKeyPlan,
	INSTALL_KEY_SCRIPT,
	manualKeySteps,
	realCiKeyEffects,
	setupCiKey,
	type CiKeyEffects,
	type CiKeyInput
} from '../../lib/ci-key.ts';

const PUBLIC_KEY = 'ssh-ed25519 AAAAC3Nza vela-ci soty-690c70bd';

/** Stand-ins for the three outside effects, recording the order they ran in. */
function fakeEffects(overrides: Partial<CiKeyEffects> = {}) {
	const calls: string[] = [];
	const effects: CiKeyEffects = {
		checkGh: async () => {
			calls.push('checkGh');
		},
		showPlan: (plan) => {
			calls.push(`showPlan ${plan.length}`);
		},
		confirm: async () => {
			calls.push('confirm');
			return true;
		},
		generateKey: async (comment) => {
			calls.push(`generateKey ${comment}`);
			return {
				dir: '/tmp/fake-key',
				privateKeyPath: '/tmp/fake-key/id_ed25519',
				publicKey: PUBLIC_KEY
			};
		},
		installPublicKey: async (server, publicKey) => {
			calls.push(`installPublicKey ${server} ${publicKey}`);
			return 'added';
		},
		setSecret: async (repo, name, file) => {
			calls.push(`setSecret ${repo.owner}/${repo.repo} ${name} ${file}`);
		},
		removeDir: (dir) => {
			calls.push(`removeDir ${dir}`);
		},
		mintApiKey: async (label) => {
			calls.push(`mintApiKey ${label}`);
			return { id: 'newkey', key: 'newkey.secret' };
		},
		setSecretValue: async (repo, name) => {
			// The value is a secret: the call is recorded, never what it carried.
			calls.push(`setSecretValue ${repo.owner}/${repo.repo} ${name}`);
		},
		revokeApiKey: async (id) => {
			calls.push(`revokeApiKey ${id}`);
		},
		revokeOtherApiKeys: async (label, keepId) => {
			calls.push(`revokeOtherApiKeys ${label} keep ${keepId}`);
		},
		...overrides
	};
	return { effects, calls };
}

const INPUT: CiKeyInput = {
	appId: 'soty-690c70bd',
	server: 'root@203.0.113.9',
	repo: { owner: 'acme', repo: 'soty' },
	yes: false,
	interactive: true
};

describe('the workflow', () => {
	test('minimal: checkout, the action at v1, the key, and nothing the action can read itself', () => {
		const yaml = renderDeployWorkflow({ branch: 'main', backend: false });
		expect(yaml).toContain('branches: [main]');
		expect(yaml).toContain('- uses: actions/checkout@v6');
		expect(yaml).toContain('- uses: velastack/action@v1');
		expect(yaml).toContain('ssh-key: ${{ secrets.SSH_PRIVATE_KEY }}');
		// The action reads these from .vela/project.json; `target` defaults to
		// production, which is the `prod` entry.
		expect(yaml).not.toMatch(/^\s+(target|server|domain):/m);
		// Offered, not on.
		expect(yaml).toContain('# api-key: ${{ secrets.VELA_API_KEY }}');
		expect(yaml).not.toMatch(/^\s+api-key:/m);
		expect(yaml).not.toContain('pull_request');
		expect(yaml).not.toContain('POCKETBASE_SUPERUSER');
		expect(yaml).not.toMatch(/^\s+env:/m);
		expect(yaml).toContain('vela env import');
		expect(yaml).not.toContain('\t');
	});

	test('a backend project gets placeholder superuser variables', () => {
		const yaml = renderDeployWorkflow({ branch: 'main', backend: true });
		expect(yaml).toMatch(
			/^ {8}env:\n(?: {10}#.*\n)+ {10}POCKETBASE_SUPERUSER_EMAIL: ci@example\.com\n {10}POCKETBASE_SUPERUSER_PASSWORD: ci-build-only-password$/m
		);
		expect(yaml).not.toContain('secrets.POCKETBASE');
	});

	test('--api-key-secret passes the key', () => {
		const yaml = renderDeployWorkflow({ branch: 'main', backend: false, apiKeySecret: true });
		expect(yaml).toMatch(/^ {10}api-key: \$\{\{ secrets\.VELA_API_KEY \}\}$/m);
	});

	test('--previews adds the pull request events, permission, per-branch queue and the key', () => {
		const yaml = renderDeployWorkflow({ branch: 'main', backend: true, previews: true });
		expect(yaml).toContain('    types: [opened, synchronize, reopened, closed]');
		expect(yaml).toContain('  pull-requests: write');
		expect(yaml).toContain('  group: vela-${{ github.head_ref || github.ref_name }}');
		expect(yaml).toMatch(/^ {10}api-key: \$\{\{ secrets\.VELA_API_KEY \}\}$/m);
		expect(yaml).toContain('github.event.pull_request.head.repo.full_name == github.repository');
		// Still no target: the action names the preview from the event.
		expect(yaml).not.toMatch(/^\s+target:/m);
	});

	test('a branch that is not a plain word is quoted; a nested app names its directory', () => {
		const yaml = renderDeployWorkflow({
			branch: 'release #1',
			backend: false,
			workingDirectory: 'apps/web',
			sshPort: '2222'
		});
		expect(yaml).toContain('branches: ["release #1"]');
		expect(yaml).toContain('          working-directory: apps/web');
		expect(yaml).toContain('          ssh-port: "2222"');
		// A branch YAML would read as a boolean or a number stays a string.
		expect(renderDeployWorkflow({ branch: 'on', backend: false })).toContain('branches: ["on"]');
		expect(renderDeployWorkflow({ branch: '1.0', backend: false })).toContain('branches: ["1.0"]');
	});
});

describe('GitHub remotes', () => {
	test.each([
		['git@github.com:acme/soty.git', 'acme', 'soty'],
		['https://github.com/acme/soty.git', 'acme', 'soty'],
		['https://github.com/acme/soty', 'acme', 'soty'],
		['https://user@github.com/acme/so.ty/', 'acme', 'so.ty'],
		['ssh://git@github.com/acme/soty.git', 'acme', 'soty']
	])('%s', (url, owner, repo) => {
		expect(parseGithubRemote(url)).toEqual({ owner, repo });
	});

	test('other hosts are not GitHub', () => {
		expect(parseGithubRemote('git@gitlab.com:acme/soty.git')).toBeNull();
		expect(parseGithubRemote('https://github.com.evil.test/acme/soty')).toBeNull();
	});
});

describe('prerequisites', () => {
	const ready: ProjectFacts = {
		lockfiles: ['package-lock.json'],
		server: 'root@203.0.113.9',
		appId: 'soty-690c70bd',
		gitRoot: '/repo',
		projectFileTracked: true,
		github: { owner: 'acme', repo: 'soty' },
		linked: false,
		otherRemotes: []
	};
	const byId = (facts: ProjectFacts) =>
		Object.fromEntries(checkPrerequisites(facts).map((check) => [check.id, check]));

	test('a deployed npm project on GitHub has nothing to do', () => {
		expect(checkPrerequisites(ready).every((check) => check.done)).toBe(true);
	});

	test('pnpm alone is fine; with both, npm is what installs', () => {
		expect(byId({ ...ready, lockfiles: ['pnpm-lock.yaml'] }).lockfile).toMatchObject({
			done: true,
			detail: expect.stringContaining('pnpm install --frozen-lockfile')
		});
		expect(
			byId({ ...ready, lockfiles: ['package-lock.json', 'pnpm-lock.yaml'] }).lockfile!.detail
		).toContain('prefers npm');
	});

	test('another lockfile, or none, is explained', () => {
		const yarn = byId({ ...ready, lockfiles: ['yarn.lock'] }).lockfile!;
		expect(yarn.done).toBe(false);
		expect(yarn.detail).toMatch(/yarn\.lock[\s\S]*npm or pnpm/);
		expect(byId({ ...ready, lockfiles: [] }).lockfile).toMatchObject({ done: false });
	});

	test('no binding: deploy once from this machine first', () => {
		const checks = byId({ ...ready, server: undefined, appId: undefined });
		expect(checks.target).toMatchObject({ done: false });
		expect(checks.target!.detail).toContain('vela deploy --server');
		// Nothing to commit yet, so nothing to nag about.
		expect(checks['project-file']).toBeUndefined();
	});

	test('an uncommitted project file is called out', () => {
		expect(byId({ ...ready, projectFileTracked: false })['project-file']).toMatchObject({
			done: false,
			detail: expect.stringContaining('git add .vela/project.json')
		});
	});

	test('no repository, or no GitHub remote', () => {
		expect(byId({ ...ready, gitRoot: undefined, github: undefined }).github!.detail).toContain(
			'git init'
		);
		const gitlab = byId({ ...ready, github: undefined, otherRemotes: ['git@gitlab.com:a/b.git'] });
		expect(gitlab.github).toMatchObject({ done: false });
		expect(gitlab.github!.detail).toContain('gitlab.com');
	});
});

describe('setting up the key', () => {
	test('checks gh, shows the plan, then generates, installs, stores and cleans up, in that order', async () => {
		const { effects, calls } = fakeEffects();
		const outcome = await setupCiKey(INPUT, effects);
		expect(calls).toEqual([
			'checkGh',
			'showPlan 4',
			'confirm',
			'generateKey vela-ci soty-690c70bd',
			`installPublicKey root@203.0.113.9 ${PUBLIC_KEY}`,
			'setSecret acme/soty SSH_PRIVATE_KEY /tmp/fake-key/id_ed25519',
			'removeDir /tmp/fake-key'
		]);
		expect(outcome).toEqual({
			status: 'done',
			comment: 'vela-ci soty-690c70bd',
			installed: 'added',
			apiKey: false
		});
	});

	const WITH_API_KEY: CiKeyInput = { ...INPUT, apiKey: { label: 'CI - acme/soty' } };

	test('with an API key: issued after the deploy key, stored, and only then are older ones revoked', async () => {
		const { effects, calls } = fakeEffects();
		const outcome = await setupCiKey(WITH_API_KEY, effects);
		expect(calls).toEqual([
			'checkGh',
			'showPlan 6',
			'confirm',
			'generateKey vela-ci soty-690c70bd',
			`installPublicKey root@203.0.113.9 ${PUBLIC_KEY}`,
			'setSecret acme/soty SSH_PRIVATE_KEY /tmp/fake-key/id_ed25519',
			'mintApiKey CI - acme/soty',
			'setSecretValue acme/soty VELA_API_KEY',
			'revokeOtherApiKeys CI - acme/soty keep newkey',
			'removeDir /tmp/fake-key'
		]);
		expect(outcome).toMatchObject({ status: 'done', apiKey: true });
		expect(ciKeyPlan(WITH_API_KEY).join('\n')).toMatch(/acts as your account[\s\S]*VELA_API_KEY/);
	});

	test('an API key that could not be stored is revoked, and the older ones are left working', async () => {
		const { effects, calls } = fakeEffects({
			setSecretValue: async () => {
				throw new Error('HTTP 403: Resource not accessible');
			}
		});
		await expect(setupCiKey(WITH_API_KEY, effects)).rejects.toThrow(
			/VELA_API_KEY secret failed[\s\S]*403[\s\S]*has been revoked/
		);
		expect(calls).toContain('revokeApiKey newkey');
		expect(calls.some((call) => call.startsWith('revokeOtherApiKeys'))).toBe(false);
		expect(calls.at(-1)).toBe('removeDir /tmp/fake-key');
	});

	test('the plan names the server, the repository and the secret', () => {
		const plan = ciKeyPlan(INPUT).join('\n');
		expect(plan).toContain('root@203.0.113.9');
		expect(plan).toContain('github.com/acme/soty');
		expect(plan).toContain('SSH_PRIVATE_KEY');
		expect(plan).toContain('vela-ci soty-690c70bd');
	});

	test('declining touches nothing', async () => {
		const { effects, calls } = fakeEffects({ confirm: async () => false });
		expect(await setupCiKey(INPUT, effects)).toEqual({ status: 'declined' });
		expect(calls).toEqual(['checkGh', 'showPlan 4']);
	});

	test('--yes skips the question, and still shows what it is doing first', async () => {
		const { effects, calls } = fakeEffects();
		await setupCiKey({ ...INPUT, yes: true, interactive: false }, effects);
		expect(calls).not.toContain('confirm');
		expect(calls.indexOf('showPlan 4')).toBeGreaterThan(-1);
		expect(calls.indexOf('showPlan 4')).toBeLessThan(
			calls.findIndex((call) => call.startsWith('generateKey'))
		);
		expect(calls).toContain('setSecret acme/soty SSH_PRIVATE_KEY /tmp/fake-key/id_ed25519');
	});

	test('with no terminal and no --yes it fails naming the flag, before making a key', async () => {
		const { effects, calls } = fakeEffects();
		await expect(setupCiKey({ ...INPUT, interactive: false }, effects)).rejects.toThrow(/--yes/);
		expect(calls).toEqual([]);
	});

	test('a missing gh stops everything before the server is touched', async () => {
		const { effects, calls } = fakeEffects({
			checkGh: async () => {
				throw new Error('`gh` is not installed');
			}
		});
		await expect(setupCiKey({ ...INPUT, yes: true }, effects)).rejects.toThrow(/not installed/);
		expect(calls).toEqual([]);
	});

	test('a failed install still deletes the keypair, and stores nothing', async () => {
		const { effects, calls } = fakeEffects({
			installPublicKey: async () => {
				throw new Error('Could not connect');
			}
		});
		await expect(setupCiKey({ ...INPUT, yes: true }, effects)).rejects.toThrow(/Could not connect/);
		expect(calls.filter((call) => call.startsWith('setSecret'))).toEqual([]);
		expect(calls.at(-1)).toBe('removeDir /tmp/fake-key');
	});

	test('a failed secret says which line on the server is now orphaned, and still cleans up', async () => {
		const { effects, calls } = fakeEffects({
			setSecret: async () => {
				throw new Error('HTTP 403: Resource not accessible');
			}
		});
		const error = await setupCiKey({ ...INPUT, yes: true }, effects).catch((e: Error) => e);
		expect((error as Error).message).toMatch(
			/added to root@203\.0\.113\.9[\s\S]*HTTP 403[\s\S]*vela-ci soty-690c70bd/
		);
		expect(calls.at(-1)).toBe('removeDir /tmp/fake-key');
	});

	test('the manual steps are the same three, by hand', () => {
		const steps = manualKeySteps({
			appId: 'soty-690c70bd',
			server: 'root@203.0.113.9',
			repo: { owner: 'acme', repo: 'soty' }
		});
		expect(steps[0]).toBe("ssh-keygen -t ed25519 -N '' -C 'vela-ci soty-690c70bd' -f vela-ci-key");
		expect(steps[1]).toBe('ssh-copy-id -i vela-ci-key.pub root@203.0.113.9');
		expect(steps[2]).toBe('gh secret set SSH_PRIVATE_KEY -R acme/soty < vela-ci-key');
	});
});

describe('vela enable ci', () => {
	let dir: string;
	const git = (...args: string[]) =>
		execFileSync('git', args, { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] }).toString();

	function deps(overrides: Partial<EnableCiDeps> = {}) {
		const { effects, calls } = fakeEffects();
		const askSetupKey = vi.fn(async () => false);
		return {
			calls,
			askSetupKey,
			deps: { interactive: false, keyEffects: effects, askSetupKey, backend: true, ...overrides }
		};
	}

	function deployedProject() {
		fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"soty"}\n');
		fs.writeFileSync(path.join(dir, 'package-lock.json'), '{}\n');
		fs.mkdirSync(path.join(dir, '.vela'));
		fs.writeFileSync(
			path.join(dir, '.vela', 'project.json'),
			JSON.stringify({
				appId: 'soty-690c70bd',
				targets: { prod: { server: 'root@203.0.113.9', domain: 'soty.test' } }
			})
		);
		git('init', '-q', '-b', 'trunk');
		git('remote', 'add', 'origin', 'git@github.com:acme/soty.git');
		git('add', '.vela/project.json');
	}

	beforeEach(() => {
		dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vela-ci-test-')));
	});
	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	test('writes the workflow for the branch checked out and reports everything done', async () => {
		deployedProject();
		const { deps: d, calls, askSetupKey } = deps();
		const result = await enableCi(dir, {}, d);
		expect(result.workflow).toBe('created');
		expect(result.branch).toBe('trunk');
		const yaml = fs.readFileSync(path.join(dir, WORKFLOW_PATH), 'utf8');
		expect(yaml).toContain('branches: [trunk]');
		expect(yaml).toContain('POCKETBASE_SUPERUSER_EMAIL');
		expect(yaml).not.toContain('working-directory');
		expect(result.prerequisites.map((check) => [check.id, check.done])).toEqual([
			['lockfile', true],
			['target', true],
			['project-file', true],
			['github', true]
		]);
		// No terminal, no --setup-key: nothing is asked and nothing outside is touched.
		expect(result.key).toEqual({ status: 'skipped' });
		expect(askSetupKey).not.toHaveBeenCalled();
		expect(calls).toEqual([]);
	});

	test('does not mint an app id for a project that has never deployed', async () => {
		fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"soty"}\n');
		const { deps: d } = deps();
		const result = await enableCi(dir, {}, d);
		expect(result.branch).toBe('main');
		expect(fs.existsSync(path.join(dir, '.vela'))).toBe(false);
		expect(result.prerequisites.filter((check) => !check.done).map((check) => check.id)).toEqual([
			'lockfile',
			'target',
			'github'
		]);
	});

	test('refuses to overwrite a workflow that differs, unless --force', async () => {
		deployedProject();
		const file = path.join(dir, WORKFLOW_PATH);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, 'name: mine\n');
		const { deps: d } = deps();
		await expect(enableCi(dir, {}, d)).rejects.toThrow(/already exists[\s\S]*--force/);
		expect(fs.readFileSync(file, 'utf8')).toBe('name: mine\n');

		expect((await enableCi(dir, { force: true }, d)).workflow).toBe('overwritten');
		expect(fs.readFileSync(file, 'utf8')).toContain('velastack/action@v1');
		// Same content again is not an overwrite, and not an error.
		expect((await enableCi(dir, {}, d)).workflow).toBe('unchanged');
	});

	test('--setup-key leaves an existing workflow alone and sets up the key', async () => {
		deployedProject();
		const file = path.join(dir, WORKFLOW_PATH);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, 'name: mine\n');
		const { deps: d, calls } = deps();
		const result = await enableCi(dir, { setupKey: true, yes: true }, d);
		expect(result.workflow).toBe('kept');
		expect(fs.readFileSync(file, 'utf8')).toBe('name: mine\n');
		expect(result.key).toMatchObject({ status: 'done' });
		expect(calls).toContain(`installPublicKey root@203.0.113.9 ${PUBLIC_KEY}`);
		expect(calls).toContain('setSecret acme/soty SSH_PRIVATE_KEY /tmp/fake-key/id_ed25519');
	});

	test('--setup-key without a server or a repository explains instead of acting', async () => {
		fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"soty"}\n');
		const { deps: d, calls } = deps();
		await expect(enableCi(dir, { setupKey: true, yes: true }, d)).rejects.toThrow(
			/--setup-key needs[\s\S]*vela deploy --server/
		);
		expect(calls).toEqual([]);
		// Refused before the workflow was written, not after.
		expect(fs.existsSync(path.join(dir, WORKFLOW_PATH))).toBe(false);
	});

	test('--setup-key with no gh, or no way to confirm, writes nothing either', async () => {
		deployedProject();
		const { effects } = fakeEffects({
			checkGh: async () => {
				throw new Error('`gh` is not installed');
			}
		});
		const { deps: d } = deps({ keyEffects: effects });
		await expect(enableCi(dir, { setupKey: true, yes: true }, d)).rejects.toThrow(/not installed/);
		await expect(enableCi(dir, { setupKey: true }, deps().deps)).rejects.toThrow(/--yes/);
		expect(fs.existsSync(path.join(dir, WORKFLOW_PATH))).toBe(false);
	});

	test('on a terminal the key setup is offered, and a no leaves the manual steps', async () => {
		deployedProject();
		const { deps: d, calls, askSetupKey } = deps({ interactive: true });
		const result = await enableCi(dir, {}, d);
		expect(askSetupKey).toHaveBeenCalledTimes(1);
		expect(result.key).toEqual({ status: 'skipped' });
		expect(calls).toEqual([]);
	});

	test('an app below the repository root gets a working-directory, and the workflow goes to the root', async () => {
		git('init', '-q', '-b', 'main');
		const app = path.join(dir, 'apps', 'web');
		fs.mkdirSync(app, { recursive: true });
		fs.writeFileSync(path.join(app, 'package.json'), '{"name":"web"}\n');
		const { deps: d } = deps();
		const result = await enableCi(app, {}, d);
		expect(result.workflowFile).toBe(path.join(dir, WORKFLOW_PATH));
		expect(fs.readFileSync(result.workflowFile, 'utf8')).toContain('working-directory: apps/web');
	});

	test('next steps say where the environment lives', () => {
		const steps = nextSteps({ branch: 'main', facts: {} as ProjectFacts }, {}).join('\n');
		expect(steps).toContain('vela env import <file> -t production');
		expect(steps).toContain('not in GitHub secrets');
		expect(steps).toMatch(/build itself[\s\S]*`env`/);
		expect(steps).not.toContain('VELA_API_KEY');
		expect(
			nextSteps({ branch: 'main', facts: {} as ProjectFacts }, { previews: true }).join('\n')
		).toContain('vela link');
	});

	// The gap this closes: a linked app on a velastack.app hostname got a
	// workflow without the key and a checklist that said everything was done;
	// its first push deployed with no hostname and the site answered 404.
	describe('a project linked to velastack.dev', () => {
		function linkedProject() {
			deployedProject();
			const file = path.join(dir, '.vela', 'project.json');
			fs.writeFileSync(
				file,
				JSON.stringify({
					...JSON.parse(fs.readFileSync(file, 'utf8')),
					projectId: 'proj1',
					teamId: 'team1',
					projectName: 'Soty'
				})
			);
		}
		const yaml = () => fs.readFileSync(path.join(dir, WORKFLOW_PATH), 'utf8');

		test('--yes writes a workflow that passes the key, and issues and stores one', async () => {
			linkedProject();
			const { deps: d, calls } = deps({ loggedIn: true });
			const result = await enableCi(dir, { yes: true }, d);
			expect(yaml()).toMatch(/^\s+api-key: \$\{\{ secrets\.VELA_API_KEY \}\}$/m);
			expect(calls).toContain('mintApiKey CI - acme/soty');
			expect(calls).toContain('setSecretValue acme/soty VELA_API_KEY');
			expect(result.apiKey).toBe('stored');
			expect(apiKeyLines(result, {}).join('\n')).toMatch(/done/);
		});

		test('on a terminal the setup is offered, and a yes does both keys', async () => {
			linkedProject();
			const { deps: d, calls } = deps({
				interactive: true,
				loggedIn: true,
				askSetupKey: vi.fn(async () => true)
			});
			const result = await enableCi(dir, {}, d);
			expect(calls).toContain('confirm');
			expect(result.key).toMatchObject({ status: 'done', apiKey: true });
		});

		test('without a yes the workflow still passes the key, and the checklist says it is missing', async () => {
			linkedProject();
			const { deps: d, calls } = deps({ loggedIn: true, secretExists: async () => false });
			const result = await enableCi(dir, {}, d);
			expect(yaml()).toMatch(/^\s+api-key:/m);
			expect(calls).toEqual([]);
			expect(result.apiKey).toBe('missing');
			const line = apiKeyLines(result, {}).join('\n');
			expect(line).toMatch(/to do/);
			expect(line).toMatch(/velastack\.app hostname/);
			expect(line).toContain('vela enable ci --setup-key');
		});

		test('not logged in: no key is issued, and the checklist says so', async () => {
			linkedProject();
			const { deps: d, calls } = deps({ loggedIn: false, secretExists: async () => false });
			const result = await enableCi(dir, { yes: true }, d);
			expect(calls.some((call) => call.startsWith('mintApiKey'))).toBe(false);
			expect(result.key).toMatchObject({ status: 'done', apiKey: false });
			expect(result.apiKey).toBe('missing');
			expect(apiKeyLines(result, {}).join('\n')).toContain('vela login');
		});

		test('--api-key-secret: you bring the key, so none is issued, and a secret that is there counts', async () => {
			linkedProject();
			const { deps: d, calls } = deps({ loggedIn: true, secretExists: async () => true });
			const result = await enableCi(dir, { yes: true, apiKeySecret: true }, d);
			expect(yaml()).toMatch(/^\s+api-key:/m);
			expect(calls.some((call) => call.startsWith('mintApiKey'))).toBe(false);
			expect(result.apiKey).toBe('present');
		});

		test('--no-api-key leaves velastack.dev out of the workflow and issues nothing', async () => {
			linkedProject();
			const { deps: d, calls } = deps({ loggedIn: true });
			const result = await enableCi(dir, { yes: true, apiKey: false }, d);
			expect(yaml()).not.toMatch(/^\s+api-key:/m);
			expect(calls.some((call) => call.startsWith('mintApiKey'))).toBe(false);
			expect(result.apiKey).toBe('none');
			expect(apiKeyLines(result, {})).toEqual([]);
		});

		test('a secret that cannot be seen is reported as unchecked, not as done', async () => {
			linkedProject();
			const { deps: d } = deps({ loggedIn: true, secretExists: async () => null });
			const result = await enableCi(dir, {}, d);
			expect(result.apiKey).toBe('unknown');
			expect(apiKeyLines(result, {}).join('\n')).toMatch(/check/);
		});
	});

	test('--setup-key on a linked project whose workflow does not pass the key says so', async () => {
		deployedProject();
		const file = path.join(dir, '.vela', 'project.json');
		fs.writeFileSync(
			file,
			JSON.stringify({
				...JSON.parse(fs.readFileSync(file, 'utf8')),
				projectId: 'proj1',
				teamId: 'team1',
				projectName: 'Soty'
			})
		);
		// What 0.31 wrote for every project: the key commented out.
		await enableCi(dir, { apiKey: false }, deps().deps);
		const { deps: d } = deps({ loggedIn: true });
		const result = await enableCi(dir, { setupKey: true, yes: true }, d);
		expect(result.workflow).toBe('kept');
		expect(result.apiKey).toBe('stored');
		expect(result.workflowIgnoresApiKey).toBe(true);
	});

	test('a project that is not linked gets no key, in the workflow or anywhere else', async () => {
		deployedProject();
		const { deps: d, calls } = deps({ loggedIn: true });
		const result = await enableCi(dir, { yes: true }, d);
		expect(fs.readFileSync(path.join(dir, WORKFLOW_PATH), 'utf8')).toMatch(/^\s+# api-key:/m);
		expect(calls.some((call) => call.startsWith('mintApiKey'))).toBe(false);
		expect(result.apiKey).toBe('none');
	});
});

describe('the real effects that stay on this machine', () => {
	let home: string;
	beforeEach(() => {
		home = fs.mkdtempSync(path.join(os.tmpdir(), 'vela-ci-home-'));
	});
	afterEach(() => {
		fs.rmSync(home, { recursive: true, force: true });
	});

	/** The script the server runs, run here against a stand-in home directory. */
	const install = (key: string) =>
		execFileSync('bash', ['-s', '--', key], {
			input: `set -euo pipefail\n${INSTALL_KEY_SCRIPT}`,
			env: { PATH: process.env.PATH, HOME: home }
		})
			.toString()
			.trim();

	test('the install script appends once, on its own line, with tight permissions', () => {
		const file = path.join(home, '.ssh', 'authorized_keys');
		expect(install(PUBLIC_KEY)).toBe('ADDED');
		expect(fs.readFileSync(file, 'utf8')).toBe(`${PUBLIC_KEY}\n`);
		expect(fs.statSync(file).mode & 0o777).toBe(0o600);
		expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
		expect(install(PUBLIC_KEY)).toBe('PRESENT');
		expect(fs.readFileSync(file, 'utf8')).toBe(`${PUBLIC_KEY}\n`);
	});

	test('the install script keeps existing keys, even from a file with no final newline', () => {
		fs.mkdirSync(path.join(home, '.ssh'));
		const file = path.join(home, '.ssh', 'authorized_keys');
		fs.writeFileSync(file, 'ssh-ed25519 AAAAexisting me@laptop');
		expect(install(PUBLIC_KEY)).toBe('ADDED');
		expect(fs.readFileSync(file, 'utf8')).toBe(
			`ssh-ed25519 AAAAexisting me@laptop\n${PUBLIC_KEY}\n`
		);
	});

	test('a generated keypair is ed25519, carries the comment, and is gone after cleanup', async () => {
		const effects = realCiKeyEffects({}, { showPlan: () => {}, confirm: async () => true });
		const key = await effects.generateKey('vela-ci soty-690c70bd');
		expect(key.publicKey).toMatch(/^ssh-ed25519 \S+ vela-ci soty-690c70bd$/);
		expect(fs.statSync(key.privateKeyPath).mode & 0o777).toBe(0o600);
		effects.removeDir(key.dir);
		expect(fs.existsSync(key.dir)).toBe(false);
	});
});
