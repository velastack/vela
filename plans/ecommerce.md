# Ecommerce

A lightweight storefront layer for VelaStack projects: a cart, a checkout handoff, and later
a catalog and orders. The first providers are Stripe and Shopify. It is built on the payments
pattern, so this plan also settles how patterns that have providers compose, which nothing in
the registry has needed until now.

Only Phase 1 (the cart) is specified in detail. The later phases are an outline; each gets its
own plan before work starts.

Decided 2026-10-20: the provider-composition model, restructuring payments with a Shopify
provider, hosted Checkout for the Stripe cart, CLI enforcement of `requires`, and the Phase 1
cart design. Work lands in `velastack-patterns` (the pattern) and `velastack-cli` (detection,
the command, `requires` enforcement). The PR-by-PR breakdown is in `ecommerce-plan.md`.

## The problem

Today a provider is chosen once and then forgotten:

- **The choice is never recorded.** `disable-analytics` says it outright ("which one is not
  recorded anywhere") and deletes every provider's files to be safe.
- **Payments is a provider pattern in name only.** `vela enable payments` has its own
  `--provider stripe` option and a local `PROVIDERS` list in `src/commands/enable/payments.ts`.
  The pattern declares no `providers`, and `checkProviderInput` makes an exception for that case
  ("`enable payments` sends one for a pattern that declares none").
- **Detection assumes Stripe.** `features.payments` is
  `exists(src/routes/webhooks/stripe)` (`isPaymentsMode` in `workspace.ts`, copied in
  `integration/features.ts`).
- **`requires` is static booleans, and only `ui` is enforced.** `enable-subscriptions` is
  Stripe-only code that says `payments: true`. `pattern-runner.ts` checks nothing except
  `requires.ui`, so `vela enable subscriptions` runs on a project with no payments at all.

Ecommerce runs into all four. `ecommerce` on Stripe needs `payments` on Stripe, which needs a
backend and workflows. `ecommerce` on Shopify needs neither: the Storefront API takes a public
token and runs from the browser, so it works on the `static` template.

`env-model.md` sets the constraint: vela is zero-config, and there is no project config file.
So the chosen provider cannot be written down anywhere. It has to be detected from the project,
just as features are.

## Decisions: composing providers

### 1. A provider is a detected fact

Each `Provider` can be recognised from something only it leaves in the project:

```ts
type ProviderMarker =
	| { env: string } // declared in src/env.ts
	| { path: string } // app-relative file
	| { dependency: string }; // in package.json

interface Provider {
	id: string;
	label: string;
	env?: ProviderEnvVar[];
	/** Any one present means the provider is in use. Defaults to `[{ env: env[0].key }]`. */
	markers?: ProviderMarker[];
	/** Extra prerequisites when this provider is chosen, merged over the pattern's own `requires`. */
	requires?: Partial<Requires>;
}
```

A path alone is not enough. Analytics providers all write the same `analytics.svelte`, so
Plausible and PostHog differ only in their env declarations. The `src/env.ts` declaration is
the default because every provider with credentials already writes one (`modifyEnvVars`), and
`disable-*` already removes it. Analytics and ai need no new metadata. Stripe's markers are
`STRIPE_SECRET_KEY` and, for projects that enabled payments before `src/env.ts`, the old
`src/routes/webhooks/stripe` probe. Shopify's marker is `PUBLIC_SHOPIFY_STORE_DOMAIN`.

The CLI detects one id per capability and passes them in a new `Options.providers` map, next to
`features`:

```ts
interface Options {
	// ...
	/** The provider in use per capability, detected from each provider's `marker`. */
	providers?: Partial<Record<string, string>>; // { payments: "stripe", analytics: "plausible" }
}
```

Detection is generic and lives in `@velastack/patterns`, as a node-only
`detectProviders(root)` in a runtime module, loaded lazily the same way `installComponents()` is.
The provider metadata and the `src/env.ts` reader (`src/runtime/env-vars-file.ts`) are already
there. The CLI and `integration/features.ts` both call it, so for providers there is no mirror
to drift. The CLI's own `static-env.ts` parses `src/env.ts` too, but only for `static: true`
entries, and stays as it is. A pattern that inherits its provider (decision 2) is not probed,
which is why ecommerce's providers can write files at the same paths (`src/lib/cart.svelte.ts`).

`features.payments` stays a boolean ("some payments provider is present"), so the many
`requires: { payments: false }` literals keep working. If two markers for the same capability
are present, the project is ambiguous: the CLI refuses and names both markers.

On the website (`env: "preview"`) nothing is detected. An inherited provider falls back to the
first one declared, as `resolveProvider` already does, so ecommerce previews as Stripe. That is
intended.

The alternative was widening the feature itself (`payments: false | "stripe" | "shopify"`). That
touches every `requires` literal and every `features.payments` truthiness check, and it still
leaves analytics and ai without a home. A separate map is cheaper and covers every capability.

### 2. A dependent pattern inherits its dependency's provider

`enable-ecommerce` builds on `enable-payments`, so its provider is whatever payments uses. It
does not prompt. `--provider` is accepted only when it matches what was detected, and a mismatch
is an error that names the detected one. The same rule covers `subscriptions` (Stripe only) and
the later order and inventory patterns.

A pattern declares the inheritance:

```ts
// enable-ecommerce
providers: [stripe, shopify],
inheritsProvider: "payments",
```

`resolveProvider` (patterns) and `decideProvider` (CLI) check `options.providers[inheritsProvider]`
before reading `input.provider` or prompting. Each provider that ecommerce declares must exist
on payments, and a unit test enforces this.

### 3. `requires` can name a provider, and the CLI enforces it

```ts
type Requires = Features & {
	/** Capability → provider ids that satisfy this pattern. */
	providers?: Partial<Record<string, string[]>>;
};
```

- `enable-subscriptions`: `providers: { payments: ["stripe"] }`.
- `enable-ecommerce`: `payments: true`. Its Stripe provider adds nothing beyond what payments on
  Stripe already guarantees.
- `enable-payments`: `backend: false` on the pattern. The Stripe provider sets
  `requires: { backend: true, workflows: true }`; the Shopify provider sets nothing.

The CLI gains a generic `assertRequires(pattern, provider, features, providers)` in
`pattern-runner.ts`, next to the existing `requires.ui` check. It runs after the provider is
resolved and before `generate`. A failure names the command to run first
(`Run \`vela enable payments\` first.`). The CLI does not chain into that command, because
payments prompts for secrets.

Turning enforcement on is a behaviour change for every pattern, not just these. Before shipping,
audit each pattern's `requires` against reality. `true` values that are aspirational would
start blocking.

### 4. Payments becomes a real provider pattern, and gains Shopify

This is what "on top of payments" costs. `enable-payments` moves to the same layout as
analytics:

| Today                                  | After                                                                                   |
| -------------------------------------- | --------------------------------------------------------------------------------------- |
| `creates/`, `creates-app-mode/`        | `providers/stripe/`, `providers-app-mode/stripe/`                                       |
| CLI-side `PROVIDERS` + bespoke prompts | `providers: [stripe, shopify]` on the pattern; `resolveProvider` + `collectProviderEnv` |
| `isPaymentsMode` = `webhooks/stripe`   | provider env marker (`STRIPE_SECRET_KEY`, `PUBLIC_SHOPIFY_STORE_DOMAIN`)                |

The Stripe provider keeps its interactive steps (webhook secret note, demo price), but as
provider-specific prompts after the generic ones, not as a separate command. The
`checkProviderInput` exception for payments goes away. `collectProviderEnv` allows blank values,
but payments' `ensureKey` refuses them, so `ProviderEnvVar` gains `required?: boolean`. Without
it, `STRIPE_SECRET_KEY` would quietly become optional.

**Payments on Shopify** is small: a Storefront client (`src/lib/shopify.ts`, env
`PUBLIC_SHOPIFY_STORE_DOMAIN` and `PUBLIC_SHOPIFY_STOREFRONT_TOKEN`, both `public: true`) and a
`BuyButton` that creates a one-line cart and redirects to its `checkoutUrl`. That mirrors
`PaymentButton` on Stripe. It needs no backend, collections, or webhook.

**Rejected alternative:** leave payments alone, and make Shopify a provider of `ecommerce`
only, with ecommerce requiring payments just for Stripe. That saves the payments restructure,
but then "ecommerce is on top of payments" holds for one provider and not the other, and every
later commerce pattern has to branch on it. **Decided: restructure payments.** It is also what
lets `disable-payments` and `disable-analytics` delete only the detected provider's files.

### 5. Generated code is native to its provider

Everything above lives in the generator and the CLI. None of it appears in a generated
project. The project gets the code a Stripe or Shopify developer would write for SvelteKit if
VelaStack did not exist. The test for any generated file is: **would this exist if the project
only ever had this one provider?** An adapter interface, normalized money types or a provider
field in stored data fail it. They exist so we can swap providers, and nobody reading one
project should have to work out why they are there.

So each provider writes its own cart module, components and routes, in that provider's idiom
and with its own types. The patterns repo carries some duplication for this, which is the
right place for it. Shared files are limited to what would read naturally in either project:

- The cart button is shared. It uses `cart.count`, `cart.open` and `cart.load()`, names either
  store would have anyway.
- The shared navbar modifier inserts `<CartButton />` and nothing else.

Switching providers means disable, then enable again. Running `enable-ecommerce` with a
different provider than the one detected fails under decision 2.

## Phase 1: the cart

### Scope

In scope:

- A small client-side cart store per provider.
- A navbar cart button with a sheet.
- An `AddToCart` button.
- A handoff to hosted checkout.
- A Stripe cart page and success page. Shopify's checkout has its own.

Out of scope, on purpose:

- Discount codes. Stripe Checkout runs with `allow_promotion_codes`, and Shopify's checkout has
  its own field.
- Buyer identity.
- Line attributes on Stripe. Shopify supports them natively and keeps them. Stripe has no
  per-line field for a catalog price, and inventing an encoding in session metadata fails the
  test above.
- Orders and webhooks.
- Product pages.
- Optimistic updates.
- Cross-tab sync.

From climbangola, the Shopify GraphQL operations and the overall shape carry over: a
module-level store, `checkoutUrl`, and the cart id in localStorage. `svelte/store` writables,
`$env/dynamic/public`, the hand-rolled GraphQL fetch, discounts, the `_icon` attribute,
`topBarStore`, and the bank-transfer dialog do not.

### Pattern

`enable-ecommerce` (`vela enable ecommerce`):

- `plan: "pro"`.
- `requires: { payments: true, ui: "shadcn" }`.
- `providers: [stripe, shopify]`, inherited from payments.

As with every pattern, operations are emitted in the order deps → shadcn → creates → modifies:

| Step       | Stripe                                    | Shopify                                                    |
| ---------- | ----------------------------------------- | ---------------------------------------------------------- |
| packages   | none (`stripe` is already present)        | none (`@shopify/storefront-api-client` came with payments) |
| components | `sheet`, `button`, `badge`, `separator`   | same                                                       |
| creates    | shared + `providers/stripe/**`            | shared + `providers/shopify/**`                            |
| modifies   | `(public)/root-layout.svelte` navbar item | same                                                       |

### Files

```
creates/
  src/lib/components/cart/cart-button.svelte    navbar trigger + count badge; calls cart.load() on mount

providers/stripe/
  src/lib/cart.svelte.ts                        items in localStorage
  src/lib/components/cart/cart-sheet.svelte
  src/lib/components/cart/add-to-cart.svelte    <AddToCart price={...} />
  src/routes/(public)/cart/+page.svelte         the full cart
  src/routes/(public)/cart/+page.server.ts      `checkout` action → Checkout Session → 303
  src/routes/(public)/cart/server.test.ts
  src/routes/(public)/checkout/success/+page.server.ts
  src/routes/(public)/checkout/success/+page.svelte

providers/shopify/
  src/lib/cart.svelte.ts                        Storefront cart through src/lib/shopify.ts (from payments)
  src/lib/components/cart/cart-sheet.svelte
  src/lib/components/cart/add-to-cart.svelte    <AddToCart merchandiseId="gid://..." />

modifies/
  root-layout.svelte.ts                         adds <Navbar.Item><CartButton /></Navbar.Item> + import
```

The `#lib` specifiers follow the README: `#lib/cart.svelte.js`.

### Stripe

Stripe has no cart object. The cart is a list of prices in the browser, and Stripe only sees it
at checkout, which is how Stripe's own Checkout guides build one.

```ts
// src/lib/cart.svelte.ts
import { browser } from '$app/env';

export interface CartItem {
	price: string; // Stripe price id
	name: string;
	unitAmount: number; // Stripe's unit_amount, in the currency's smallest unit
	currency: string;
	quantity: number;
}

class Cart {
	items = $state<CartItem[]>([]);
	open = $state(false);
	count = $derived(this.items.reduce((n, item) => n + item.quantity, 0));
	subtotal = $derived(this.items.reduce((n, item) => n + item.unitAmount * item.quantity, 0));

	load() {} // reads localStorage once, in the browser
	add(item: Omit<CartItem, 'quantity'>, quantity = 1) {} // merges by price
	setQuantity(price: string, quantity: number) {} // 0 removes
	remove(price: string) {}
	clear() {}
}

export const cart = new Cart();
export function formatAmount(amount: number, currency: string): string {}
```

- **Item data comes from the page.** `AddToCart` takes the price's id, name, `unit_amount` and
  currency as props. The page selling the item has already loaded them. There is no endpoint to
  re-resolve the cart: Stripe prices the session itself, so a stale or tampered localStorage
  changes nothing that is charged.
- **The store is client-only.** It is module-level `$state`, read from localStorage in `load()`
  and written after each change, inside try/catch. `load()` runs from `CartButton`'s
  `onMount`, so the server render and hydration agree on an empty cart. The methods only run
  from event handlers, so the server never writes to the module.
- **Checkout is a form action, as both Stripe's and SvelteKit's docs do it.** The sheet and the
  `/cart` page post to `/cart?/checkout`, with the items as `[{ price, quantity }]` JSON in a
  hidden input. The action does the following:
  - It checks the shape, and a quantity from 1 to 99.
  - It calls
    `stripe.checkout.sessions.create({ mode: "payment", line_items, allow_promotion_codes: true, success_url, cancel_url })`
    and then `redirect(303, session.url)`.
  - `success_url` is `${url.origin}/checkout/success?session_id={CHECKOUT_SESSION_ID}`.
    `cancel_url` is `${url.origin}/cart`.
  - In app mode with a signed-in user, it passes `customer` from the existing
    `stripe-customer.ts` helper.
  - An inactive price, a recurring price or mixed currencies are refused by Stripe itself. The
    action returns `fail(400, { message })` with Stripe's message rather than re-implementing
    those checks.
- **The success page.** `/checkout/success` retrieves the session by `session_id` on the server,
  shows the amount paid, and calls `cart.clear()`.
- `formatAmount` divides by `10 ** digits`, taking the currency's digits from
  `Intl.NumberFormat`. That keeps zero-decimal currencies such as JPY right.

**Hosted Checkout, not `PaymentButton`.** The existing payment-intent flow prices one `priceId`.
A multi-line cart through Payment Element would need its own amount calculation, plus tax and
address collection. Checkout Sessions handle all of that.

### Shopify

Shopify has a real cart object, so the store keeps the cart as the Storefront API returns it.

- **The client.** `src/lib/shopify.ts` (from payments) wraps Shopify's own
  `@shopify/storefront-api-client`. It creates the client on first use, so a build with an empty
  `.env` still passes.
- **State.** The store keeps Shopify's fields: `lines` (with `merchandise` and `cost`), `cost`,
  `checkoutUrl` and `totalQuantity`. Money stays `MoneyV2`, and is formatted with
  `Intl.NumberFormat(..., { currency: currencyCode }).format(Number(amount))`. `count` is
  `totalQuantity`.
- **Persistence.** Only the cart id goes to localStorage, under `shopify_cart_id`. `load()` runs
  the `cart(id:)` query. A null cart (expired, or already converted to an order) clears the id.
- **Operations.** `cartCreate` on the first `add`, then `cartLinesAdd`, `cartLinesUpdate` and
  `cartLinesRemove`, sharing one fragment (climbangola's, minus discounts).
  `add(merchandiseId, quantity?, attributes?)` takes Shopify line attributes as Shopify's own
  `{ key, value }[]`.
- **Errors and pending state.** `pending` is true while a request is in flight, and the sheet's
  controls are disabled while it is, so a double click cannot send two requests. The first
  `userErrors` message, or a thrown network error, goes in `error` and is shown in the sheet.
- **Checkout** is `<a href={cart.checkoutUrl}>`. The buyer finishes on Shopify's checkout, and the
  next `load()` finds the cart gone.
- **The API version.** climbangola's `2024-01` is long past Shopify's support window. Pin the
  newest stable version, as one constant in `shopify.ts`, when this is built.

### UI

Everything is shadcn (`requires.ui: "shadcn"`).

- `CartButton` (shared): a `Navbar.Item` button with a `badge` count that toggles `cart.open`.
- `CartSheet` (per provider): the lines, a quantity stepper, remove, the subtotal, and the
  checkout form or link, disabled when the cart is empty or a request is pending.
- `AddToCart` (per provider): it adds, shows "Added" for a moment, and opens the sheet.
  Variant pickers and attribute dialogs are left to the page, unlike climbangola's
  `AddToCartDialog`.

### CLI

`src/commands/enable/ecommerce.ts`:

- Resolves the provider by inheritance (decision 2). It runs no provider prompt and asks for
  no env, because payments already wrote the keys.
- Optionally asks for one demo item: a price id or a variant GID. With one, the pattern writes
  a `(public)/shop` page with a single `AddToCart`. On Stripe that page has a `+page.server.ts`
  that loads the price. The page is the smoke test, and Phase 2 replaces it.

### Disable

`disable-ecommerce` does the following:

- Deletes the shared creates plus `allProviderPaths`.
- Removes the whole navbar item. The open `disable-auth` bug leaves an empty `Navbar.Item`
  behind, and this must not.
- Leaves payments alone.

### Tests

**Patterns repo:**

- Modifier fixtures (`fixtures/original|expect`) for the root layout: the vela template, a layout
  with auth's items, tabs vs spaces, and an already-applied layout (a no-op).
- A `generate.test.ts` covering provider creates, the inheritance error, and a provider
  mismatch.
- `generate.preview.ts` plus `preview-modifies/` for the website.

**Generated project:**

- `server.test.ts` for the Stripe checkout action: malformed items, quantity bounds, a Stripe
  error surfaced as a 400, and a session created with a 303 to `checkout.stripe.com`.

**Integration:**

- Stripe on `minimal` and on the `auth` baseline, gated on `STRIPE_*`.
- Shopify on `static` and on `minimal`, with no secrets needed.
- Enable, disable, enable for each provider.

The PR-by-PR order is in `ecommerce-plan.md`.

## Phase 2: catalog

- **Stripe:**
  - Extend the catalog sync with `images`, `description` and `metadata` on products, so cart
    items get images. The fields are added via `collectionPatches`, and the workflow is
    modified.
  - Write a `(public)/shop` listing and a `(public)/shop/[product]` page that read the synced
    tables through a server load.
  - Open question: the URL slug for a Stripe product. It could come from a metadata key or a
    generated field.
- **Shopify:**
  - Write the same two pages over Storefront `products` and `product(handle:)`, with variant
    selection.
- Each provider's pages are native to it, and there is no shared catalog interface. They
  replace the Phase 1 demo page.

## Phase 3: orders

- `orders` / `order_lines` collections, written by webhooks. On Stripe that is
  `checkout.session.completed` in `webhooks/stripe/handlers/dispatch.ts`, added by a modifier as
  `enable-subscriptions` does. On Shopify it is `orders/create` on a new `webhooks/shopify` route
  (HMAC-verified), which means Shopify gains a server requirement for this phase only.
- An order history under `(app)/orders` when auth is enabled. Guest orders are matched by email.
- Notifications: an order confirmation through `enable-notifications` when present.

## Later / open questions

- Inventory and stock display (Shopify has it; on Stripe it would be ours to keep).
- Shipping rates and tax: Stripe Checkout `shipping_options` / `automatic_tax` vs Shopify's
  built-in handling. Probably config on the checkout action, not a pattern.
- Discount codes in the cart sheet (Shopify `cartDiscountCodesUpdate`; Stripe has no cart-side
  equivalent).
- A cookie-backed cart, so the server can render the count and the cart survives cleared
  storage.
- A plain-UI variant of the cart components.
- More providers (Lemon Squeezy, Medusa). Each writes its own native store, like these two.
