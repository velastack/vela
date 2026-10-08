# One environment model

Successor to `vela-env-plan.md`. That plan put production secrets on the server and
kept `.env` for development; this one extends the same model to everything an app
or its PocketBase can be configured with, across local, preview and production.

Decided 2026-10-07. No deprecation or compatibility work: nothing here ships to a
project that an older CLI has to keep reading.

## The problem

Three stores with three owners and no shared model:

| Store                    | Lives                                           | Edited by                                                                                   |
| ------------------------ | ----------------------------------------------- | ------------------------------------------------------------------------------------------- |
| dotenv                   | `.env` locally, `/etc/vela/apps/<instance>/env` | hand, `vela env set -t`                                                                     |
| PocketBase core settings | the database, per instance                      | admin panel, `vela enable smtp`/`s3`, and a `site.ts → meta.appName` sync on `dev`/`deploy` |
| Plugin settings          | `_whatsapp`, per instance                       | admin panel, or `WHATSAPP_*` env, which overrides and shows as "env" in the UI              |

Two facts shape the fix:

- Both systemd units already load the instance's env file, so `vela env set -t prod
WHATSAPP_MODE` works today. The WhatsApp plugin has the right model; core
  PocketBase has no env override at all, which is why `appName` needed a sync.
- Every preview branch is its own instance with its own empty env file.

## Principles

1. **Env is the only runtime surface.** Anything that differs between environments
   is an environment variable, for the app and for PocketBase alike.
2. **Code is the only universal surface.** Something that is the same everywhere
   and not secret is a constant in `src/lib`, not configuration.
3. **The database holds only what an admin should change at runtime.**
4. **Derive before configure.** Vela knows the origin, the ports and the data dir;
   nothing it knows is typed by a user.
5. **Secret unless said otherwise.** A value on the server is write-only until it
   is set with `--public`.
6. **The repo never carries env.** No committed `.env*` apart from `.env.example`.
   No project config file either: vela has always been zero-config and stays so.
7. **The build sees exactly the env the target will run with.** Prerendering
   against real data is non-negotiable; this is how it stays correct.

## Where a value lives

| Kind                                                      | Home                                                 |
| --------------------------------------------------------- | ---------------------------------------------------- |
| Universal, not secret (`site.name`, canonical `site.url`) | code, `src/lib/site.ts`                              |
| Per target, secret or not                                 | server, `vela env set KEY -t <target>`               |
| Shared by every deployed target (`VELASTACK_API_KEY`)     | server, app-wide scope, `vela env set KEY -t all`    |
| Shared by every preview                                   | server, preview scope, `vela env set KEY -t preview` |
| Local development                                         | gitignored `.env`, documented by `.env.example`      |
| Derived (`ORIGIN`, `POCKETBASE_URL`, PocketBase `appURL`) | written by vela, never typed                         |
| Admin-mutable runtime state (backup schedule)             | the database                                         |

Per-target non-secrets are a thin category and get thinner once modes are
inferred from which credentials exist (see WhatsApp below).

## Scopes

Three layers on a server, each a pair of files. systemd loads them in this
order; later wins.

```
/etc/vela/scopes/<appId>/all/env            app-wide      vela env set KEY -t all
/etc/vela/scopes/<appId>/all/env.public
/etc/vela/scopes/<appId>/preview/env        every preview vela env set KEY -t preview
/etc/vela/scopes/<appId>/preview/env.public
/etc/vela/apps/<instance>/env               one target    vela env set KEY -t prod | -t preview:<branch>
/etc/vela/apps/<instance>/env.public
/etc/vela/apps/<instance>/runtime.env       derived, rewritten on every deploy
```

Scopes live in their own tree because the production instance _is_ `<appId>`
(`instanceId(appId, 'production') === appId`), so `/etc/vela/apps/<appId>/` is
production's directory, not the app's.

`runtime.env` stays last so derived values win, with one exception below
(`APP_URL`).

The units are templates on `%i` and cannot derive `<appId>` or preview-ness, so
they list fixed names and `apply.sh` writes symlinks beside `runtime.env`:

```
/etc/vela/apps/<instance>/scope.all.env           -> /etc/vela/scopes/<appId>/all/env
/etc/vela/apps/<instance>/scope.all.public.env    -> .../all/env.public
/etc/vela/apps/<instance>/scope.preview.env       -> .../preview/env          (previews only)
/etc/vela/apps/<instance>/scope.preview.public.env
```

Every `EnvironmentFile=` but `runtime.env` is `-` prefixed, so a layer that does
not exist yet — or a symlink `apply.sh` did not write — is skipped.

A preview of a branch resolves all → preview → its own instance, so it is never
empty and almost never needs its own layer.

### Several servers

Targets bind to machines independently (velastack.dev has three), so "the
server" has no single referent for a scope. `-t all` and `-t preview` write to
every distinct server among the project's bindings — `preview` to those with a
preview target — and restart every instance of this app the layer reaches on
each. With no bindings there is nowhere to write: the command errors and points
at `vela deploy --server`. A target bound to a new server later starts with the
scopes empty there; the `.env.example` nudge on its first deploy is what catches
it.

### Target selection

`-t preview` means the scope for `env` commands and the current branch for
`deploy`. That asymmetry is deliberate: a preview API key is set once, a branch
is deployed many times. `-t preview:<branch>` addresses one preview from either.

`set`, `unset` and `import` with no `-t` prompt for the scope — local, all
servers, every preview, or a bound target — rather than defaulting to any of
them. Today no `-t` means local; with scopes it is the most-typed command
writing somewhere the user did not say, so it asks. Non-interactive runs must
pass `-t`. `list` with no `-t` prints the matrix and asks nothing.

## `--public`

Every value is secret by default: written, never read back. `--public` makes a
value readable, and `PUBLIC_*` keys are public without the flag — SvelteKit puts
them in the browser bundle, so hiding them on the server is theater. The flag
only widens.

- `env` holds secrets, `env.public` holds public values. The `env` subcommands
  read `env.public` for values and `env` for names alone (`list` shows that a
  secret exists), and `get` never opens a secret's value. (`deploy` does read
  `env` into memory for the build, and `apply.sh` reads the superuser
  credentials from it; neither prints.)
- Changing a key that the app imports from `$env/static` changes nothing until
  the next deploy — the value is baked at build. `set` greps the source for a
  static import of the key and says "KEY is read at build time; redeploy to
  apply" instead of "App restarted".
- `set` always prompts, never takes the value as an argument (shell history).
  Secret → no echo; public → echoed, so the prompt tells you which you are
  setting.
- `set` of a key that exists in the other file moves it.
- `unset` removes from both files.
- `list` prints a matrix of keys × scopes with inheritance shown: values for
  public keys, `••••` for secrets.
- `get KEY -t <target>` prints a public value; for a secret it says so and points
  at `set`.
- `import <file>` stays, as secret; `import --public` for the other kind.

## velabase reads core settings from env

Generalize the WhatsApp plugin's `envOverrides`: on bootstrap and settings
reload, overlay these onto the core settings and show them locked as "env" in
the admin UI.

| Env                                                                                                            | Setting                                 |
| -------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| `APP_NAME`                                                                                                     | `meta.appName`                          |
| `APP_URL`, else `ORIGIN`                                                                                       | `meta.appURL`                           |
| `PB_SMTP_HOST`, `PB_SMTP_PORT`, `PB_SMTP_USERNAME`, `PB_SMTP_PASSWORD`, `PB_SMTP_TLS`                          | `smtp.*`, enabled when host is set      |
| `PB_SENDER_NAME`, `PB_SENDER_ADDRESS`                                                                          | `meta.senderName`, `meta.senderAddress` |
| `PB_S3_ENDPOINT`, `PB_S3_BUCKET`, `PB_S3_REGION`, `PB_S3_ACCESS_KEY`, `PB_S3_SECRET`, `PB_S3_FORCE_PATH_STYLE` | `s3.*`, enabled when endpoint is set    |
| `PB_BACKUPS_S3_*` likewise                                                                                     | `backups.s3.*`                          |

`APP_NAME` and `APP_URL` are plain because they describe the app, whichever
process reads them. Everything else is prefixed because both units load the
same files: an app using `S3_BUCKET` for its own uploads or `SMTP_HOST` for its
own mailer must not silently switch PocketBase's storage or mail on.

`appURL` defaulting to `ORIGIN` is what fixes the stale-URL problem: password
reset links from a preview hit the preview. `APP_URL` is the explicit override
for an app that serves one canonical domain while deployed on another, and is
the one key a user sets that must beat `runtime.env` — so velabase prefers
`APP_URL` when both are present rather than relying on file order. One target
has no `ORIGIN` to derive: an app served directly on several hosts
(velastack.dev and velabase.dev), where `runtime_origin_lines` deliberately
writes none. There the database's value stands until `vela env set APP_URL
--public -t production` says which host emails link to.

The WhatsApp plugin infers `mode` when `WHATSAPP_MODE` is unset: `velastack`
when `VELASTACK_API_KEY` is set, `direct` when `WHATSAPP_ACCESS_TOKEN` is, `dev`
otherwise. The explicit variable keeps working.

Order of release: velabase and the plugin first, patterns second, the CLI last,
each pinned to the one before.

## `site.ts`

Stays, as ordinary code: `export const site = { name, url }`. What goes is the
specialness around it. `url` is only the canonical site URL (deliberately
production on previews) and no longer feeds PocketBase, so the `site.url` /
`appURL` warnings in `deploy` are deleted. `name` is still read statically by the
CLI, once, to export `APP_NAME`:

- `vela dev` sets `APP_NAME` and `ORIGIN` in the local PocketBase child's env
  (`startPocketbaseServe` gains an `env` option). PocketBase starts before Vite
  today and Vite's port is only final after `listen()`, which is why the current
  code patches `appURL` afterwards. Env-only means knowing the port first: after
  `createServer` resolves the config, vela probes for a free port from the
  configured one (what Vite would do itself), passes it back with `strictPort`,
  then starts PocketBase with the origin, then listens. Same ports as today in
  the common case; no `settings.update`.
- `apply.sh` writes `APP_NAME` into `runtime.env` from the value `deploy` passes.

No `settings.update` anywhere in the CLI for `meta`.

## The build

`vela deploy -t <target>` assembles the target's full stack for the build: the
derived values it knows, the three layers' files read over SSH into process
memory (the superuser credentials already travel this way for `--remote-db`),
and the tunnel to the target's database. The tunnel stays on by default whenever
the instance has a backend, `--no-remote-db` turns it off; the config-file
setting it also honoured is gone with the file.

SvelteKit reads `$env` with Vite's `loadEnv(mode, kit.env.dir, '')`, where the
directory is a SvelteKit option that defaults to the project root — Vite's own
`envDir` is not consulted, and vela has no config to set `kit.env.dir` in. So
`.env` is always read at build, and today a key that exists only in `.env` is
baked into a production bundle through `$env/static`, and seen by prerendering
through `$env/dynamic`. Two moves close it, both using the fact that `loadEnv`
lets a key already in `process.env` win over the files:

1. The build child's `process.env` is the resolved stack, plus every `.env` key
   the stack lacks set to the empty string, so a dev-only value is never the one
   the build sees.
2. Before building, vela greps the source for `$env/static/*` imports of those
   dev-only keys and fails the deploy with the list: the import would otherwise
   get `''` where today it gets a dev value and where, with the file absent, it
   would fail the build.

`$env/static` imports the stack cannot satisfy fail locally, before anything is
uploaded. Those two are the only hard failures.

## `.env.example`

Templates ship one, and patterns append to it the keys they introduce. It is
documentation and a nudge, not a contract: it cannot say required vs optional
and it should not try.

On an instance's first deploy — and only then, since a project's own example is
full of keys it means to leave unset — interactive `deploy` lists the names in
it that the target's resolved stack lacks and offers to set each one (scope and
`--public` asked inline, skip allowed). Non-interactive prints the list and
continues. Previews are never blocked by it.

Edges, by design: `--server` is not taken by `-t all` or `-t preview`, which go
to the bound servers; `destroy deployment --purge` of the last instance leaves
`/etc/vela/scopes/<appId>` in place, since a layer outlives any one target.

## Removed

- `velastack.config.*` and `deploy-config.ts`'s loading of it. `domain` is in the
  target binding already; `healthCheckPath`, `keepReleases`, `pocketbaseVersion`,
  `buildCommand`, `outputDir`, `include` become defaults, with a flag recorded
  on first use only where one has been needed in practice.
- `pocketbase-settings.ts`: `readLocalMeta`, `copiedMeta`, `syncRemoteMeta`.
- `deploy.ts`: `syncAppName`, `seedNewDatabase`, `reportSiteUrl`, the `appURL`
  warning, `reportEmptyEnvironment` (replaced by the `.env.example` nudge).
- `dev.ts` and `create.ts`: the `settings.update({ meta })` calls.
- `vela enable smtp`, `vela disable smtp`, `vela enable s3` and
  `s3-settings.ts`: they are `vela env set` with extra steps.
- The `vela env set KEY value` form.

## Kept from the previous plan

- No cloud secret store; values go straight to the VPS over SSH.
- No plaintext copy under `.vela/`.
- `deploy` and `rollback` never write the scope files. `apply.sh`'s one exception
  — appending generated superuser credentials on the deploy that creates the
  account — stays.
- Atomic root-owned 0600 writes, values piped over stdin, redaction everywhere.
- `deploy` never uploads `.env`.

## Command surface

```
vela env set KEY [--public] [-t <target>]     prompts for the value, and for the scope without -t
vela env unset KEY [-t <target>]
vela env get KEY -t <target>                  public values only
vela env list [-t <target>]                   matrix across scopes by default
vela env import <file> [--public] [-t <target>]
```

Targets: `local`, `all`, `preview`, `preview:<branch>`, `production` or any
bound name. `-t local` edits `.env`, as today, and ignores `--public`.

## Tests

- scope resolution: all < preview < instance, public and secret files, a
  missing layer, `APP_URL` beating `ORIGIN`
- `set`: moves a key between files; `unset` clears both; `PUBLIC_*` lands public
  without the flag; the value never appears in argv, output or errors; no `-t`
  prompts, and errors non-interactively; `-t all` reaches every bound server
  and errors with none
- `list`/`get`: secrets never printed; inheritance rendered
- `deploy`: the build child's env equals the resolved stack with dev-only keys
  blanked; a `$env/static` import of a dev-only key fails before the build; the
  nudge lists missing `.env.example` names and never fails
- `dev`: PocketBase starts with `ORIGIN` equal to the port Vite then listens on
- `apply.sh`: scope symlinks written, preview ones only for previews; both units
  list every layer; `runtime.env` carries `APP_NAME`
- velabase: env overlay on bootstrap and reload; UI shows "env"; `appURL` falls
  back to `ORIGIN`
- plugin: mode inference from credentials, explicit `WHATSAPP_MODE` wins

## Acceptance

```
vela create acme && cd acme            # .env, .env.example, site.ts
vela dev                               # PocketBase named Acme, appURL = the dev origin
vela deploy --server root@box          # binds production; nudge lists .env.example gaps
vela env set VELASTACK_API_KEY -t all  # every bound server, prompted, no echo
vela env set WHATSAPP_MODE --public -t preview
vela deploy -t preview                 # same box; inherits both; emails link to the preview URL
vela env list                          # matrix, values only for public keys
```

Production's admin panel shows App name and App URL as "env".

No `settings.update` in the CLI, no config file in the project, nothing env-like
in git but `.env.example`.
