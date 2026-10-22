# Ecommerce: implementation plan

Companion to `plans/ecommerce.md`, which says what we are building and why. This document is
how: the order of pull requests across `velastack-patterns` and `velastack-cli`, the files each
one touches, its tests, and when it is done.

**Status (2026-10-22): Phase 1 shipped.** PRs #1–#8 landed as one patterns release (0.5.0, velastack/patterns#29), one
CLI release (0.16.0, velastack/vela#49 and #51) and the docs (velastack/velastack#73). The 0.4.4 step was skipped: the
patterns work went on a single branch. Phases 2 and 3 are outlined in §11.

Written 2026-10-20. Paths under `src/` belong to the repo the PR is in. `patterns:` and `cli:`
prefix paths when it is ambiguous.

---

## 1. Sequencing

The CLI depends on `@velastack/patterns` `^0.4.2`, which on 0.x means `>=0.4.2 <0.5.0`. Two rules
follow:

- **Patterns always publishes first.** `Slug` and `bySlug` are typed from the registry, so the
  CLI cannot type-check against a slug or field that is not published yet.
- **Changing pattern inputs is a breaking change.** Today's CLI sends
  `stripeSecretKey`/`stripePriceId`. A 0.4.x patterns release that renamed those inputs would
  break `vela enable payments` for every installed CLI. The payments restructure therefore
  ships as `0.5.0`, and the CLI bumps its range in the same pass.

| #   | Repo     | PR                                               | Release          | Depends on |
| --- | -------- | ------------------------------------------------ | ---------------- | ---------- |
| 1   | patterns | Provider composition: types, detection, requires | 0.4.4 (additive) | none       |
| 2   | patterns | `requires` audit fixes                           | 0.4.4 (with #1)  | none       |
| 3   | cli      | Detect providers, enforce `requires`             | next patch       | #1, #2     |
| 4   | patterns | Payments as a provider pattern, plus Shopify     | 0.5.0            | #1         |
| 5   | cli      | `enable payments` on the generic provider flow   | next minor       | #3, #4     |
| 6   | patterns | `enable-ecommerce` / `disable-ecommerce` Phase 1 | 0.5.1            | #4         |
| 7   | cli      | `vela enable/disable ecommerce`                  | next patch       | #5, #6     |
| 8   | docs     | `/enable/ecommerce`, payments, subscriptions     | with #7          | #6         |

PRs #1–#3 are worth merging even if ecommerce stops there. They close the hole where
subscriptions runs without payments, and they let the disable patterns know which provider was
used.

**Integration CI** applies patterns from the checkout and takes only `vela create` and
`test:server` from the published CLI (`vela@latest`). The patterns PRs therefore do not wait on
CLI releases. The exception is any new CLI behaviour a case depends on, and none does here.

---

## 2. PR #1 (patterns): provider composition

Additive only. Every new field is optional, because a required one would break the
`satisfies Pattern` check on all 42 `index.ts` files.

### Types (`src/core/types.ts`)

```ts
export type ProviderMarker = { env: string } | { path: string } | { dependency: string };

export interface ProviderEnvVar {
	// ...existing
	/** The CLI refuses a blank value; the pattern still writes whatever it is given. */
	required?: boolean;
}

export interface Provider {
	id: string;
	label: string;
	env?: ProviderEnvVar[];
	/** Any one present means this provider is in use. Defaults to `[{ env: env[0].key }]`. */
	markers?: ProviderMarker[];
	/** Prerequisites when this provider is chosen, merged over the pattern's `requires`. */
	requires?: Partial<Requires>;
}

export interface Requires extends Features {
	/** Capability → provider ids that satisfy the pattern: `{ payments: ["stripe"] }`. */
	providers?: Partial<Record<string, string[]>>;
}

export interface Pattern {
	// ...existing
	requires: Requires; // was Features; every existing literal still satisfies it
	/** Take the provider already detected for this capability instead of asking for one. */
	inheritsProvider?: string;
}

export interface Options {
	// ...existing
	/** The provider in use per capability, from `detectProviders`. Absent in preview. */
	providers?: Partial<Record<string, string>>;
}
```

### Reading `src/env.ts` (`src/runtime/env-vars.ts`)

Export `readEnvVarNames(root): Set<string>`. It is built from the module-private
`locateVariables` and `declaredNames`, plus `findEnvDecl` and `newProject()`. It returns an
empty set when there is no `src/env.ts`, or when the declaration is in a shape `declaredNames`
reports as unsupported.

The CLI's own `cli:src/lib/static-env.ts` parses the same file, but only for `static: true`
entries. It stays as it is.

### Detection (`src/runtime/providers.ts`, new, node-only)

```ts
export interface DetectedProviders {
	/** `{ payments: "stripe", analytics: "plausible" }` */
	providers: Record<string, string>;
	/** Capabilities where more than one provider's markers are present. */
	ambiguous: { capability: string; ids: string[] }[];
}
export function detectProviders(
	root: string,
	patterns: readonly Pick<Pattern, 'slug' | 'providers' | 'inheritsProvider'>[]
): DetectedProviders;
```

- It walks the `patterns` it is given that declare `providers` and do not set
  `inheritsProvider`. The capability comes from `capabilityName(slug)`.
- The registry is passed in rather than imported, because importing it would make
  `src/index.ts` and the runtime module import each other.
- The default marker for a provider is `{ env: env[0].key }`. A provider with no env and no
  `markers` is a registration error, enforced by a unit test over `patterns`.
- `env` is checked against `readEnvVarNames`, `path` with `existsSync`, and `dependency`
  against `dependencies`/`devDependencies`.

### Exports (`src/index.ts`)

- `detectProviders(root)`, lazily loaded from `./runtime/providers`, which calls
  `run(root, patterns)`. This copies the `installComponents` shape at `index.ts:193`.
- `export type { DetectedProviders, ProviderMarker, Requires }`.
- `unmetRequirements` (below). It is pure, so it is exported directly.

### Requirement checks (`src/core/requires.ts`, new, browser-safe)

```ts
export type Unmet =
	| { kind: 'feature'; feature: keyof Features }
	| { kind: 'provider'; capability: string; want: string[]; have: string | null }
	| { kind: 'ambiguous'; capability: string; ids: string[] };

export function unmetRequirements(
	pattern: Pick<Pattern, 'requires' | 'providers' | 'inheritsProvider' | 'slug'>,
	context: { features: Features; providers: DetectedProviders; provider?: string }
): Unmet[];
```

- Only `true` boolean flags count. The meaning of `false` is "not needed", and §3 confirms that
  no pattern uses it to mean "must be absent".
- `ui` keeps its current CLI check and is skipped here.
- The provider's own `requires` is merged in when `context.provider` is known.
- The CLI (PR #3) and the integration harness both call this, so the two cannot disagree.

### Inheritance (`src/core/providers.ts` `resolveProvider`)

`resolveProvider` gains `options.providers` (`Pick<Options, "input" | "argv" | "env" | "providers">`).
For a pattern with `inheritsProvider`:

1. Look up `options.providers?.[inheritsProvider]`. If there is a detected id, use it.
   `input.provider` or `--provider` may repeat it; a different id is an `InvalidArgumentError`
   naming the detected one.
2. If the detected id is not in the pattern's own `providers`, raise an
   `InvalidArgumentError` ("ecommerce does not support <label> payments yet").
3. If nothing is detected, a runtime call throws `Run \`vela enable <capability>\` first.`and a
preview call falls back to`providers[0]`, as today.

### Integration harness

- `integration/features.ts` gains `detectProviders(root)`, a re-export of the package
  function, not a mirror. The comment block says why providers are not mirrored.
- `integration/apply.ts` passes `providers` into `generate` next to `features` at lines 158,
  173, 208 and 237. `scripts/demo.ts:105` does the same.

### Tests

- `src/core/providers.test.ts`:
  - Inheritance: detected id used, matching flag accepted, mismatching flag rejected, detected
    id unknown to the pattern, nothing detected at runtime, nothing detected in preview.
  - Coverage that is missing today: `providerEnvEdits`, `suppliedProviderEnv`,
    `allProviderPaths`.
- `src/core/requires.test.ts`: true flags, false ignored, provider lists, a provider's own
  `requires` merged, ambiguity.
- `src/runtime/providers.test.ts` (tmpdir fixtures): env marker, path marker, dependency marker,
  no `src/env.ts`, two providers present (ambiguous), inheriting patterns skipped.
- `src/runtime/env-vars.test.ts`: `readEnvVarNames` over the shapes `locateVariables` handles.
- A registry test: every provider resolves to at least one marker, and marker sets do not
  collide within a capability.

**Done when** lint, unit tests and the `enable` / `disable` integration suites pass with no
behaviour change, and analytics and ai projects report their provider through
`detectProviders`.

---

## 3. PR #2 (patterns): `requires` audit

The CLI starts enforcing every `true` flag in PR #3, so each declaration has to be true first.
Fixes land with PR #1 in 0.4.4.

The audit (2026-10-20) covered all 42 patterns, compared each `true` flag against what the
generated code actually imports, and checked every case in `integration/cases.ts`.

**`false` means "not required", never "must be absent".** The ten core flags are mandatory in
the `Features` type, so every pattern spells them out. The cases confirm it: enable-ai
(`auth: false`) runs on the auth baseline, generate-scaffold (`teams: false`) runs with teams
on, and kitchen-sink applies enable-i18n after auth, api, apiKeys and teams are all on.
Enforcement checks `true` only, treats `undefined` as not required, and leaves `ui` on its own
path (it is a string, so a generic truthy loop would pass `"plain"`).

**No integration case applies a pattern without its declared prerequisites.** `singleCase` and
`inverseCase` already chain every truthy requirement, so enforcement breaks no case.

### Changes

| Pattern               | Change                                            | Why                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --------------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| enable-api-keys       | drop `api: true`                                  | `api` detection reads true whenever `src/routes/api` has anything in it, and enable-ai, enable-payments and local enable-cms all write there. Its hooks edit turns the API on itself anyway.                                                                                                                                                                                                                          |
| disable-api-keys      | drop `api`, `auth`                                | Dead end: disable-api first leaves `api` false, and disable-api-keys is then refused forever. A disable pattern requires only its own feature, plus `backend` when it drops collections.                                                                                                                                                                                                                              |
| disable-teams         | drop `auth`                                       | same rule                                                                                                                                                                                                                                                                                                                                                                                                             |
| disable-subscriptions | drop `auth`                                       | same rule                                                                                                                                                                                                                                                                                                                                                                                                             |
| disable-notifications | drop `auth`                                       | same rule. There is no notifications flag, so it keeps `backend` only.                                                                                                                                                                                                                                                                                                                                                |
| enable-subscriptions  | own check for `src/lib/server/stripe-customer.ts` | It needs payments enabled **in app mode** (`stripe_customers`, `(app)/billing`), and no flag says that. Payments, then auth, then subscriptions passes every flag and fails on the billing edits. Refuse with: payments has to be re-enabled now that auth is on (`vela disable payments`, then `vela enable payments`). disable-payments drops the catalog collections, which the sync workflow refills from Stripe. |
| disable-whatsapp      | none yet                                          | It should require `whatsapp: true`, but the CLI's `Features` has no `whatsapp` and the CLI has no whatsapp commands. That is a separate change.                                                                                                                                                                                                                                                                       |

### Harness changes (also in this PR)

- `integration/apply.ts` calls `unmetRequirements` (from PR #1) before each step, and fails the
  step with a new `requires` error kind. The suite then fails wherever the CLI would refuse.
- `inverseCase("disable-notifications")` runs `enable-notifications` first. Today it never does.
- `scripts/demo.ts:103–111` ORs `requires` into the detected features. That hides exactly what
  enforcement catches. Replace it with a warning that lists `unmetRequirements`.

### Found, not fixed here

- **A disable pattern does not check whether another feature depends on it.** disable-backend
  with auth on, disable-auth with teams on, and disable-payments with subscriptions on all run
  and break the project. disable-payments also leaves the subscription handlers under
  `webhooks/stripe`, which keeps the payments marker present. This needs a new `blockedBy`
  field, not `requires: false`. It is a follow-up.
- **`auth` detection is `(app)` existing.** A generator run with `--route "(app)/x"` in a project
  without auth makes auth read true, and leftovers after disable-auth keep it true.
- **enable-backend does not install the workflow runtime**, though disable-backend removes it.
  Static, bare and pre-0.13 projects lack `workflows`, so enable-payments (Stripe) is correctly
  refused. The remedy in the error has to say `vela enable workflows`, and enable-backend's
  next steps should mention it.
- **There is no `server` feature.** enable-ai and local enable-cms enforce adapter-node
  themselves.

---

## 4. PR #3 (cli): detect providers, enforce `requires`

### Workspace (`src/lib/workspace.ts`)

- `Workspace` gains `providers: DetectedProviders`. `getWorkspace` calls
  `detectProviders(workspaceRootDir)`, which is async because of the lazy import. `getWorkspace`
  is already async.
- `getWorkspace` does not throw on ambiguity, because 35 callers only want the root. The runner
  decides whether an ambiguity matters.
- `isPaymentsMode` stays until PR #5, then goes. Nothing outside `workspace.ts` reads it.

### Runner (`src/lib/pattern-runner.ts`)

- After the `requires.ui` block (l.71–73) and before `p.taskLog` (l.75), call
  `assertRequires(label, pattern, input.provider, features, providers)`. Nothing has been
  written at that point.
- Hoist the label expression that is currently written out twice (l.66, l.72) into one `const`.
- **Check before prompting.** `vela enable payments` asks for keys, and `enable ai` resolves its
  provider, before `runPattern` is called. A refusal after the user typed a secret key is a bad
  experience. Export `assertPatternRequires(slug, provider?)` from `require-features.ts` so a
  command can call it right after resolving the provider and before any env prompt. PR #5 and
  PR #7 do this for payments and ecommerce. (`enable ai` has no `true` requirements, so it
  needs nothing.) The runner keeps its own check as the backstop for every other command.
- Pass `providers: providers.providers` into `pattern.generate`.

### `src/lib/require-features.ts` (new)

`assertRequires` calls `unmetRequirements` and throws in the `assertShadcn` shape: the command in
backticks, what it needs, "Nothing was changed.", numbered steps, "Then run this again." The
remedy comes from a feature → command table:

| Unmet              | Remedy                                                                                         |
| ------------------ | ---------------------------------------------------------------------------------------------- |
| `auth`             | `vela enable auth`                                                                             |
| `backend`          | `vela enable backend`                                                                          |
| `payments`         | `vela enable payments`                                                                         |
| `workflows`        | `vela enable workflows`                                                                        |
| `teams`, `i18n`, … | `vela enable <feature>`                                                                        |
| provider           | "needs Stripe payments; this project uses Shopify." (no remedy; switching is disable → enable) |
| ambiguous          | names both providers' markers and asks the user to remove one                                  |

### Inheritance (`src/lib/providers.ts`)

- `resolveProvider(slug, flagValue, detected)`: for a pattern with `inheritsProvider`, it returns
  the detected provider and validates the flag, with the same rules as the patterns-side
  function. It never prompts.
- `decideProvider` gains a `detected?: string` input, so the rule is unit-testable.

### Tests

- `src/lib/pattern-runner.test.ts`: `enable-subscriptions` in a tmpdir project with auth and a
  backend but no payments is refused, and nothing is written. Copy the Kit 2 test's shape.
- `src/lib/require-features.test.ts`: the message for each `Unmet` kind.
- `src/lib/providers.test.ts`: the inheritance cases.
- `src/lib/workspace.test.ts`: `getWorkspace().providers` on a project with Plausible declared.

**Done when** every `vela enable *` that worked before still works on a project that meets its
`requires`, and `vela enable subscriptions` without payments exits non-zero with the remedy.

---

## 5. PR #4 (patterns): payments as a provider pattern, plus Shopify (0.5.0)

### Layout

| Today                               | After                                        |
| ----------------------------------- | -------------------------------------------- |
| `enable/payments/creates/`          | `enable/payments/providers/stripe/`          |
| `enable/payments/creates-app-mode/` | `enable/payments/providers-app-mode/stripe/` |
| (none)                              | `enable/payments/providers/shopify/`         |
| `enable/payments/preview-modifies/` | `enable/payments/preview-modifies/<id>/`     |

- **The app-mode tree is a sibling root, not a subdirectory of `providers/stripe/`.**
  `allProviderPaths` takes everything after `providers/<id>/` as an app path, so a nested
  `app-mode/` would leak into it. `providerCreates(raw, id, root = "./providers/")` gains the
  root parameter, and `allProviderPaths` learns the `providers-app-mode` root.
- `providers-app-mode/` is a new template directory name. Add it to the hand-kept `exclude`
  lists in `tsconfig.json` and in the `vite.config.ts` dts plugin, or tsc type-checks the
  templates. Also add it to the shipped-directory regex in `src/patterns/app-name-source.test.ts`.

### `generate.ts` / `index.ts`

`PROVIDERS` is declared in `generate.ts`, as analytics does:

```ts
{
	id: "stripe", label: "Stripe",
	env: [
		{ key: "STRIPE_SECRET_KEY", label: "Stripe secret key", placeholder: "sk_...", secret: true, required: true },
		{ key: "PUBLIC_STRIPE_PUBLISHABLE_KEY", label: "Stripe publishable key", placeholder: "pk_...", public: true, required: true },
		{ key: "STRIPE_WEBHOOK_SECRET", label: "Stripe webhook signing secret", placeholder: "whsec_...", secret: true, required: true },
	],
	markers: [{ env: "STRIPE_SECRET_KEY" }, { path: "src/routes/webhooks/stripe" }],
	requires: { backend: true, workflows: true },
},
{
	id: "shopify", label: "Shopify",
	env: [
		{ key: "PUBLIC_SHOPIFY_STORE_DOMAIN", label: "Shopify store domain", placeholder: "your-store.myshopify.com", public: true, required: true },
		{ key: "PUBLIC_SHOPIFY_STOREFRONT_TOKEN", label: "Storefront API public access token", public: true, required: true },
	],
},
```

- The pattern's `requires` drops `backend` and `workflows`, which move to the Stripe provider,
  and keeps `ui: "shadcn"`.
- Version `2.0.0`. `providers: PROVIDERS`. `command.raw` is
  `vela enable payments --provider stripe`. Add an example per provider.
- Components and packages are chosen per provider:
  - Stripe keeps today's lists.
  - Shopify gets `["button"]` and `@shopify/storefront-api-client`, Shopify's own client, as
    Stripe gets `stripe`.

### `generate.runtime.ts`

Split into `runtime/setup-stripe.ts` and `runtime/setup-shopify.ts`. The shared top level does
three things:

- `.env` through `providerEnvEdits(provider, \`${label} credentials\`, suppliedProviderEnv(options))`.
  This replaces the hand-built Stripe edits.
- `src/env.ts` through `modifyEnvVarsFiles(root, providerEnvVars(provider))`.
- A switch on `provider.id`.

**Stripe setup** is today's code with no change in behaviour: collections, the customer sync,
the product/price, seeds, the demo page, and the nav-user and signup modifiers. Inputs move:

| Before                 | After                                       |
| ---------------------- | ------------------------------------------- |
| `stripeSecretKey`      | `providerEnv.STRIPE_SECRET_KEY`             |
| `stripePublishableKey` | `providerEnv.PUBLIC_STRIPE_PUBLISHABLE_KEY` |
| `stripeWebhookSecret`  | `providerEnv.STRIPE_WEBHOOK_SECRET`         |
| `stripePriceId`        | `demoId`                                    |

`runtime/env-vars.ts` and its `STRIPE_ENV_VARS` go away, replaced by `providerEnvVars`. Remove
the second copy of the collection specs in `runtime/collections.ts` (used by preview) by
importing the runtime specs from one module.

**Shopify setup** has three parts:

- `providers/shopify/src/lib/shopify.ts`:
  - `storefront()` returns a `createStorefrontApiClient({ storeDomain, apiVersion, publicAccessToken })`,
    created on first call. A module-scope client would throw during a prerender with an empty
    `.env`, and the README requires that build to pass.
  - `SHOPIFY_API_VERSION` as one constant. Pin the newest stable version when this is built.
    The release notes list `2026-07` as stable and `2026-10` as a release candidate; confirm
    whether `2026-10` has gone stable.
  - `PUBLIC_SHOPIFY_*` read from `$app/env/public`.
  - A blank env makes `storefront()` throw a clear "set PUBLIC_SHOPIFY_STORE_DOMAIN" error, at
    the call site rather than on import.
- `providers/shopify/src/lib/components/payments/buy-button.svelte`: `cartCreate` with one line,
  then `location.assign(checkoutUrl)`.
- A demo page `(public)/payment/+page.svelte` with `<BuyButton variantId={demoId} />` when
  `demoId` is given.

There are no collections, no webhook and no PocketBase, so it runs on the `static` template.

### Preview

`generate.preview.ts` resolves the provider (preview falls back to Stripe) and merges
`preview-modifies/<id>/**` via `filesUnderPrefix`. The env and `src/env.ts` previews are built
from `providerEnvEdits` / `envVarsFile(providerEnvVars(...))`, as analytics does.

### disable-payments

- `requires: { payments: true }`. `backend` moves to the Stripe-only branch.
- **Stop choosing app mode from `features.auth`.** Today it picks the app-mode file set from the
  current auth state. Turning auth on or off between enable and disable leaves files behind or
  plans drops for collections that do not exist. No disk check is needed instead: missing
  delete paths are already skipped, and `CollectionDropSpec` carries `exists`. So plan both file
  sets and every Stripe collection drop unconditionally.
- Provider: `options.providers?.payments`. If none is detected, it falls back to removing every
  provider's files and env, which is today's behaviour, now explicit.
- **Stripe** deletes `providers/stripe` and `providers-app-mode/stripe`. It unmodifies nav-user
  and signup (both already no-op when unmodified), drops collections, and removes env.
- **Shopify** deletes `providers/shopify` and the demo page, and removes the env. It does not
  touch PocketBase.

### Subscriptions

`enable-subscriptions` and `disable-subscriptions` declare `requires.providers: { payments: ["stripe"] }`.
Their code is unchanged.

### Integration

- `integration/apply.ts` `defaultInput("enable-payments")` sends
  `{ provider, providerEnv: { STRIPE_*: … }, demoId }` for Stripe and
  `{ provider: "shopify", providerEnv: { PUBLIC_SHOPIFY_STORE_DOMAIN: "integration.myshopify.com", PUBLIC_SHOPIFY_STOREFRONT_TOKEN: "integration" } }`
  for Shopify.
- `integration/cases.ts`:
  - Every existing `enable-payments` step gains `input: { provider: "stripe" }`.
  - Stripe gating moves from `STRIPE_SLUGS` to a step predicate: `enable-payments` with
    provider `stripe`, plus the subscriptions slugs.
  - New cases: `payments-shopify` on `minimal` and on `static`, and `payments-shopify-lifecycle`
    (enable → disable).
  - `coverage.test.ts` then sees both providers.
  - **Prerequisite chaining becomes provider-aware.** `prereqChain`, `singleCase` and
    `inverseCase` walk `bySlug[slug].requires`. Once `backend` and `workflows` move onto the
    Stripe provider, they see no backend requirement on `enable-payments`. On `minimal` that is
    hidden, because the baseline has both. They and the `unmetRequirements` call in `apply.ts`
    take the step's `input.provider` and merge `provider.requires`.
- `integration/features.ts`: `payments` detection becomes
  `detectProviders(root).providers.payments !== undefined`, and the matching change goes in the
  CLI in PR #5.

### Tests

- Move the existing modifier fixtures unchanged.
- `generate.test.ts`: per-provider creates, components and packages, app-mode creates only for
  Stripe, and the preview fallback.
- disable-payments: a Shopify project leaves PocketBase alone, and an undetected provider
  removes everything.

**Done when** `payments-*` integration cases pass for both providers, and the Stripe cases are
byte-for-byte the same output as 0.4.x apart from `.env` comment wording.

---

## 6. PR #5 (cli): `enable payments` on the generic flow

- `src/commands/enable/payments.ts`:
  - Drop the local `PROVIDERS` / `resolveProvider` and the `'stripe'` default on `--provider`.
    Use `resolveProvider('enable-payments', opts.provider)`, then
    `assertPatternRequires('enable-payments', provider.id)` before any prompt, so a static
    project asking for Stripe is refused before typing keys.
  - Before `collectProviderEnv`, show Stripe's webhook-secret note (moved from
    `ensureWebhookSecret`).
  - After it, ask for the demo id: a price id for Stripe ("blank creates a demo product") or a
    variant GID for Shopify (blank means no demo page).
  - Input: `{ provider, providerEnv, demoId }`. Next steps per provider.
- `src/lib/providers.ts` `collectProviderEnv` honours `required`:
  - On a terminal, it validates non-empty, like `promptPassword` does today.
  - Off a terminal, a missing required key is an error naming it. Today's command prompts even
    without a TTY, so this is a fix.
- **Backend gate.** The `preAction` hook in `src/program.ts` (l.126–171) refuses any command not
  in `NO_BACKEND_COMMMANDS` when there is no backend. It runs before the action, so before the
  provider is known.
  - Move its two checks (backend present, superuser credentials) into
    `src/lib/backend-gate.ts` `assertBackendReady(commandPath)`. `preAction` calls it.
  - Add a `PROVIDER_GATED_COMMANDS` set (`enable payments`, `disable payments`, and in PR #7
    `enable ecommerce` / `disable ecommerce`) that `preAction` skips.
  - These commands call `assertBackendReady` themselves once the provider's merged `requires`
    says `backend`.
- `checkProviderInput`: delete the payments exception and its test (`providers.test.ts`
  l.122–123).
- `src/lib/workspace.ts`: `features.payments` comes from `providers.payments`, and
  `isPaymentsMode` is deleted.
- `src/commands/disable/payments.ts`: the confirm message names the detected provider (Shopify:
  "Removes the Shopify client, demo page and env. Your Shopify store is untouched.").
- `src/commands/enable/subscriptions.ts`: description "(requires auth and Stripe payments)".
- `package.json`: `@velastack/patterns` `^0.5.0`.
- `src/program.test.ts`: the backend-gate `test.each` cases for the new set, and a `--provider`
  parse test for payments (copy analytics' at l.370).

**Done when** `vela enable payments --provider shopify` works in a `static` project with no
PocketBase, and `--provider stripe` behaves as today, including the no-backend refusal.

---

## 7. PR #6 (patterns): `enable-ecommerce` Phase 1

The design is in `ecommerce.md` → "Phase 1: the cart". These are the implementation specifics
it leaves open.

**Review rule for every template in this PR.** Would it exist if the project only ever had this
one provider? The Stripe templates should read like Stripe's Checkout guide ported to
SvelteKit, and the Shopify ones like Shopify's headless cart guide, with no shared types, no
adapter, and no provider names in stored data. The only shared template is `cart-button.svelte`.

### Registration

- `src/patterns/enable/ecommerce/` with `index.ts`, `generate.ts`, `generate.runtime.ts`,
  `generate.preview.ts`, `creates/`, `providers/{stripe,shopify}/`, `modifies/`, and
  `preview-modifies/`.
- Add it to the imports and the `patterns` array in `src/index.ts`. `category: "payments"`.
- Metadata: `inheritsProvider: "payments"`, `providers` with ids `stripe` and `shopify`, and no
  `env` (payments wrote it). `requires: { payments: true, ui: "shadcn" }`, `plan: "pro"`.
- Inheriting providers have no markers of their own, so they are exempt from the registry
  marker test from PR #1.

### Generate

- `generate.ts`:
  - Creates are shared plus `providerCreates(raw, id)`.
  - Components: `["sheet", "button", "badge", "separator"]`. Packages: none.
  - `input.demoId`, when given, adds a `(public)/shop` page with one `<AddToCart>`:
    - Stripe: `+page.svelte` plus `+page.server.ts`, which loads the price and product name from
      `stripe_prices` / `stripe_products` through `locals.admin`, as the billing page does.
    - Shopify: `+page.svelte` with the variant GID inline.
- `generate.runtime.ts`: the root-layout modifier only. There is no env and there are no
  collections.

### Kit 3 and repo rules the templates must follow

- `browser` from `$app/env` (`kit3-guard.test.ts`).
- `#lib/...` with extensions: `#lib/cart.svelte.js`, `#lib/shopify.js`.
- No `meta.appName` (`app-name-source.test.ts`).
- Public env from `$app/env/public`.

### Navbar modifier (`modifies/root-layout.svelte.ts`)

- `SvelteFile.fromPath`. If there is no `Navbar.List`, return `failed` with a snippet. If
  `CartButton` is present already, return unchanged.
- `ensureImports` for `CartButton` from `#lib/components/cart/cart-button.svelte`.
- Insert `<Navbar.Item><CartButton /></Navbar.Item>` before the Navbar.Item that holds
  `AuthMenu.Root` when there is one, so the cart sits left of the account menu. Otherwise insert
  before the closing `Navbar.List`.
- **New `SvelteFile` helpers (`src/runtime/svelte-file.ts`).** `findElement` matches the first
  element by name, so it cannot target a specific `Navbar.Item`. Add
  `findElementContaining(outer, inner)`, `insertBeforeElement(node, content)` and
  `removeElementContaining(outer, inner)`, with tests. Today it has only
  `insertBeforeClosingTag` / `insertBeforeChildren`.
  - The disable side uses `removeElementContaining("Navbar.Item", "CartButton")`, which removes
    the whole item.
  - The same helper fixes the open `disable-auth` bug, which leaves an empty `Navbar.Item`.
    Switch `disable/auth/modifies/root-layout.svelte.ts` to it in this PR and update its
    `legacy-root-layout.svelte` expectation.
- Fixtures under `modifies/fixtures/{original,expect}/`:
  - `basic-layout.svelte` (the vela template)
  - `auth-layout.svelte` (the cart goes before AuthMenu)
  - `spaces-layout.svelte`
  - `applied-layout.svelte` (no-op)
  - `no-navbar-layout.svelte` (failed)

### Stripe routes

These run under the generated project's `vela test:server`, with the same Stripe test-mode
gating as payments' `payment-intent/server.test.ts`.

- `(public)/cart/+page.server.ts`, `actions.checkout`:
  - Reads the `items` form field as `[{ price, quantity }]` JSON, at most 100 entries, each
    quantity 1–99. Anything else is `fail(400)`.
  - `stripe.checkout.sessions.create(...)` as specified in `ecommerce.md`, then
    `redirect(303, session.url)`. A `Stripe.errors.StripeError` becomes
    `fail(400, { message })`. Stripe already refuses inactive or recurring prices and mixed
    currencies, so the action does not re-check them.
  - In app mode it passes `customer` from `#lib/server/stripe-customer.js`. That version of the
    file lives under `providers-app-mode/stripe/`. `generate.runtime.ts` swaps it in when the
    helper exists on disk; `generate.ts` must stay node-free, so preview always shows the base
    file. Do not use `features.auth`: payments may have been enabled before auth, in which case
    the helper is missing.
  - The sheet posts to `/cart?/checkout` from any page with a plain `<form method="POST">`, so
    checkout works before hydration and without `use:enhance`.
- `(public)/checkout/success/+page.server.ts`:
  - `stripe.checkout.sessions.retrieve(session_id)`.
  - Returns `{ amountTotal, currency, status }`. An unknown id is a 404.

### Preview

Preview falls back to Stripe. `preview-modifies/src/routes/(public)/root-layout.svelte` shows
the navbar with the cart item.

### disable-ecommerce (`src/patterns/disable/ecommerce/`)

- `requires: { payments: true }`.
- Deletes the shared creates, `allProviderPaths(../../enable/ecommerce/providers/**)` and
  `providers-app-mode`, and the `(public)/shop` demo page.
- Unmodifies the root layout. It leaves the shadcn components installed, since other code may
  use them. disable-payments does the same.

### Integration

- `integration/cases.ts`:
  - `ecommerce-stripe` stacks `backend` → `payments(stripe)` → `ecommerce` on `minimal`, gated.
  - `ecommerce-shopify` stacks `payments(shopify)` → `ecommerce` on `static` and on `minimal`.
  - `ecommerce-auth-stripe` runs on the `auth` baseline, for the AuthMenu ordering and the
    app-mode customer.
  - `ecommerce-lifecycle` runs enable → disable → enable for each provider.
- `SLUG_TO_FEATURE`: none. Ecommerce is not a feature flag in v1, and no pattern requires it
  yet. Add one in Phase 2 if the catalog patterns need it.

**Done when** all ecommerce cases pass svelte-check, prettier, and `test:server` (Stripe).
Manually: add, change quantity, remove, check out with test card `4242…`, return to the success
page with an emptied cart; and on Shopify, add, check out, and land on Shopify's checkout.

---

## 8. PR #7 (cli): `vela enable/disable ecommerce`

- `src/commands/enable/ecommerce.ts`:
  - `--provider` is optional and must match the detected provider.
  - `resolveProvider('enable-ecommerce', opts.provider, workspace.providers)`.
  - `assertPatternRequires('enable-ecommerce', provider.id)`, then `assertBackendReady` for
    Stripe, then the optional demo id prompt.
  - Next steps:
    - Stripe: "visit /shop", "Stripe Checkout uses your dashboard's payment methods".
    - Shopify: "products and checkout settings live in Shopify admin".
- `src/commands/disable/ecommerce.ts` through `runDisable`.
- Register both in `src/commands/enable.ts` and `src/commands/disable.ts`. Add both to
  `PROVIDER_GATED_COMMANDS`. Update `EXPECTED_ENABLE_SUBCOMMANDS` /
  `EXPECTED_DISABLE_SUBCOMMANDS` in `src/program.test.ts`.
- `README.md`:
  - l.18 feature list.
  - l.148: works in a plain `sv create` project? No, because ecommerce requires shadcn.
  - l.152–155: add it to the shadcn list.

## 9. PR #8 (docs)

`~/Code/docs` holds bilingual `.svx` pages, with Spanish strings in `es.po` through wuchale.
Lint and svelte-check skip `.svx`, so run `npm run build` to validate.

- A new `/enable/ecommerce` and `/disable/ecommerce`.
- `/enable/payments` gains the provider choice and the Shopify setup (creating a Storefront
  token).
- `/enable/subscriptions` notes it is Stripe only.

---

## 10. Risks and open items

- **The Shopify API version.** Confirm whether `2026-10` is stable before pinning. A version
  ages out after roughly 12 months; requests to a retired version fall forward to the oldest
  supported one, which can change response shapes. `SHOPIFY_API_VERSION` is one constant so a
  bump is one line.
- **Shopify Storefront token setup.** The token comes from a Headless channel or custom app in
  Shopify admin. The docs page needs screenshots, and the CLI prompt needs a one-line hint.
- **Payments projects created before `src/env.ts`** rely on the `webhooks/stripe` path marker.
  Keep that marker until the Kit 3 migration has declared the Stripe env in every supported
  project.
- **Enforcement surprises.** §3 lists what the audit found. Anything it missed shows up as a
  refusal in a project that used to work. The error names the missing feature, so a report is
  easy to act on, but cut a patch release quickly if one lands.
- **Line attributes on Stripe** are out of v1, because Stripe has no per-line field for a
  catalog price. If a project needs them (an attendee name on a ticket), the native options
  are `custom_fields` on the session or `price_data` with product metadata. Decide in Phase 3,
  when the order webhook would read them.

---

## 11. Phases 2 and 3: PR outline

The design is in `ecommerce.md`. Same rules as Phase 1: patterns ship before the CLI that uses them, and every Stripe case
runs in CI now that the repo has Stripe secrets (§3's harness gate applies too).

| #   | Repo     | PR                                                                                                                           | Release  |
| --- | -------- | ---------------------------------------------------------------------------------------------------------------------------- | -------- |
| 9   | patterns | payments 2.1: catalog sync carries description, images, metadata, url, nickname, lookup_key                                  | 0.5.x    |
| 10  | patterns | ecommerce 1.1: `/shop` listing and product pages per provider; demo page and `demoId` go                                     | 0.6.0    |
| 11  | cli      | `vela enable ecommerce` drops the demo prompt                                                                                | patch    |
| 12  | patterns | `blockedBy` on patterns, checked by `unmetRequirements`' sibling; disable-payments / -ecommerce use it                       | with #13 |
| 13  | patterns | `ecommerce` feature, `enable-orders` / `disable-orders` (Stripe): webhook handlers, `orders` / `order_lines`, `(app)/orders` | 0.7.0    |
| 14  | cli      | `ecommerce` detection, `blockedBy` refusals, `vela enable/disable orders`                                                    | minor    |
| 15  | docs     | `/docs/enable/ecommerce` catalog section; `/docs/enable/orders`, `/docs/disable/orders`                                      | with #14 |

Notes:

- #9 is additive (new optional fields), so it can ship in a 0.5 patch. #10 removes an input (`demoId`), so it is 0.6.0.
- #12 is general, not commerce-specific. It also lets `disable-payments` refuse while subscriptions exist, an existing
  gap from §3's "Found, not fixed here".
- Shopify order mirroring (`webhooks/shopify`, HMAC) is not on this list; build it when a feature needs local Shopify
  orders.

---

## 12. Phase 1.5 (WhatsApp checkout): PR outline

The design is `ecommerce.md` "Phase 1.5". It ships before Phase 2 and does not depend on #9, so either can land first.
The order follows the dependencies: the new package, then the CMS, the hosted app, patterns, the CLI, the docs, and
the templates. While a dependency is unreleased, develop against a symlinked checkout, as in Phase 1, and bump the
range only after its release.

| #   | Repo      | PR                                                                                                                                                                     | Release  |
| --- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| W1  | whatsapp  | new repo `velastack/whatsapp`: `@velastack/whatsapp` with `whatsappHref`/`fillMessage` (moved), `orderRef`, `orderSubtotal`, `formatLines`, `formToken`, `recordOrder` | 0.1.0    |
| W2  | cms       | depend on W1 and re-export the moved helpers; headless `<CmsWhatsAppCart>`                                                                                             | minor    |
| W3  | velastack | `POST /v1/projects/:id/forms` (API key → `ensureTemplateForms`); the order view for `order` submissions; check the origin allowlist on link/deploy                     | deploy   |
| W4  | patterns  | payments `whatsapp` provider: `src/lib/order.ts`, `OrderButton` dialog, env + marker; disable-payments removes it                                                      | with W5  |
| W5  | patterns  | ecommerce `whatsapp` provider: cart store, sheet with customer fields and confirmation, `AddToCart`; no demo page                                                      | 0.5.x    |
| W6  | cli       | WhatsApp in `vela enable payments` (number prompt, form creation, `PUBLIC_WHATSAPP_ORDER_FORM`); skip the ecommerce demo prompt                                        | minor    |
| W7  | docs      | WhatsApp sections in `/docs/enable/payments` and `/docs/enable/ecommerce`; the hosted order view                                                                       | with W6  |
| W8  | templates | lift the `industries/README.md` cart rule (on-site payment stays banned); centeno: `order` form in `template.json`, `CmsWhatsAppCart`                                  | after W2 |

Notes:

- W1 is the only new repo. Copy the release setup from patterns (tag push → `release.yml`).
- W3 has to deploy before W6 is released, or the CLI's form creation 404s. The CLI handles a 404 the same way as
  an unlinked project (a next-steps note), so the order is a preference, not a hard dependency.
- Integration (W4/W5): WhatsApp on `static` and `minimal`, needing no secrets, and enable, disable, enable. With no
  hosted form configured, checkout only opens the chat, which is what CI exercises. W3's tests cover the recording.
- `detectProviders` picks up the new marker (`PUBLIC_WHATSAPP_NUMBER`) by itself. Check that
  `integration/features.ts` and the CLI agree, and that a project with Stripe and WhatsApp markers is refused as
  ambiguous.
