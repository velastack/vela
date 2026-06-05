## VelaStack Provisioning and Deploys Spec

This spec defines how VelaStack CLI provisions servers and deploys applications, including production and optional preview branch environments.

The design target is a system that is:

- simple to reason about
- SSH-driven from the developer’s machine
- transparent on the server
- compatible with ordinary Linux tooling
- capable of preview deploys without turning into a full orchestration platform

---

# 1. Core model

VelaStack deploy commands target **SSH aliases** defined by the user in their local SSH config.

Examples:

```bash
vela provision myserver
vela deploy myserver
vela rollback myserver
```

Where `myserver` is an alias in `~/.ssh/config`, for example:

```sshconfig
Host myserver
  HostName 203.0.113.10
  User root
  IdentityFile ~/.ssh/id_ed25519
```

VelaStack does not ask the user for raw hostnames, usernames, or SSH keys during normal command use. It delegates connection setup to SSH itself.

This keeps the model predictable and Unix-native.

---

# 2. Terminology

## SSH target

The SSH alias used to reach the server.

Examples:

- `myserver`
- `prod-eu`
- `angola-vps`

## Project

A VelaStack app deployed to a server.

Examples:

- `climbangola`
- `myapp`

## Environment tag

A logical deployment slot within a project on a server.

At minimum:

- `prod`

Optional:

- `staging`
- `preview/<branch>`
- `custom tag`

The tag is what distinguishes multiple deployable instances of the same project on one server.

## Release

An immutable uploaded build artifact unpacked to a release directory.

## Instance

A running deployment of a project for a specific environment tag.

Examples:

- `climbangola:prod`
- `climbangola:preview/feature-auth`

---

# 3. Command shape

## Required pattern

The base deploy commands target an SSH alias:

```bash
vela provision <ssh-target>
vela deploy <ssh-target>
vela rollback <ssh-target>
vela status <ssh-target>
```

## Project resolution

There are two valid models:

### Model A: project inferred from local app config

If the user is inside a VelaStack app, the project name comes from config.

Example:

```bash
vela deploy myserver
```

### Model B: project explicitly passed

Useful when a server hosts multiple projects or for scripting.

Example:

```bash
vela deploy myserver --project myapp
```

Recommended behavior:

- infer project from local config by default
- allow `--project` override

## Environment tag selection

By default, deploys target `prod`.

```bash
vela deploy myserver
```

Equivalent to:

```bash
vela deploy myserver --env prod
```

Other examples:

```bash
vela deploy myserver --env staging
vela deploy myserver --env preview/feature-auth
vela rollback myserver --env prod
vela status myserver --env preview/feature-auth
```

---

# 4. Local project config

Each app should define deployment configuration in a VelaStack config file.

Example shape:

```ts
export default defineConfig({
	project: 'myapp',
	deploy: {
		healthCheckPath: '/health',
		buildCommand: 'npm run build',
		artifactStrategy: 'tarball',
		previews: {
			enabled: true,
			provider: 'velastack',
			subdomain: 'user-project.velastack.app'
		}
	}
});
```

Minimum required data:

- project name
- health check path
- whether previews are enabled

Optional:

- environment variables mapping
- build artifact rules
- preview retention policy
- branch naming rules

---

# 5. Provisioning spec

## Command

```bash
vela provision <ssh-target>
```

## Purpose

Prepare a stock Ubuntu VPS to host one or more VelaStack projects.

## What provision installs

### Base packages

- Caddy
- Node.js runtime
- rsync / curl / tar / unzip
- SQLite tools where useful
- systemd units and support files
- any minimum OS dependencies for SvelteKit + PocketBase hosting

### Base directories

Provision creates a root VelaStack deployment area, for example:

```txt
/var/www/velastack/
  projects/
  shared/
  state/
  bin/
  caddy/
  systemd/
```

Project-specific directories are created lazily on first deploy, not necessarily during initial provision.

### Deployment user

Provision creates a dedicated user, for example:

- `velastack`

This user owns runtime files and app releases.

### Reverse proxy

Provision installs and configures Caddy.

Caddy becomes the traffic entrypoint for:

- production domains
- optional preview domains

### Wildcard preview support

If preview branches are enabled for any project, Caddy must be able to route wildcard subdomains to the correct instance.

Provision should support setting this up later, but not require it up front.

### Server state registry

Provision creates a machine-readable state area.

