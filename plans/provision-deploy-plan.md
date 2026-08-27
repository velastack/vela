> **Historical.** Written before the `-t/--target` selector landed. The command
> examples below use the old `<ssh-target>` positional and `--env <tag>`, which no
> longer exist: read them for the design intent, not the syntax.

# Provision & Deploy — Implementation Plan

Companion to `plans/provision-deploy.md` (the product spec). This document is about **how** we build it in the Node CLI, not what it does.

---

## 1. Guiding principles

- **OpenSSH, not a Node SSH library.** Shell out to `ssh`, `scp`, `rsync` via `tinyexec`. This honors the user's `~/.ssh/config`, `ProxyJump`, agent forwarding, hardware keys, and OpenSSH's `ControlMaster` — matching the spec's "delegate connection setup to SSH itself."
- **Server state is just files.** JSON state files + systemd templates + Caddy snippets. No agent, no daemon. `ssh` + `cat`/`install`/`mv` is enough.
- **The CLI is a thin orchestrator.** All non-trivial server work runs via small idempotent bash helpers we upload during `provision`. Keeps the Node layer focused on build, SSH, and config.
- **Lazy instance creation.** `provision` only prepares the box. Instance dirs, ports, env files, services, and Caddy blocks are materialized on first `deploy`.
- **Every command is idempotent.** Re-running `provision` or `deploy` on the same state should be a no-op or a minimal diff, never a clobber.

---

## 2. New code layout

```
src/
  commands/
    provision.ts         # replaces stub
    deploy.ts            # replaces stub
    rollback.ts          # new
    status.ts            # new
    destroy.ts           # extend existing (add `destroy --env` instance removal)
    releases.ts          # new (list releases for an instance)
    logs.ts              # new (tail journald for an instance)
  lib/
    ssh.ts               # ssh/rsync/scp wrappers w/ ControlMaster
    vela-config.ts       # load velastack.config.{ts,js} via defineConfig
    remote-state.ts      # read/write JSON state files on the server
    instance.ts          # instance id normalization (preview/<br> → myapp--preview--<br>)
    ports.ts             # port allocator (reads state; picks free pair)
    artifact.ts          # build + tarball pipeline
    caddy.ts             # render host blocks from state
    systemd.ts           # helpers for `systemctl start/stop/status` on templated units
    provision-steps.ts   # ordered, idempotent server setup steps
templates/
  server/
    scripts/
      vela-apply.sh        # apply an instance: write env, link release, reload services
      vela-rollback.sh     # swap current -> previous for an instance
      vela-destroy.sh      # stop services, tear down instance, free ports
      vela-status.sh       # print JSON status for one or all instances
      vela-allocate-port.sh  # atomic port allocation under /var/www/velastack/state/
    systemd/
      velastack-web@.service
      velastack-pb@.service
    caddy/
      Caddyfile.base       # includes /etc/velastack/caddy/*.caddy snippets
```

The `templates/server/` tree is shipped in the npm package (already covered by `"files": ["dist", "templates"]` in `package.json`) and uploaded verbatim during `provision`.

---

## 3. Local project config

Add `velastack.config.ts` support at the workspace root. Use a small helper in `lib/vela-config.ts`:

```ts
export interface VelaConfig {
	project: string;
	deploy?: {
		healthCheckPath?: string; // default '/health'
		buildCommand?: string; // default inferred from package.json scripts
		artifactStrategy?: 'tarball'; // only tarball for v1
		includes?: string[]; // extra dirs (default: SvelteKit build output)
		previews?: {
			enabled?: boolean;
			provider?: 'velastack';
			subdomain?: string; // e.g. 'user-project.velastack.app'
		};
	};
}

export function defineConfig(c: VelaConfig): VelaConfig {
	return c;
}
export async function loadVelaConfig(cwd: string): Promise<VelaConfig> {
	/* ... */
}
```

- Resolve upward from `cwd` (same pattern as `getWorkspace`) looking for `velastack.config.ts|js|mjs`.
- Load `.ts` via dynamic `import()` — we already run on `--experimental-strip-types`.
- Validate with `valibot` (already a dep) so errors are clean.
- `--project` CLI flag always overrides `config.project`.

---

## 4. SSH transport (`lib/ssh.ts`)

A tiny wrapper, not a framework:

```ts
export interface SshTarget {
	alias: string;
	controlPath?: string;
}

export async function exec(t: SshTarget, cmd: string, opts?: ExecOpts): Promise<ExecResult>;
export async function execStream(t: SshTarget, cmd: string): Promise<ChildProcess>;
export async function upload(t: SshTarget, local: string, remote: string): Promise<void>; // rsync -az
export async function download(t: SshTarget, remote: string, local: string): Promise<void>;
export async function writeFile(
	t: SshTarget,
	remote: string,
	content: string,
	mode?: string
): Promise<void>;
export async function readFile(t: SshTarget, remote: string): Promise<string>;
export async function withSession<T>(alias: string, fn: (t: SshTarget) => Promise<T>): Promise<T>;
```

