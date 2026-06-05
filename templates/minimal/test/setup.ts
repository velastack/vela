import { beforeEach, afterEach, beforeAll } from 'vitest';
import supertest, { type Agent } from 'supertest';
import PocketBase from 'pocketbase-sveltekit';
import type { TestContext } from '@velastack/pocketbase';

const admin = new PocketBase(process.env.POCKETBASE_URL!) as App.Locals['admin'];
const pb = new PocketBase(process.env.POCKETBASE_URL!) as App.Locals['pb'];

const testUserPassword = 'password';

async function authenticateUser(agent: Agent, user: { email: string }) {
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
	context.user = await context.admin.collection('users').create({
		email: `test-${Math.random().toString(36).slice(2)}@example.com`,
		password: testUserPassword,
		passwordConfirm: testUserPassword
	});
	context.agent.authenticateUser = () => authenticateUser(context.agent, context.user);
	await context.pb.collection('users').authWithPassword(context.user.email, testUserPassword);
});

afterEach(async (context: TestContext) => {
	await context.pb.authStore.clear();
	await context.admin.collection('users').delete(context.user.id);
});