Example:

```txt
/var/www/velastack/state/
  projects/
    myapp/
      prod.json
      staging.json
      preview--feature-auth.json
```

These files store active release and runtime metadata.

---

# 6. Production deploy model

## Default environment

If no `--env` is specified, deploy targets `prod`.

```bash
vela deploy myserver
```

## Production instance identity

Internally, the instance key is:

```txt
<project>:prod
```

Example:

```txt
myapp:prod
```

## Production domain handling

The user is responsible for pointing their production domain at the server.

VelaStack is responsible for:

- server runtime
- reverse proxy rules
- TLS via Caddy

---

# 7. Preview environment model

Preview deploys are optional and should be explicitly enabled per project.

## Command examples

```bash
vela deploy myserver --env preview/feature-auth
vela deploy myserver --env preview/fix-signup-copy
vela destroy myserver --env preview/feature-auth
```

## Branch mapping

A preview environment maps branch name to environment tag.

Example:

- Git branch: `feature/auth`
- normalized preview tag: `preview/feature-auth`

Normalization rules should be deterministic:

- lowercase
- replace `/` with `-`
- strip unsupported characters
- bound maximum length

Example:

```txt
feature/auth -> feature-auth
fix/login-form-copy -> fix-login-form-copy
```

## Preview hostnames

If VelaStack-managed previews are enabled, each preview gets a subdomain like:

```txt
feature-auth.user-project.velastack.app
```

Or possibly:

```txt
feature-auth.preview.user-project.velastack.app
```

The simpler version is better unless collisions become a problem.

## DNS model

For VelaStack-hosted previews, the required DNS setup is:

- a wildcard `A` record for `*.user-project.velastack.app`
- pointing at the user’s server IP

This only works if:

- the user has enabled previews
- the VelaStack control plane has recorded the server IP
- the wildcard DNS entry has been provisioned on the VelaStack-managed domain

## TLS model

Caddy can terminate TLS for wildcard preview domains if certificate issuance is configured correctly.

This implies one of:

- Caddy obtains certificates per preview host automatically
- or VelaStack provisions wildcard cert support

The first approach is simpler to start if issuance limits remain manageable. The wildcard-cert route is more scalable, but more complex.

The spec should not hardcode implementation yet, but the deploy/runtime model should assume HTTPS preview URLs.

---

# 8. Environment tags and alias tags

The user raised the idea that there is a “current alias” that should really be called `prod`, and then other alias tags exist. That is the right abstraction.

The model should be:

- **SSH alias** = which server
- **environment tag** = which instance on that server

So this:

```bash
vela deploy myserver
```

means:

- SSH target: `myserver`
- env: `prod`

And this:

```bash
vela deploy myserver --env preview/feature-auth
```

means:

- SSH target: `myserver`
- env: `preview/feature-auth`

This avoids overloading SSH aliases with deployment slots.

---

# 9. Server layout

Recommended layout:

```txt
/var/www/velastack/
  projects/
    myapp/
      instances/
        prod/
          releases/
          shared/
          current
        staging/
          releases/
          shared/
          current
        preview--feature-auth/
          releases/
          shared/
          current
      state/
        prod.json
        staging.json
        preview--feature-auth.json
```

Where each instance has its own:

- releases
- current symlink
- environment file
- logs
- assigned ports
- persistent storage as needed

This is cleaner than trying to force all instances into one shared folder tree.

---

# 10. Systemd model

This is the main tricky part. The cleanest answer is: **use templated systemd units**.

Not one service file per preview branch generated manually, and not one giant multiplexer service.

## Use templated units

Example service names:

- `velastack-web@myapp--prod.service`
- `velastack-pb@myapp--prod.service`
- `velastack-web@myapp--preview--feature-auth.service`
- `velastack-pb@myapp--preview--feature-auth.service`

This avoids a growing pile of handwritten unit files.

## Why templates are the right fit

Because the instance identity already exists as a stable string:

- `myapp--prod`
- `myapp--preview--feature-auth`

Systemd templates can take that instance name and load per-instance config from a predictable location.

Example config path:

```txt
/etc/velastack/instances/myapp--preview--feature-auth.env
```

Or:

```txt
/var/www/velastack/projects/myapp/state/preview--feature-auth.env
```

## Unit template shape

### Web template

`/etc/systemd/system/velastack-web@.service`

### PocketBase template

