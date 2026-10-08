import { beforeEach, afterEach, beforeAll } from 'vitest';
import supertest, { type Agent } from 'supertest';
import PocketBase from 'pocketbase-sveltekit';
import type { TestContext } from '@velastack/pocketbase/testing';

const admin = new PocketBase(process.env.POCKETBASE_URL!) as App.Locals['admin'];
const pb = new PocketBase(process.env.POCKETBASE_URL!) as App.Locals['pb'];

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
		.authWithPassword(
			process.env.POCKETBASE_SUPERUSER_EMAIL!,
			process.env.POCKETBASE_SUPERUSER_PASSWORD!
		);
});

beforeEach(async (context: TestContext) => {
	context.request = supertest(process.env.VITE_TEST_URL!);
	context.agent = supertest.agent(process.env.VITE_TEST_URL!) as TestContext['agent'];
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
