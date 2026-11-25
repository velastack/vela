import { describe, expect, test, vi } from 'vitest';
import type PocketBase from 'pocketbase';
import { ClientResponseError } from 'pocketbase';
import { createRun, getRun, settleRun, type WorkflowRun } from './workflows-api.ts';

function run(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
	return {
		id: 'run1',
		workflowName: 'send-digest',
		version: null,
		status: 'pending',
		attempts: 0,
		input: null,
		output: null,
		error: null,
		createdAt: '2026-11-24T10:00:00.000Z',
		updatedAt: '2026-11-24T10:00:00.000Z',
		availableAt: '2026-11-24T10:00:00.000Z',
		finishedAt: null,
		...overrides
	};
}

/** A client whose run lookups answer with each state in turn, then repeat the last. */
function client(...states: Array<WorkflowRun | Error>) {
	let i = 0;
	const send = vi.fn(async () => {
		const state = states[Math.min(i++, states.length - 1)]!;
		if (state instanceof Error) throw state;
		return { run: state };
	});
	return { pb: { send } as unknown as PocketBase, send };
}

const sleep = () => Promise.resolve();

describe('settleRun', () => {
	test('follows a quick run to its end', async () => {
		const { pb } = client(run({ status: 'running' }), run({ status: 'completed' }));
		const settled = await settleRun(pb, run(), { sleep });
		expect(settled.status).toBe('completed');
	});

	test('stops at a failed first attempt that is waiting to be retried', async () => {
		const error = { message: 'Workflow "send-digets" is not registered' };
		const { pb, send } = client(run({ error }));
		const settled = await settleRun(pb, run(), { sleep });
		expect(settled.status).toBe('pending');
		expect(settled.error).toEqual(error);
		expect(send).toHaveBeenCalledTimes(1);
	});

	test('gives up on a run nothing claims, and hands it back still pending', async () => {
		const { pb, send } = client(run());
		const settled = await settleRun(pb, run(), { sleep, timeoutMs: 2000, intervalMs: 500 });
		expect(settled.status).toBe('pending');
		expect(send).toHaveBeenCalledTimes(4);
	});

	test('does not ask again about a run that was already finished', async () => {
		const { pb, send } = client(run());
		const settled = await settleRun(pb, run({ status: 'completed' }), { sleep });
		expect(settled.status).toBe('completed');
		expect(send).not.toHaveBeenCalled();
	});
});

describe('getRun', () => {
	test('is null for an id this database does not have', async () => {
		const { pb } = client(new ClientResponseError({ status: 404 }));
		expect(await getRun(pb, 'nope')).toBeNull();
	});

	test('passes any other failure on', async () => {
		const { pb } = client(new ClientResponseError({ status: 500 }));
		await expect(getRun(pb, 'run1')).rejects.toBeInstanceOf(ClientResponseError);
	});
});

describe('createRun', () => {
	test('sends the idempotency key when one is given, and null otherwise', async () => {
		const { pb, send } = client(run());
		await createRun(pb, 'send-digest', { a: 1 }, { idempotencyKey: 'k1' });
		await createRun(pb, 'send-digest', undefined);
		const bodies = send.mock.calls.map(
			(call) => (call as unknown as [string, { body: Record<string, unknown> }])[1].body
		);
		expect(bodies[0]).toMatchObject({ idempotencyKey: 'k1', input: { a: 1 } });
		expect(bodies[1]).toMatchObject({ idempotencyKey: null, input: null });
	});
});
