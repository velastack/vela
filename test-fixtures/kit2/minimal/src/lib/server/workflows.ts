import process from 'node:process';
import { building } from '$app/environment';
import { env } from '$env/dynamic/private';
import { Cron } from 'croner';
import { OpenWorkflow, type Worker } from 'openworkflow';
import { BackendPocketBase } from 'openworkflow-pocketbase';
import PocketBase from 'pocketbase-sveltekit';

/**
 * Background workflows on the OpenWorkflow engine built into PocketBase.
 *
 * Define one in src/lib/workflows/<name>.ts with `ow.defineWorkflow(...)` and
 * start a run from any server code with `.run(input)`. The worker that `init`
 * in src/hooks.server.ts starts claims runs from PocketBase and executes them
 * in this process; every step's result is saved, so an interrupted run resumes
 * from the last completed step. See src/lib/workflows/README.md.
 */

const url = env.POCKETBASE_URL ?? '';
const email = env.POCKETBASE_SUPERUSER_EMAIL ?? '';
const password = env.POCKETBASE_SUPERUSER_PASSWORD ?? '';

/** The OpenWorkflow client: `defineWorkflow`, `runWorkflow`, `cancelWorkflowRun`, `sendSignal`. */
export const ow = new OpenWorkflow({
	// Authenticates lazily and again after a 401, so constructing it costs nothing.
	backend: new BackendPocketBase({ url, email, password })
});

const admin = new PocketBase(url);
admin.autoCancellation(false);

/** A superuser client for workflow steps. Signs in on first use and again once the token expires. */
export async function getAdmin(): Promise<App.Locals['admin']> {
	if (!admin.authStore.isValid) {
		await admin.collection('_superusers').authWithPassword(email, password);
	}
	return admin as App.Locals['admin'];
}

/**
 * Every workflow module, loaded on demand rather than eagerly: an eager glob is
 * hoisted above `ow`, and each module imports `ow` from this file.
 */
const modules = import.meta.glob(['../workflows/*.ts', '!../workflows/*.test.ts']);

interface Runnable {
	run(input?: undefined, options?: { idempotencyKey?: string }): Promise<unknown>;
	workflow: { spec: { name: string } };
}

function isRunnable(value: unknown): value is Runnable {
	const candidate = value as Partial<Runnable> | null;
	return (
		typeof candidate === 'object' &&
		candidate !== null &&
		typeof candidate.run === 'function' &&
		typeof candidate.workflow?.spec?.name === 'string'
	);
}

interface WorkflowModule {
	file: string;
	workflows: Runnable[];
	/** A cron expression: every workflow in the module runs on that schedule. */
	cron?: string;
}

async function loadModules(): Promise<WorkflowModule[]> {
	return Promise.all(
		Object.entries(modules).map(async ([file, load]) => {
			const mod = (await load()) as Record<string, unknown>;
			return {
				file,
				workflows: Object.values(mod).filter(isRunnable),
				cron: typeof mod.cron === 'string' ? mod.cron : undefined
			};
		})
	);
}

/**
 * One run per workflow per minute, however many servers are running: the
 * idempotency key makes PocketBase return the existing run to the others.
 */
async function runRecurring(workflows: Runnable[], now: Date) {
	const minute = new Date(Math.floor(now.getTime() / 60_000) * 60_000).toISOString();
	for (const workflow of workflows) {
		const name = workflow.workflow.spec.name;
		try {
			await workflow.run(undefined, { idempotencyKey: `cron:${name}:${minute}` });
		} catch (error) {
			console.error(`[workflows] could not start ${name}:`, error);
		}
	}
}

/** Starts every recurring workflow now, as if each schedule had just fired. For tests. */
export async function tickCron(now = new Date()) {
	for (const mod of await loadModules()) {
		if (mod.cron) await runRecurring(mod.workflows, now);
	}
}

interface Running {
	worker: Worker;
	stop: () => Promise<void>;
}

// Keyed on globalThis: in development Vite re-evaluates this module when a
// workflow file changes, and the previous worker must stop polling.
const KEY = Symbol.for('velastack.workflows');
const state = globalThis as { [KEY]?: Running };

/**
 * Starts the worker for this process. Returns without doing anything when
 * there are no workflow modules, during `vela build`, or when
 * WORKFLOWS_ENABLED=false, so a project that has no workflows never polls.
 */
export async function startWorker() {
	if (building || process.env.VITE_BUILD === 'true') return;
	if (env.WORKFLOWS_ENABLED === 'false' || !url) return;
	if (Object.keys(modules).length === 0) return;

	const loaded = await loadModules();
	const names = loaded.flatMap((mod) => mod.workflows.map((w) => w.workflow.spec.name));
	if (names.length === 0) return;

	// Not awaited: runs in flight finish on the old code, new claims stop now.
	void state[KEY]?.stop();

	const worker = ow.newWorker({ concurrency: Number(env.WORKFLOWS_CONCURRENCY ?? 5) });
	const crons =
		env.TEST === 'true'
			? []
			: loaded
					.filter((mod) => mod.cron)
					.map(
						(mod) =>
							new Cron(mod.cron!, { name: mod.file, protect: true, unref: true }, (job: Cron) =>
								runRecurring(mod.workflows, job.currentRun() ?? new Date())
							)
					);

	let stopped = false;
	const stop = async () => {
		if (stopped) return;
		stopped = true;
		process.off('sveltekit:shutdown', onShutdown);
		process.off('SIGINT', onShutdown);
		process.off('SIGTERM', onShutdown);
		for (const cron of crons) cron.stop();
		await worker.stop();
		console.log('[workflows] worker stopped');
	};
	const onShutdown = () => void stop();

	// adapter-node emits sveltekit:shutdown only once HTTP has drained; the
	// signals come first, so the worker drains alongside the requests.
	process.once('sveltekit:shutdown', onShutdown);
	process.once('SIGINT', onShutdown);
	process.once('SIGTERM', onShutdown);

	state[KEY] = { worker, stop };
	await worker.start();
	console.log(`[workflows] worker started: ${names.join(', ')}`);
}

/** Stops the worker started in this process, waiting for runs in flight. */
export async function stopWorker() {
	await state[KEY]?.stop();
	delete state[KEY];
}
