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
- **Auth, payments, teams, email, i18n** — one command each, generated into your project as code you own.
- **CRUD you didn't write.** `vela generate scaffold post title:text body:editor` gives you the model, schema, forms, and pages.
- **Describe it instead.** Pass `--ai "a blog post with tags and a cover image"` and review the collection it designs before anything is written.
- **shadcn-svelte components** on tap, and fixtures and seeds for realistic data while you work.

## The shape of a day

```sh
vela enable auth                                     # sign-in, sessions, OAuth scaffold
vela generate scaffold post title:text body:editor   # model, forms, list and detail pages
vela migrate up                                      # schema, versioned and in git
vela ui add button card dialog                       # shadcn-svelte components, into your project
vela ui add data-table multiselect                   # vela's own components, same command
```

Changed your mind? `vela destroy` and `vela disable` take it back out.

## Ship it

Deploys go to a server you own, over SSH. Prepare the box once, then deploy as often as you like.

```sh
vela provision root@your-server                        # Caddy, Node, PocketBase, systemd, TLS
vela deploy --server root@your-server --domain example.com
```

That first deploy binds `production` to the server, so nothing after it names a
machine again. Every command takes the same selector — `-t local`, `-t production`
(or `prod`), or any name you choose such as `-t staging`:

```sh
vela targets                       # what exists, and where
vela env import .env.production -t production
vela admin create -t production    # a login for the admin panel
```

Each deploy uploads an immutable release, runs migrations, restarts the app and health-checks it. A release that does not come up healthy is rolled back before the command exits.

If any of your pages prerender from data, add `--remote-db` so the build renders against the database it is being deployed to, over the same SSH connection. Without it, a build on a fresh machine renders those pages against an empty database and bakes the defaults into your static HTML.

```sh
vela status          # what is running, on which release
vela logs -f         # journald, tailed
vela rollback        # previous release, with its down migrations
```

These default to `production`; `vela env` and `vela admin` default to `local`,
because that is the copy you are usually standing in.

Same thing from CI with [`velastack/action`](https://github.com/velastack/action).

## Already have a project?

```sh
vela bless
```

Adds the backend and the rest of the setup to a vanilla SvelteKit project, in place.

## It stays your code

Generated files are yours to edit — no framework wrapping your app, no magic you can't read. Each project pins the CLI version it was created with, so builds match across your team and in CI no matter what's installed on any one machine.

## Requirements

Node 20.19+ or 22.12+. That's it.

## Docs

Full documentation, every command and flag: [docs.velastack.dev](https://docs.velastack.dev)

## License

MIT