Key details:

- `withSession` opens an `ssh -M -S <socket>` ControlMaster to a temp path under `~/.vela/run/`, then closes it with `-O exit`. All sub-calls reuse it via `-S <socket>`. Gives us ~1 TCP handshake per command.
- `writeFile` is `ssh target "install -m MODE /dev/stdin REMOTE" < content` — atomic and safe with special chars.
- `upload` is `rsync -az --delete-after` (with `-e "ssh -S <socket>"`).
- Every remote `sudo` call uses `sudo -n` and we surface a clear error if the user doesn't have passwordless sudo. (See §9.)
- No `shell: true` concatenation anywhere — arguments go through a quoting helper.

---

## 5. Server layout and state files

Matches spec §9 and §12. Under `/var/www/velastack/`:

```
projects/<project>/
  instances/<instanceId>/
    releases/<timestamp>/       # unpacked tarballs
    shared/
      .env                       # instance env (not in git)
      pb_data/                   # PocketBase data (preview: isolated)
      uploads/
    current -> releases/<timestamp>
    logs/
state/
  ports.json                      # { "myapp--prod": { web: 3100, pb: 8100 }, ... }
  projects/<project>/<instanceId>.json  # instance state
caddy/
  <project>--<instanceId>.caddy   # included by /etc/caddy/Caddyfile
```

**Instance state file** shape:

```json
{
	"project": "myapp",
	"env": "preview/feature-auth",
	"instanceId": "myapp--preview--feature-auth",
	"webPort": 3107,
	"pbPort": 8107,
	"activeRelease": "2026-04-17T22-10-00Z",
	"previousRelease": "2026-04-17T19-02-11Z",
	"hostnames": ["feature-auth.user-project.velastack.app"],
	"createdAt": "...",
	"updatedAt": "..."
}
```

---

## 6. Instance identity (`lib/instance.ts`)

```
env tag  "prod"                  -> instanceId "myapp--prod"
env tag  "staging"               -> instanceId "myapp--staging"
env tag  "preview/feature/auth"  -> instanceId "myapp--preview--feature-auth"
```

Normalization rules (spec §7):

- lowercase
- `/` → `-`
- strip anything not `[a-z0-9-]`
- collapse repeated `-`
- cap at, say, 48 chars; if longer, suffix with a short hash of the original to preserve uniqueness.

Systemd templates then see `%i = myapp--preview--feature-auth` and everything paths off that.

---

## 7. Port allocation (`lib/ports.ts` + `vela-allocate-port.sh`)

Keep the allocator **on the server**, invoked by `deploy`. Rationale: the server is the source of truth for what's in use, and multiple developers deploying won't race.

- Reserve `3100–3999` for web, `8100–8999` for PocketBase.
- Allocator script: acquire `/var/www/velastack/state/.ports.lock` with `flock`, read `ports.json`, pick lowest free pair, write it back, echo `{"web": N, "pb": M}`.
- Free on `destroy`.

---

## 8. Systemd + Caddy

**Templates** (installed once by `provision`, never regenerated):

`/etc/systemd/system/velastack-web@.service`

```ini
[Service]
Type=simple
User=velastack
WorkingDirectory=/var/www/velastack/projects/%i/current
EnvironmentFile=/var/www/velastack/projects/%i/shared/.env
ExecStart=/usr/bin/node build
Restart=on-failure
```

(And `velastack-pb@.service` similarly, starting the PocketBase binary against `shared/pb_data`.)

Note: `%i` is literally the instance id, but we need `project/instance`, so we actually template on `<project>--<instanceId>` and have the unit split it back out in a small `ExecStartPre=` helper, or — simpler — make `%i = myapp--preview--feature-auth` and resolve the project directory by parsing up to the first `--`. The second option is what the spec already assumes.

**Caddy**: one snippet per instance under `/etc/velastack/caddy/`, `import`ed by a base `Caddyfile`. `deploy` writes the snippet and `caddy reload` picks it up.

For v1, preview certs are issued per-host by Caddy on demand. Wildcard cert support is a later item (spec §22.2).

---

## 9. Privilege model

The CLI connects as whatever user the SSH alias specifies (spec example uses `root`). We support two modes:

1. **Root alias** — no sudo needed. This is the default path and the one the spec's example assumes.
2. **Non-root alias** — the user must have passwordless sudo for the commands we run. We detect this once during `provision` and write a marker; subsequent `deploy` calls read it.

Everything user-facing (releases, state, env files) runs as the `velastack` user. We only touch root-owned things (`/etc/systemd`, `/etc/caddy`) during `provision` and when adding Caddy snippets during `deploy`.

---

## 10. Command flows

### `vela provision <ssh-target>`