`/etc/systemd/system/velastack-pb@.service`

Each template reads instance-specific variables:

- release path
- working dir
- port
- env file
- storage dir
- project name
- environment tag

This keeps preview branch support from becoming a systemd mess.

---

# 11. Caddy routing model

Caddy should also be generated from instance state rather than hand-managed.

## Production

A normal host entry proxies the project’s prod domain to the prod web port.

## Preview

Wildcard preview domains should route based on hostname.

Example:

```txt
feature-auth.user-project.velastack.app -> web port for myapp preview feature-auth
fix-signup.user-project.velastack.app -> web port for myapp preview fix-signup
```

There are two possible ways to do this.

### Option A: explicit Caddy entries per preview instance

Each preview deploy adds a host block.

Pros:

- simple
- explicit
- easy to inspect

Cons:

- Caddyfile grows with preview count

### Option B: one wildcard matcher plus an internal registry lookup

Pros:

- elegant at scale

Cons:

- more moving parts
- less obvious
- probably too clever for v1

Recommendation: **Option A** for v1.

Generate explicit host entries per preview instance from state.

---

# 12. Port allocation

Each instance needs:

- one web port
- one PocketBase port

Ports should be assigned automatically and stored in instance state.

Example:

```json
{
	"project": "myapp",
	"env": "preview/feature-auth",
	"instanceId": "myapp--preview--feature-auth",
	"webPort": 3107,
	"pbPort": 8107,
	"activeRelease": "2026-04-17T22-10-00Z"
}
```

## Requirements

- no port collisions across instances
- stable enough to survive restarts
- reclaimable when preview instances are destroyed

Provision should initialize a port allocator state file or use deterministic scanning of used ports.

---

# 13. Deploy flow

## Command

```bash
vela deploy <ssh-target> [--env <tag>]
```

## Flow

### 1. Resolve target and config

Determine:

- SSH target
- project name
- environment tag
- whether this is prod or preview
- preview hostname if applicable

### 2. Build artifact

Build locally or in CI, then produce a release tarball.

### 3. Ensure server instance exists

If deploying to a new environment tag:

- create instance directory structure
- assign ports
- write instance state
- generate instance env/config
- ensure Caddy knows about the hostname

This is the key distinction:
**instances are created lazily on first deploy**.

### 4. Upload release

Upload artifact to the instance’s `releases/` directory.

### 5. Link shared state

Attach:

- `.env`
- persistent uploads/storage
- PocketBase data dir

### 6. Run migrations

Run up migrations for the instance.

For preview environments, this needs a decision.

---

# 14. Preview database strategy

This is the biggest unresolved product decision for preview branches.

There are three realistic models.

## Option A: previews share production DB

Not acceptable in most cases.

Too dangerous.

## Option B: previews share a single non-prod DB

Simple, but previews interfere with each other.

Bad fit for branch isolation.

## Option C: each preview gets its own database/storage

Best product behavior.

For PocketBase/SQLite this means each preview instance gets its own data directory.

This is the correct model.

### Recommendation

- `prod` gets its own persistent storage
- `staging` gets its own persistent storage
- each `preview/<branch>` gets isolated storage

That way preview branches are truly disposable.

This also makes cleanup straightforward.

---

# 15. Preview lifecycle

Preview instances should not live forever.

## Create

First deploy to a preview env creates the instance.

## Update

Subsequent deploys replace the running release but keep the same preview instance and hostname.

## Destroy

Preview instances should be removable:

```bash
vela destroy myserver --env preview/feature-auth
```

This command should:

- stop services
- remove Caddy host entry
- optionally remove DB/storage
- optionally remove releases
- free ports
- remove instance state

## Retention

There should also be a pruning command later:

```bash
vela prune myserver --previews
```

or automatic retention such as:

- destroy previews older than N days
- destroy previews whose branch no longer exists, if integrated with git hosting later

But that can wait until later.

---

# 16. Rollback flow

## Command

```bash
vela rollback <ssh-target> [--env <tag>]
```

Rollback works per instance, not per server globally.

Examples:

```bash
vela rollback myserver
vela rollback myserver --env staging
vela rollback myserver --env preview/feature-auth
```

## Flow

- locate current and previous release for that instance
- run down migrations if defined
- start prior release
- health check
- update Caddy if needed
- stop failed release
- update state

For previews, rollback is still valid, though less critical than in prod.

---

# 17. Provisioning and previews

