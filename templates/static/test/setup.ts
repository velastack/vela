import { beforeEach } from 'vitest';
import supertest from 'supertest';

beforeEach(async (context: any) => {
	context.request = supertest(process.env.VITE_TEST_URL!);
	context.agent = supertest.agent(process.env.VITE_TEST_URL!);
});