1. Open SSH session.
2. Detect OS (Ubuntu only for v1; bail clearly otherwise).
3. `apt-get install` base packages: caddy, nodejs, rsync, curl, tar, unzip, sqlite3.
4. Create `velastack` user + groups + base dirs.
5. Upload `templates/server/` → `/opt/velastack/`.
6. `install` systemd templates into `/etc/systemd/system/`, `daemon-reload`.
7. Install base `Caddyfile` with `import /etc/velastack/caddy/*.caddy`.
8. Initialize `state/ports.json` if missing.
9. Record `provisioned_at` and CLI version in `state/server.json`.

### `vela deploy <ssh-target> [--env <tag>] [--project <name>]`

1. Resolve project + env → instanceId + hostnames.
2. Run build command locally; produce `dist/<timestamp>.tar.gz` in `.vela/artifacts/`.
3. Open SSH session.
4. Ensure instance exists on server:
   - if `state/projects/<project>/<instanceId>.json` is missing, call `vela-allocate-port.sh <instanceId>` and write initial state.
5. `rsync` tarball to `projects/<project>/instances/<instanceId>/releases/<timestamp>/`, unpack there.
6. Ensure `shared/` exists; seed `.env` from config and CLI env merge on first deploy only (don't clobber on redeploy).
7. Call `vela-apply.sh <project> <instanceId> <timestamp>`:
   - write/refresh Caddy snippet (`<project>--<instanceId>.caddy`)
   - swap `current` symlink atomically
   - `systemctl enable --now velastack-web@<instanceId> velastack-pb@<instanceId>`
   - `caddy reload`
   - health-check `http://localhost:<webPort><healthCheckPath>` with retries
   - on failure: roll symlink back, return non-zero
   - update instance state JSON (`activeRelease`, `previousRelease`).
8. Prune old releases (keep last N, configurable; default 5).

### `vela rollback <ssh-target> [--env <tag>]`

`vela-rollback.sh <project> <instanceId>` — swap `current` to `previousRelease`, restart services, health check, update state. Errors out cleanly if there's no previous release.

### `vela status <ssh-target> [--env <tag>|--all]`

`vela-status.sh` prints JSON; CLI formats it. `--all` enumerates `state/projects/*/*.json`.

### `vela destroy <ssh-target> --env <tag>`

Extend the existing `destroy` command group. Stops services, removes Caddy snippet, optionally (`--purge`) removes releases + shared data, frees ports, removes state file.

For v1, require `--env` — don't let anyone `destroy` prod from a typo.

### `vela releases / vela logs`

- `releases`: `ls` releases dir + state lookup.
- `logs`: `ssh target journalctl -u velastack-web@<id> -f`.

---

## 11. Tests

Two layers:

1. **Unit** (vitest, offline) — instance-id normalization, config parsing, caddy snippet rendering, port allocator logic (run the bash script locally under a temp dir), systemd unit rendering.
2. **Integration** — a `scripts/e2e-vps.ts` that boots a throwaway Docker container with `systemd` + `sshd`, runs `vela provision` → `vela deploy` → `vela rollback` → `vela destroy` against it. Gated behind an env var so it doesn't run in CI by default. This is the only way to validate the systemd + Caddy moving parts end-to-end.

Also: extend `src/program.test.ts` to include the new top-level commands.

---

## 12. Phased rollout

**Phase 1 — Skeleton (1 PR).** `lib/ssh.ts`, `lib/vela-config.ts`, `lib/instance.ts`. Unit tests. No behavior change.

**Phase 2 — Provision.** `provision.ts` + server templates. Manually verify against a fresh Ubuntu VPS. No deploy yet.

**Phase 3 — Prod deploy.** `deploy.ts` + `vela-apply.sh` + health check + rollback on failure. Prod env only — no preview logic yet.

**Phase 4 — Rollback & status.** `rollback.ts`, `status.ts`, `releases.ts`, `logs.ts`. Tighten error paths.

**Phase 5 — Preview instances.** `--env preview/<branch>`, isolated `pb_data`, Caddy per-host snippets, `destroy --env`. Leaves wildcard DNS / control-plane integration for later (spec §18).

**Phase 6 — Polish.** Release pruning, `--purge` on destroy, better diagnostics, `vela prune` (spec §15 retention).

---

## 13. Open questions to resolve before Phase 2

Copying from spec §22, narrowed to what blocks implementation:

1. **Build location.** Phase 3 assumes local build. OK to ship that and add a `--artifact <path>` flag for CI later — decision: yes unless you want CI-first.
2. **OS target.** Only Ubuntu 22.04+ for v1? The spec says "stock Ubuntu VPS" — treating that as a hard constraint.
3. **Sudo story.** Default to assuming the SSH alias is root (matches spec example). Warn clearly otherwise. OK?
4. **`velastack.config.ts` location.** Workspace root. Does that also hold for monorepos where the app is in a subpackage? Tentatively: yes, resolve upward from `cwd` like `getWorkspace` already does.
5. **Preview DB isolation path.** Spec §14 says each preview gets its own `pb_data`. Confirming we're fine with the disk cost (full copy of prod seed each time? or empty?). Proposal: empty `pb_data` + optional `vela seed` hook later.

Answers to these land the rest of the plan.