Provision itself should not create preview instances. It should only make preview hosting possible.

## `vela provision <ssh-target>` responsibilities

- install runtime packages
- create base directories
- install templated systemd units
- install base Caddy config
- install VelaStack server-side helper scripts if needed
- initialize global state and port allocation
- optionally register server metadata for preview DNS support if previews are enabled later

## `vela deploy` responsibilities

- create per-instance runtime config lazily
- create preview-specific host routes lazily
- create/remove preview services as needed via templated units

This separation is important. Provision prepares the server. Deploy realizes actual instances.

---

# 18. Preview DNS and VelaStack control plane

If previews use `*.user-project.velastack.app`, there needs to be some remote registry in VelaStack itself.

Minimum required data:

- user/project identifier
- server public IP
- preview subdomain base
- whether previews are enabled

Example:

- project: `myapp`
- preview base: `user-project.velastack.app`
- A record wildcard points to server IP

The CLI might need a separate command later:

```bash
vela previews enable
```

That is outside raw server provisioning, but part of the end-to-end preview product.

Without some control plane, VelaStack cannot automate wildcard DNS on its own domain.

---

# 19. Status model

## Command

```bash
vela status <ssh-target> [--env <tag>]
```

Should show:

- project
- environment tag
- instance id
- domain/preview URL
- active release
- previous release
- assigned ports
- service health
- deploy timestamp

For a broad server view:

```bash
vela status myserver --all
```

Could list all active instances:

- `myapp:prod`
- `myapp:staging`
- `myapp:preview/feature-auth`

---

# 20. Recommended command surface for v1

## Must-have

- `vela provision <ssh-target>`
- `vela deploy <ssh-target> [--env <tag>]`
- `vela rollback <ssh-target> [--env <tag>]`
- `vela status <ssh-target> [--env <tag>|--all]`

## Strongly recommended

- `vela destroy <ssh-target> --env <tag>`
- `vela releases <ssh-target> [--env <tag>]`
- `vela logs <ssh-target> [--env <tag>]`

## Later

- `vela prune <ssh-target>`
- `vela previews enable`
- `vela previews disable`
- git-provider integration for automatic preview lifecycle. This will be called @velastack/action

---

# 21. Opinionated decisions

These should be explicit in the spec.

## Decision 1

**SSH aliases are the deployment target interface.**

Not raw IPs, not stored connection profiles in VelaStack.

## Decision 2

**`prod` is the default environment tag.**

Not an implicit unnamed slot.

## Decision 3

**Preview environments are just tagged instances.**

They are not a separate deployment mechanism.

## Decision 4

**Systemd templates are the correct way to support many instances.**

Do not generate a pile of bespoke services per preview manually.

## Decision 5

**Each preview instance gets isolated storage/database.**

Anything else creates too much cross-branch contamination.

## Decision 6

**Per-preview Caddy routes are acceptable for v1.**

Avoid a more dynamic routing layer until there is real scale pressure.

---

# 22. Open questions

These still need decisions.

## 1. Artifact build location

- local machine?
- CI?
- both supported?

## 2. Preview certificate model

- per-host issuance
- wildcard certificate
- VelaStack-managed edge later?

## 3. Multi-project hosting on one server

Supported from day one structurally, but how much CLI ergonomics do we want initially?

## 4. Preview subdomain naming

Should it be:

- `feature-auth.user-project.velastack.app`
- or `feature-auth.preview.user-project.velastack.app`

The simpler one is cleaner.

## 5. Preview lifecycle automation

Should VelaStack eventually auto-create/destroy previews from GitHub PRs? Probably yes, but not required for first deploy spec.

---

# 23. Condensed spec statement

VelaStack deploys target SSH aliases and operate on named environment tags, with `prod` as the default. Each deployed environment is an instance of a project, backed by immutable releases, isolated runtime state, assigned ports, templated systemd services, and generated Caddy routing. Preview branches are implemented as disposable tagged instances such as `preview/feature-auth`, optionally exposed on VelaStack-managed wildcard subdomains like `feature-auth.user-project.velastack.app`. Instance directories, service bindings, and routes are created lazily on first deploy, while `vela provision` only prepares the server-wide runtime foundation.

The hardest part is not systemd; templated units solve that cleanly. The real design pressure is preview lifecycle and DNS ownership, which means previews are partly a server feature and partly a VelaStack control-plane feature.
