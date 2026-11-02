import { beforeEach, afterEach, beforeAll, inject } from 'vitest';
import supertest, { type Agent } from 'supertest';
import PocketBase from 'pocketbase-sveltekit';
import type { TestContext } from '@velastack/pocketbase/testing';
import type {} from 'vela/testing';

// The servers `vela/testing` started: a throwaway PocketBase and the app.
const servers = inject('vela');
if (!servers) {
	throw new Error(
		'Server tests need the servers `vela/testing` starts. Add `globalSetup: [\'vela/testing\']` to the test config in vitest.config.ts.'
	);
}

const admin = new PocketBase(servers.pocketbaseUrl) as App.Locals['admin'];
const pb = new PocketBase(servers.pocketbaseUrl) as App.Locals['pb'];

const testUserPassword = 'password';

async function authenticateUser(agent: Agent, user: { email?: string }) {
	// Logs in with the password, so it needs the email (made optional by
	// enable-whatsapp, for accounts that sign in with a phone number).
	if (!user.email) {
		throw new Error('authenticateUser needs a user with an email');
	}
	await agent.post('/login').type('form').send({
		type: 'password',
		email: user.email,
		password: testUserPassword
	});
}

beforeAll(async () => {
	await admin
		// @ts-ignore
		.collection('_superusers')
		.authWithPassword(servers.superuser.email, servers.superuser.password);
});

beforeEach(async (context: TestContext) => {
	context.request = supertest(servers.appUrl);
	context.agent = supertest.agent(servers.appUrl) as TestContext['agent'];
	context.admin = admin;
	context.pb = pb;
	const email = `test-${Math.random().toString(36).slice(2)}@example.com`;
	context.user = await context.admin.collection('users').create({
		email,
		password: testUserPassword,
		passwordConfirm: testUserPassword
	});
	context.agent.authenticateUser = () => authenticateUser(context.agent, context.user);
	await context.pb.collection('users').authWithPassword(email, testUserPassword);
});

afterEach(async (context: TestContext) => {
	await context.pb.authStore.clear();
	await context.admin.collection('users').delete(context.user.id);
});
