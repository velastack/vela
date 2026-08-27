import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { readBinding, readBindings, writeBinding } from './deploy-config.ts';

let root: string;

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), 'vela-bindings-'));
});

afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

function writeProject(contents: object): void {
	fs.mkdirSync(path.join(root, '.vela'), { recursive: true });
	fs.writeFileSync(path.join(root, '.vela', 'project.json'), JSON.stringify(contents, null, 2));
}

describe('readBinding', () => {
	test('reads a bound target', () => {
		writeProject({
			appId: 'velabase-e7a7079c',
			targets: { prod: { server: 'root@1.2.3.4', domain: 'velabase.dev' } }
		});

		expect(readBinding(root, 'prod')).toEqual({ server: 'root@1.2.3.4', domain: 'velabase.dev' });
		expect(readBinding(root, 'staging')).toBeNull();
	});

	test('reads a project written before targets were named', () => {
		// The live shape in velastack/.vela/project.json. Renaming its env tag
		// would orphan the systemd units, database and uploads on the server, so
		// the old key is read rather than migrated.
		writeProject({
			projectId: 'zdyly4bg3wuwr5x',
			appId: 'zdyly4bg3wuwr5x',
			deployments: { staging: { target: 'root@146.190.139.138' } }
		});

		expect(readBinding(root, 'staging')).toEqual({
			server: 'root@146.190.139.138',
			domain: undefined
		});
	});

	test('prefers the new shape when a project has both', () => {
		writeProject({
			targets: { prod: { server: 'root@new' } },
			deployments: { prod: { target: 'root@old' } }
		});

		expect(readBinding(root, 'prod')?.server).toBe('root@new');
	});

	test('is null for a project with no file at all', () => {
		expect(readBinding(root, 'prod')).toBeNull();
	});
});

describe('readBindings', () => {
	test('merges both shapes, newest winning', () => {
		writeProject({
			targets: { prod: { server: 'root@new' } },
			deployments: { prod: { target: 'root@old' }, staging: { target: 'root@staging' } }
		});

		expect(readBindings(root)).toEqual({
			prod: { server: 'root@new' },
			staging: { server: 'root@staging', domain: undefined }
		});
	});
});

describe('writeBinding', () => {
	test('adds a target without disturbing the rest of the file', () => {
		writeProject({ appId: 'abc', projectName: 'velabase', teamId: 'team1' });
		writeBinding(root, 'staging', { server: 'root@1.2.3.4', domain: 'staging.velabase.dev' });

		const written = JSON.parse(fs.readFileSync(path.join(root, '.vela', 'project.json'), 'utf8'));
		expect(written).toMatchObject({
			appId: 'abc',
			projectName: 'velabase',
			teamId: 'team1',
			targets: { staging: { server: 'root@1.2.3.4', domain: 'staging.velabase.dev' } }
		});
	});

	test('leaves an older deployments key in place', () => {
		writeProject({ appId: 'abc', deployments: { staging: { target: 'root@old' } } });
		writeBinding(root, 'prod', { server: 'root@new' });

		const written = JSON.parse(fs.readFileSync(path.join(root, '.vela', 'project.json'), 'utf8'));
		expect(written.deployments).toEqual({ staging: { target: 'root@old' } });
		expect(written.targets).toEqual({ prod: { server: 'root@new' } });
	});
});
