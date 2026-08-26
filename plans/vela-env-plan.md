# `vela env` Implementation Plan

## Goal

Add a simple production environment-variable workflow for VelaStack VPS deployments.

The guiding model is:

- Local development secrets live in the project's `.env`.
- Production environment variables live on the provisioned VPS.
- Deployments never contain or implicitly synchronize secrets.
- `vela env` manages production environment variables over SSH.
- `vela provision` must have been run on the target VPS before `vela env` can be used.

The goal is to preserve the simplicity of `.env`-style configuration while keeping production configuration independent from release artifacts and out of Vela's hosted infrastructure.

---

## Canonical Server Layout

`vela provision` prepares a VPS to support Vela-managed applications.

Production environment variables for each project live at:

```text
/etc/vela/apps/<project-id>/env
```

Example:

```text
/etc/vela/apps/abc123/env
```

The file uses ordinary dotenv syntax:

```dotenv
DATABASE_URL=postgres://...
STRIPE_SECRET_KEY=sk_live_...
PUBLIC_SITE_URL=https://example.com
```

Permissions:

```text
owner: root
group: root
mode: 0600
```

Use the immutable Vela project ID in the path, not the project name.

The environment file must live outside release directories so deploys and rollbacks never modify it.

A typical application layout should look conceptually like:

```text
/etc/vela/apps/abc123/env

/var/lib/vela/apps/abc123/
├── releases/
│   ├── 20260826-153201/
│   ├── 20260826-161422/
│   └── 20260827-091100/
└── current -> releases/20260827-091100/
```

---

## systemd Integration

Each deployed application's systemd service should load its production environment from:

```ini
EnvironmentFile=/etc/vela/apps/<project-id>/env
```

The environment file is read by systemd before launching the application process.

The application should continue to run as its dedicated non-root Unix user.

The app user does not need permission to read `/etc/vela/apps/<project-id>/env` directly.

---

## Command Surface

Implement:

```bash
vela env set <KEY>
vela env unset <KEY>
vela env list
vela env import <FILE>
```

Potential future commands such as `vela env get` or `vela env export` are intentionally out of scope for the first version.

### `vela env set`

Usage:

```bash
vela env set STRIPE_SECRET_KEY
```

Behavior:

1. Resolve the current Vela project and configured deployment target.
2. Verify that the target server has already been provisioned by Vela.
3. Prompt for the value without echoing it to the terminal.
4. Connect to the VPS over SSH.
5. Create `/etc/vela/apps/<project-id>/` if it does not yet exist.
6. Read the existing env file if present.
7. Add or replace the requested key.
8. Write the complete updated file atomically.
9. Ensure `root:root` ownership and `0600` permissions.
10. Restart the application if it has already been deployed.
11. Report success without printing the secret value.

Example:

```text
$ vela env set STRIPE_SECRET_KEY
Value: ********

✓ STRIPE_SECRET_KEY updated
✓ App restarted
```

If the project has not yet been deployed, skip the restart:

```text
✓ STRIPE_SECRET_KEY updated
```

### `vela env unset`

Usage:

```bash
vela env unset STRIPE_SECRET_KEY
```

Behavior:

1. Verify provisioning.
2. Remove the key if present.
3. Atomically rewrite the env file.
4. Preserve ownership and permissions.
5. Restart the deployed app if one exists.

If the key does not exist, return a clear non-destructive message rather than failing unexpectedly.

Example:

```text
✓ STRIPE_SECRET_KEY removed
✓ App restarted
```

### `vela env list`

Usage:

```bash
vela env list
```

Behavior:

- List variable names only.
- Never print values.
- Sort keys alphabetically for predictable output.

Example:

```text
Production environment

DATABASE_URL
PUBLIC_SITE_URL
STRIPE_SECRET_KEY
```

If no production environment has been configured:

```text
No production environment variables configured.
```

### `vela env import`

Usage:

```bash
vela env import .env.production
```

Behavior:

1. Parse the supplied dotenv file locally.
2. Verify provisioning.
3. Upload/update the variables explicitly.
4. Merge imported values into the existing production environment.
5. Do not delete existing server variables that are absent from the imported file.
6. Atomically write the result.
7. Restart the deployed app once after the complete import.

Example:

```text
Importing 4 variables from .env.production

✓ 4 variables updated
✓ App restarted
```

Do not make `.env` a default implicit source. The user must provide the file path explicitly.

---

