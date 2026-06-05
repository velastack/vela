import { describe, it, expect } from 'vitest';
import type { Match } from '@velastack/pocketbase';
import type { RouteId } from './$types';

describe('/', () => {
	it('should return a 200 status code', async (context) => {
		const response = await context.request.get('/' satisfies Match<RouteId>);
		expect(response.status).toBe(200);
	});
});
