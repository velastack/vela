import { ClientResponseError } from 'pocketbase';
import type PocketBase from 'pocketbase';

/**
 * The OpenWorkflow engine's HTTP API in PocketBase, as far as the CLI needs
 * it. Superuser-only, one namespace: the dashboard's Workflows tab reads the
 * same one, so what the CLI shows and what the tab shows line up.
 */
const NAMESPACE = 'default';
const PREFIX = `/api/ow/v1/${NAMESPACE}`;

export type RunStatus = 'pending' | 'running' | 'completed' | 'failed' | 'canceled';

export interface WorkflowRun {
	id: string;
	workflowName: string;
	version: string | null;
	status: RunStatus;
	attempts: number;
	input: unknown;
	output: unknown;
	/** Set on a failed run, and on a pending one whose last attempt failed and is being retried. */
	error: { message?: string } | null;
	createdAt: string;
	updatedAt: string;
	availableAt: string;
	finishedAt: string | null;
}

export interface ListRunsOptions {
	status?: RunStatus;
	workflowName?: string;
	limit?: number;
}

export async function listRuns(
	pb: PocketBase,
	options: ListRunsOptions = {}
): Promise<WorkflowRun[]> {
	const query: Record<string, string | number> = { limit: options.limit ?? 50 };
	if (options.status) query.status = options.status;
	if (options.workflowName) query.workflowName = options.workflowName;
	const res = await pb.send<{ data: WorkflowRun[] }>(`${PREFIX}/runs`, {
		method: 'GET',
		query,
		requestKey: null
	});
	return res.data;
}

/** Whether a failed request was answered with this HTTP status. */
export function isHttpStatus(error: unknown, status: number): boolean {
	return error instanceof ClientResponseError && error.status === status;
}

/** One run, or null when this database has none by that id. */
export async function getRun(pb: PocketBase, id: string): Promise<WorkflowRun | null> {
	try {
		const res = await pb.send<{ run: WorkflowRun | null }>(
			`${PREFIX}/runs/${encodeURIComponent(id)}`,
			{ method: 'GET', requestKey: null }
		);
		return res.run ?? null;
	} catch (e) {
		if (isHttpStatus(e, 404)) return null;
		throw e;
	}
}

const FINISHED: string[] = ['completed', 'failed', 'canceled'];

/** Whether a run has reached a state it will not leave. */
export function isFinished(run: WorkflowRun): boolean {
	return FINISHED.includes(run.status);
}

export interface SettleOptions {
	timeoutMs?: number;
	intervalMs?: number;
	sleep?: (ms: number) => Promise<void>;
}

/**
 * Watch a run just queued until it says something worth reporting, or time is up.
 *
 * "Queued" is true of a run nothing will ever execute: one for a workflow the
 * running app does not define, or on a target whose app is down. So the run is
 * followed briefly — to the end if it is quick, and otherwise to the first
 * failed attempt, which is where a worker reports a name it does not know.
 * Returns the run as last seen, whatever state that is.
 */
export async function settleRun(
	pb: PocketBase,
	run: WorkflowRun,
	options: SettleOptions = {}
): Promise<WorkflowRun> {
	const timeoutMs = options.timeoutMs ?? 8000;
	const intervalMs = options.intervalMs ?? 500;
	const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

	let latest = run;
	for (let waited = 0; ; waited += intervalMs) {
		if (isFinished(latest)) return latest;
		if (latest.status === 'pending' && latest.error) return latest;
		if (waited >= timeoutMs) return latest;
		await sleep(intervalMs);
		latest = (await getRun(pb, run.id)) ?? latest;
	}
}

export interface CreateRunOptions {
	/** A second run of the same workflow with the same key returns the first. */
	idempotencyKey?: string;
}

export async function createRun(
	pb: PocketBase,
	workflowName: string,
	input: unknown,
	options: CreateRunOptions = {}
): Promise<WorkflowRun> {
	const res = await pb.send<{ run: WorkflowRun }>(`${PREFIX}/runs`, {
		method: 'POST',
		body: {
			workflowName,
			version: null,
			idempotencyKey: options.idempotencyKey ?? null,
			config: {},
			context: {},
			input: input ?? null,
			parentStepAttemptNamespaceId: null,
			parentStepAttemptId: null,
			availableAt: null,
			deadlineAt: null
		},
		requestKey: null
	});
	return res.run;
}

export async function cancelRun(pb: PocketBase, id: string): Promise<WorkflowRun> {
	const res = await pb.send<{ run: WorkflowRun }>(
		`${PREFIX}/runs/${encodeURIComponent(id)}/cancel`,
		{
			method: 'POST',
			body: {},
			requestKey: null
		}
	);
	return res.run;
}