## Provisioning Dependency

`vela env` only works against a Vela-provisioned server.

`vela provision` is server-level and normally runs once per VPS.

`vela env` is project-level and may be used for many projects on the same VPS.

Conceptually:

```text
VPS
├── provisioned once
│
├── /etc/vela/apps/abc123/env
├── /etc/vela/apps/def456/env
└── /etc/vela/apps/ghi789/env
```

`vela provision` does not need to create environment directories for individual projects.

The first `vela env set`, `vela env import`, or `vela deploy` for a project may create:

```text
/etc/vela/apps/<project-id>/
```

as needed.

### Detecting Provisioning

Use the existing Vela provisioning marker or server metadata if one already exists.

If no reliable marker currently exists, add one during `vela provision`, for example:

```text
/etc/vela/provisioned
```

Do not infer successful provisioning merely from the presence of `/etc/vela`.

If `vela env` is run against an unprovisioned server:

```text
This server hasn't been provisioned for Vela yet.

Run:
  vela provision
```

Exit non-zero.

---

## Deployment Behavior

`vela deploy` must never implicitly upload, replace, merge, or otherwise synchronize the local `.env` file.

This is an invariant.

Local `.env` may contain:

- development credentials
- localhost URLs
- test Stripe keys
- local database configuration
- values inappropriate for production

A normal deploy should only:

1. Build the application.
2. Transfer the release artifact.
3. Activate the release.
4. Restart the application.

The process receives its production environment from:

```text
/etc/vela/apps/<project-id>/env
```

Deploying or rolling back a release must not modify this file.

---

## First-Deploy UX

The standard Vela VPS workflow should remain:

```bash
vela provision
vela deploy
```

Users should not be required to manually run `vela env` before the first deploy if Vela can determine which runtime variables are required.

If the application declares required runtime variables and any are missing on the server, interactive `vela deploy` should offer to configure them.

Example:

```text
$ vela deploy

Production environment has not been fully configured.

Missing:
  DATABASE_URL
  STRIPE_SECRET_KEY

Configure them now? Y

DATABASE_URL: ********
STRIPE_SECRET_KEY: ********

✓ Environment configured
✓ Deployed
```

Internally, this should reuse the same environment-management implementation as `vela env`, not duplicate it.

In non-interactive/CI mode, do not prompt. Fail with a clear list of missing required variables and instructions for configuring them.

If required-variable discovery is not yet implemented elsewhere in VelaStack, the first implementation of `vela env` does not need to block on it. The explicit `vela env` commands should ship independently.

---

## SvelteKit Integration

Prefer SvelteKit's current explicit environment-variable model for new VelaStack applications.

Private production values should be runtime variables rather than build-time secrets wherever possible.

This gives Vela the desired architecture:

```text
source code
    ↓
declares required configuration

build artifact
    ↓
contains no production secrets

VPS environment
    ↓
provides private values at runtime
```

The build system should not require production secrets unless a specific dependency genuinely requires a build-time value.

This is especially important for builds triggered remotely by GitHub or Vela-hosted build infrastructure: production secrets should remain on the user's VPS whenever possible.

---

## No Vela Cloud Secret Store

Do not add a Vela-hosted secret store for this feature.

Production credentials should not flow through or be persisted by velastack.dev.

The intended architecture is:

```text
Development
project/.env
     │
     │ explicit `vela env set/import`
     ▼
VPS
/etc/vela/apps/<project-id>/env
```

Not:

```text
project/.env
    ↓
velastack.dev secret database
    ↓
deployment system
    ↓
VPS
```

`vela env` should send values directly to the configured VPS over SSH.

Do not store a plaintext copy locally under `.vela/`.

Local Vela metadata may identify the project and deployment target, but must not contain production secret values.

---

## SSH and Privilege Handling

Reuse the same SSH connection/configuration used by `vela provision` and `vela deploy`.

Because the environment file is owned by root, modifying it will require the same privilege escalation mechanism already used by provisioning.

Do not loosen file permissions to avoid `sudo`.

When possible:

- send the updated contents over stdin rather than embedding secret values in shell command arguments
- avoid putting secret values in shell history
- avoid writing temporary plaintext files locally
- avoid logging secret values
- avoid including secret values in thrown errors or debug output

Remote writes should use a temporary root-owned file followed by an atomic rename.

Conceptually:

