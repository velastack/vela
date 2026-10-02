# Workflows

Background work that survives restarts. Each workflow runs on the OpenWorkflow engine built into PocketBase: every step's result is saved, a failed run retries with backoff, and an interrupted run resumes from its last completed step. Runs are listed under **Workflows** in the PocketBase dashboard.

Add one:

```sh
vela generate workflow send-welcome-email
```

That writes `send-welcome-email.ts` here, along with a test:

```ts
import { z } from 'zod';
import { ow } from '$lib/server/workflows';

export const sendWelcomeEmail = ow.defineWorkflow(
	{
		name: 'send-welcome-email',
		schema: z.object({ userId: z.string() }),
		retryPolicy: { maximumAttempts: 3 }
	},
	async ({ input, step }) => {
		await step.run({ name: 'send' }, async () => {
			// ...
		});
	}
);
```

Start a run from any server code, such as a form action, an API route or another workflow:

```ts
await sendWelcomeEmail.run({ userId: user.id }, { idempotencyKey: user.id });
```

`run()` returns as soon as the run is queued. The handle it returns has `result()` to wait for the output and `cancel()`. Pass `availableAt` to delay a run and `idempotencyKey` to make repeated calls reuse one run for 24 hours.

Recurring work is a workflow whose file also exports a cron expression:

```sh
vela generate workflow sync-prices --cron '*/5 * * * *'
```

Every workflow in that file starts on the schedule, once per minute across all servers.

Good to know:

- Steps are the unit of retry, so make each one safe to repeat.
- A workflow gets one attempt unless `retryPolicy` says otherwise.
- `getAdmin()` from `$lib/server/workflows` is a superuser client for use inside steps.
- The worker runs inside the web server. `WORKFLOWS_CONCURRENCY` (default 5) caps parallel runs and `WORKFLOWS_ENABLED=false` turns the worker off for a process that should only queue runs.
