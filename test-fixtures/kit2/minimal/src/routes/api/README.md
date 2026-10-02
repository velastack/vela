# API Routes

If API is enabled in hooks.server.ts, the PocketBase API is exposed on the API URL:

```
export const handle = handlePocketbase({
	pocketbaseUrl: POCKETBASE_URL,
	superuserEmail: POCKETBASE_SUPERUSER_EMAIL,
	superuserPassword: POCKETBASE_SUPERUSER_PASSWORD,
	api: { enabled: true }
});
```

The following PocketBase routes are exposed:

    /api/batch
    /api/collections
    /api/realtime
    /api/files
    /api/settings
    /api/logs
    /api/crons
    /api/backups
    /api/health

Any other routes added to the `src/routes/api` directory are handled by SvelteKit as normal routes.