```text
/etc/vela/apps/<id>/.env.tmp-<random>
        ↓
chmod 0600
chown root:root
        ↓
rename()
        ↓
/etc/vela/apps/<id>/env
```

Never rewrite the live file incrementally.

---

## Dotenv Parsing and Serialization

Use an existing well-maintained dotenv parser rather than implementing parsing manually.

Requirements:

- support ordinary `KEY=value` syntax
- preserve values containing spaces
- support quoted values
- support empty values
- support `=` characters inside values
- reject malformed variable names
- handle newlines safely
- normalize output into a consistent deterministic format

When rewriting the production file, preserving comments and original formatting is not required.

A canonical serialization is preferable because the env file is Vela-managed.

Example:

```dotenv
DATABASE_URL="postgres://..."
PUBLIC_SITE_URL="https://example.com"
STRIPE_SECRET_KEY="sk_live_..."
```

Choose one safe serialization strategy and use it consistently.

Keys should be sorted alphabetically when writing so diffs and manual inspection are predictable.

---

## Safety Rules

The CLI must never:

- print secret values during `list`
- log secret values
- include secret values in telemetry
- include secret values in command-line arguments sent to the remote shell
- implicitly upload `.env`
- put secrets inside release artifacts
- persist production secrets on velastack.dev
- persist a plaintext production-secret cache under `.vela/`
- change the production environment during `vela deploy`
- change the production environment during `vela rollback`

If verbose/debug logging exists, redact values there as well.

---

## Restart Semantics

Environment changes only take effect for a Node process after restart.

Therefore:

- `set` restarts the app if deployed
- `unset` restarts the app if deployed
- `import` restarts the app once after all changes
- `list` never restarts anything

Use the existing Vela systemd service naming/resolution logic.

If writing the environment succeeds but restarting the service fails, report the two states separately:

```text
✓ STRIPE_SECRET_KEY updated
✗ App restart failed

The new value is stored and will be used the next time the app starts.
```

Do not roll back the environment change merely because the application failed to restart.

---

## Expected Project Resolution

`vela env` should operate on the current Vela project using the same project-resolution logic as `vela deploy`.

It should know:

- Vela project ID
- deployment host
- SSH user/configuration
- systemd service identity

Do not require users to repeat the host or project ID for every environment command if those are already represented in Vela project/deployment metadata.

---

## Suggested Internal Structure

Keep the environment implementation reusable so `vela deploy` can call it later.

For example:

```text
commands/
  env/
    set
    unset
    list
    import

services/
  remote-env
    read
    write
    set
    unset
    import
    list
```

The exact module structure should match the existing CLI codebase.

The important constraint is that command handlers should not each implement their own SSH/env-file manipulation.

Centralize:

- provisioned-server verification
- remote path resolution
- env parsing
- env serialization
- atomic writes
- permissions
- app restart behavior
- redaction

---

## Testing

Add tests for at least the following.

### Parsing / serialization

- simple values
- quoted values
- values containing spaces
- values containing `=`
- empty values
- invalid keys
- deterministic key ordering

### `set`

- creates a missing env file
- adds a new key
- replaces an existing key
- leaves other keys untouched
- never prints the value
- writes `0600`
- uses `root:root`
- restarts deployed app

### `unset`

- removes an existing key
- preserves other keys
- handles absent key cleanly
- restarts deployed app

### `list`

- lists names only
- never exposes values
- sorts alphabetically
- handles missing/empty file

### `import`

- imports multiple values
- merges with existing values
- replaces matching keys
- preserves server-only keys not present in import
- restarts only once

### Provisioning

- refuses to run against an unprovisioned server
- succeeds against a provisioned server
- creates the project env directory lazily

### Deployment invariants

- `vela deploy` does not read or upload local `.env`
- deployment does not overwrite the remote env file
- rollback does not overwrite the remote env file

---

## Acceptance Criteria

The feature is complete when this workflow works:

```bash
vela provision

vela env set DATABASE_URL
vela env set STRIPE_SECRET_KEY

vela env list

vela deploy
```

And the server contains:

```text
/etc/vela/apps/<project-id>/env
```

with:

```text
root:root
0600
```

The deployed systemd service loads that file and the running SvelteKit application receives the variables at runtime.

A subsequent:

```bash
vela deploy
```

must leave the environment file unchanged.

A subsequent:

```bash
vela rollback
```

must also leave the environment file unchanged.

The implementation should feel like remote `.env` management, not like a separate secrets platform.
