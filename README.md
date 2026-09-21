# vela

**Full-stack SvelteKit, without the setup.**

`vela` scaffolds a SvelteKit app with a real backend already wired up — database, auth, payments, typed data access — and keeps generating the boring parts as you build. Everything it writes is ordinary source in your project. No runtime to learn, no lock-in, nothing hidden behind a flag.

```sh
npm create vela my-app
cd my-app
npm run dev
```

That's a running app with a database behind it. No separate PocketBase install, no Docker, no config.

## What you get

- **A backend on day one.** PocketBase, migrated and running locally, with types synced from your schema as it changes.
- **Auth, payments, teams, notifications, email, i18n** — one command each, generated into your project as code you own.
- **CRUD you didn't write.** `vela generate scaffold post title:text body:editor` gives you the model, schema, forms, and pages.
- **Describe it instead.** Pass `--ai "a blog post with tags and a cover image"` and review the collection it designs before anything is written.
- **shadcn-svelte components** on tap, and fixtures and seeds for realistic data while you work.
- **The app's name in code.** Every project keeps its name and public URL in `src/lib/site.ts`; canonical links, Open Graph images and feeds are built from it, and `vela dev` / `vela deploy` copy the name into PocketBase for the emails it sends.
- **Themed templates.** `vela create --template broadsheet` pulls a finished blog design from the template registry; `--template` lists what is available, grouped by category.
- **Linked from the start.** Logged in to velastack.dev, `vela create` links the new project there (`.vela/project.json`), so `vela deploy` reports to it and a CMS-ready template such as `hearth` reads from the project's free hosted CMS right away. `vela login` first if you are not; `vela link` does the same for a project you already have.

```sh
vela create my-site --template hearth              # linked, CMS endpoint written into src/lib/site.ts
vela create my-site --template hearth --link none  # keep it local; fill in `cmsEndpoint` later
vela create my-site --template hearth --cms https://cms.example/v1/projects/<id>/cms
CI=1 VELA_API_KEY=… vela create my-site --template hearth --link new --no-install
```

Off a terminal nothing is created on velastack.dev unless `--link new` or `--link <project-id>` says so (`--team <id>` picks the team for a new one; the personal team is the default).

## The shape of a day

```sh
vela enable auth                                     # sign-in, sessions, OAuth scaffold
vela generate scaffold post title:text body:editor   # model, forms, list and detail pages
vela migrate up                                      # schema, versioned and in git
vela ui add button card dialog                       # shadcn-svelte components, into your project
vela ui add data-table multiselect                   # vela's own components, same command
vela ui list                                         # what's installed, what vela ships, what the registry offers
vela ui style nova                                   # switch shadcn-svelte style, re-adding its components
vela ui base zinc                                    # base palette; `vela ui theme blue` for an accent
```

Changed your mind? `vela destroy` and `vela disable` take it back out.

## Ship it

Deploys go to a server you own, over SSH. Prepare the box once, then deploy as often as you like.

```sh
vela provision root@your-server                        # Caddy, Node, PocketBase, systemd, TLS
vela deploy --server root@your-server --domain example.com
```

Any SvelteKit project deploys this way, PocketBase or not — `npx sv create my-app`
straight into `vela deploy` works. The deploy looks at the project rather than at a
config: a server needs `@sveltejs/adapter-node`, so a project still on `adapter-auto`
(what `sv create` gives you) is switched to it on the first deploy, the package
installed, and you are asked to commit the change. At a terminal the deploy asks before
it edits the config file and `package.json`; in CI it goes ahead. A project on
`adapter-static` or a hosting platform's adapter is left alone and told why. The server
installs dependencies with npm, so a pnpm, yarn or bun project should commit a
`package-lock.json` for a reproducible deploy; the deploy warns when it finds only theirs.
Nothing on the server assumes a database: run `vela enable backend` whenever you want
one and deploy again, and the same instance gains its PocketBase.

That first deploy binds `production` to the server, so nothing after it names a
machine again. Every command takes the same selector — `-t local`, `-t production`
(or `prod`), or any name you choose such as `-t staging`:

```sh
vela targets                       # what exists, and where
vela env import .env.production -t production
vela admin create -t production    # a login for the admin panel
```

Each deploy uploads an immutable release, runs migrations, restarts the app and health-checks it. A release that does not come up healthy is rolled back before the command exits, migrations included.

One deploy runs per target at a time. A second one started from another machine — CI and a laptop, say — waits for the first to finish (up to `--lock-wait` seconds, 300 by default; `0` gives up at once), and a release that is older than the one already live is dropped rather than put back in front of it. Release ids are stamped from the server's clock so every machine agrees on which is newer.

If any of your pages prerender from data, add `--remote-db` so the build renders against the database it is being deployed to, over the same SSH connection. Without it, a build on a fresh machine renders those pages against an empty database and bakes the defaults into your static HTML.

```sh
vela status          # what is running, on which release
vela logs -f         # journald, tailed
vela rollback        # previous release, with its down migrations
```

`vela destroy deployment -t staging` removes a copy from its server. Its database and uploads stay behind unless you pass `--purge`, which snapshots them into `/var/lib/vela/trash` on the server (kept two weeks) before deleting. Removing production, or purging anything but a preview, asks you to type the app's name; from a script, pass `--confirm <app-name>` — `--yes` alone is not accepted for either.

These default to `production`; `vela env` and `vela admin` default to `local`,
because that is the copy you are usually standing in.

Same thing from CI with [`velastack/action`](https://github.com/velastack/action).

## Already have a project?

```sh
vela enable backend   # just PocketBase and the server test harness
vela bless            # the full upgrade: Tailwind, shadcn-svelte, vela's layout and routes, the backend
```

Both work in place on a vanilla SvelteKit project. A project that is already deployed
keeps deploying to the same instance, now with a database.

Much of `vela` needs neither. In a plain `npx sv create` project, with no setup:

- `vela generate schema` and `vela generate form`, the form in plain HTML
- `vela enable i18n`, `ai`, `analytics`, `content-negotiation` and `cms`
- `vela legal` and `vela routes`
- `vela deploy`, `env`, `status`, `logs` and `rollback`

`vela ui`, `vela enable blog`, `vela enable auth` and what builds on it, and
`vela generate scaffold` write shadcn-svelte markup. Without it they refuse before
changing anything and name the setup: `npx sv add tailwindcss`, then
`npx shadcn-svelte@latest init`.

## It stays your code

Generated files are yours to edit — no framework wrapping your app, no magic you can't read. Each project pins the CLI version it was created with, so builds match across your team and in CI no matter what's installed on any one machine.

## Requirements

Node 20.19+ or 22.12+. That's it.

## Docs

Full documentation, every command and flag: [docs.velastack.dev](https://docs.velastack.dev)

## License

MIT
