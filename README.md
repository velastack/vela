# vela

The VelaStack CLI. Scaffolds and maintains full-stack SvelteKit projects backed by PocketBase — collections, migrations, CRUD scaffolds, auth, payments, and typed data access, all generated into your project as ordinary source you own and edit.

## Requirements

- Node 20.19+ or 22.12+
- No separate PocketBase install — generated projects run it locally via `pocketbase-server`

## Install

```sh
npm install -g vela
```

This installs two command names, `vela` and `velastack`. They are equivalent.

## Quick start

```sh
vela create my-app
cd my-app
npm run dev
```

No global install needed to start a project — `npm create vela` goes through
[create-vela](https://github.com/velastack/create-vela), a shim that runs
`vela create` for you. npm wants `--` before the flags:

```sh
npm create vela my-app
npm create vela my-app -- --template static
```

`npx vela create my-app` does the same thing.

`vela create` copies a template and installs dependencies. For a template with a backend it also initializes PocketBase and writes a `.env` holding the local superuser credentials that the other commands authenticate with. That `.env` is gitignored by the generated project.

### Templates

| Template  | Adapter          | Backend                           | Dev server |
| --------- | ---------------- | --------------------------------- | ---------- |
| `minimal` | `adapter-auto`   | PocketBase, wired up and migrated | `vela dev` |
| `static`  | `adapter-static` | none — frontend only              | `vite dev` |

```sh
vela create my-app --template static
```

The `static` template is a prerendered frontend: no PocketBase, no superuser, no
`.env`, and its scripts call `vite` directly rather than the `vela` commands that
need a database. Site metadata lives in `src/lib/site.ts` — set `url` there to
where the site is deployed before building for production. The frontend commands
(`vela ui`, `vela legal`, `vela routes`, `vela i18n`) still work.

Its footer links to `/privacy` and `/terms`, which `vela legal privacy` and
`vela legal terms` generate. Until they exist, the dev server answers those paths
with the command that creates them, and the build warns instead of failing. Every
other broken link is still a build error.

| Flag                    | Description                                         |
| ----------------------- | --------------------------------------------------- |
| `--template <type>`     | Template to scaffold (default `minimal`)            |
| `--name <name>`         | App name, used for emails and metadata              |
| `--email <email>`       | Superuser email, skips the prompt (backend only)    |
| `--password <password>` | Superuser password, skips the prompt (backend only) |
| `--no-install`          | Skip installing dependencies                        |

### Existing projects

```sh
vela bless
```

Upgrades a vanilla SvelteKit project in place — adds the PocketBase backend, merges config, and brings the project up to the same layout `vela create` produces. Takes the same `--template`, `--email`, and `--password` flags. Blessing is what adds the backend, so `--template` only accepts backend templates.

## Generating

```sh
vela generate scaffold post title:text body:editor published:bool
```

| Command                                        | Description                                        |
| ---------------------------------------------- | -------------------------------------------------- |
| `generate scaffold <model> [fields...]`        | Model, forms, list and detail pages — the full set |
| `generate resource <model> [fields...]`        | Model plus CRUD pages                              |
| `generate schema <model> [fields...]`          | Zod schema only                                    |
| `generate form [model] [fields...]`            | Form only                                          |
| `generate migration <collection> <op> [args…]` | Migration against an existing collection           |

`generate scaffold`, `schema`, and `form` accept `--ai <description>` in place of an explicit field list, which designs the collection (and its form layout) from a natural-language prompt and previews it before writing anything.

Anything generated can be removed again:

```sh
vela destroy scaffold post
```

`destroy` mirrors `generate` with `scaffold`, `resource`, `schema`, and `form`.

## Features

Features are added as real source in your project, not hidden behind a runtime flag.

```sh
vela enable auth
```

| Feature               | Description                                           |
| --------------------- | ----------------------------------------------------- |
| `auth`                | Email/password authentication plus an OAuth scaffold  |
| `backend`             | The PocketBase backend                                |
| `api`                 | The PocketBase REST API                               |
| `api-keys`            | API key issuing and verification                      |
| `teams`               | Teams / multi-tenancy                                 |
| `payments`            | Stripe payments                                       |
| `subscriptions`       | Stripe subscriptions (requires `auth` and `payments`) |
| `s3`                  | S3 file storage                                       |
| `smtp`                | SMTP for transactional email                          |
| `i18n`                | Internationalization                                  |
| `content-negotiation` | `sveltekit-negotiate` content negotiation             |
| `blog`                | An mdsvex blog with posts, tags, and RSS              |

Every feature except `blog` and `subscriptions` has a matching `vela disable <feature>`.

## Data

```sh
vela migrate up
```

| Command                 | Description                                         |
| ----------------------- | --------------------------------------------------- |
| `migrate up`            | Apply pending migrations                            |
| `migrate down [n]`      | Revert the last N migrations                        |
| `migrate create <name>` | New blank migration                                 |
| `migrate collections`   | Snapshot local collections into a new migration     |
| `migrate history-sync`  | Drop `_migrations` rows whose files no longer exist |

Fixtures are generated fake data for development; seeds are real records you want to keep.

| Command             | Description                                          |
| ------------------- | ---------------------------------------------------- |
| `fixtures generate` | Generate fixture data                                |
| `fixtures load`     | Load fixtures into the database                      |
| `fixtures clear`    | Remove loaded fixtures                               |
| `fixtures reset`    | Clear and reload                                     |
| `fixtures regen`    | Clear the database, regenerate the files, and reload |
| `seeds save`        | Save current data as seeds                           |
| `seeds load`        | Load seeds into the database                         |
| `seeds clear`       | Remove seeded records                                |

## UI

```sh
vela ui add button card dialog
vela ui base slate
```

`ui add` pulls shadcn-svelte components into your project. `ui base` switches the base color.

## Everyday commands

| Command       | Description                                                      |
| ------------- | ---------------------------------------------------------------- |
| `dev`         | Start SvelteKit and PocketBase together, syncing types on change |
| `build`       | Build the app                                                    |
| `preview`     | Preview the built app                                            |
| `sync`        | Regenerate types from the live database schema                   |
| `test:server` | Run server tests                                                 |
| `routes`      | List the project's routes                                        |
| `i18n`        | `extract`, `watch`, `status`, and `clean` for translations       |
| `legal`       | Generate placeholder `terms` and `privacy` documents             |

## Account

```sh
vela signup
vela login
vela whoami
vela logout
```

Authenticates against [velastack.dev](https://velastack.dev) for hosted features.

## Version pinning

Each project records the CLI version it was created with, so `vela` produces the same migrations, scaffolds, and builds for everyone on the team and in CI — regardless of what any one machine has installed globally. When your global CLI and a project's pinned version differ, the global one hands off to the pinned one automatically, so you never have to think about which is running.

`vela create` and `vela bless` always run the version you invoked, since they set up a project rather than work inside one. To force the global CLI everywhere, set `VELA_NO_DELEGATE=1`.

## Docs

Full documentation lives at [docs.velastack.dev](https://docs.velastack.dev).

## License

MIT
