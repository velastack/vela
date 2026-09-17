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

export async function getRun(pb: PocketBase, id: string): Promise<WorkflowRun> {
	const res = await pb.send<{ run: WorkflowRun }>(`${PREFIX}/runs/${id}`, {
		method: 'GET',
		requestKey: null
	});
	return res.run;
}

export async function createRun(
	pb: PocketBase,
	workflowName: string,
	input: unknown
): Promise<WorkflowRun> {
	const res = await pb.send<{ run: WorkflowRun }>(`${PREFIX}/runs`, {
		method: 'POST',
		body: {
			workflowName,
			version: null,
			idempotencyKey: null,
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
	const res = await pb.send<{ run: WorkflowRun }>(`${PREFIX}/runs/${id}/cancel`, {
		method: 'POST',
		body: {},
		requestKey: null
	});
	return res.run;
}
