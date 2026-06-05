# Vela CLI ↔ AI two-agent integration

## Context

The velastack server already exposes `POST /v1/projects/<id>/ai/{schema,form,copy}`.
We're now wiring **schema** and **form** into the CLI's `generate` commands as a
sequential two-agent flow:

1. **Agent 1 (Schema/Field designer)** — takes the user's natural-language
   prompt + the **live** existing schema (read from PocketBase, not local
   files) and produces a `CollectionSpec`.
2. **Agent 2 (Layout designer)** — takes the just-designed `CollectionSpec`
   and produces a `FormLayout` for it.

Each agent runs inside its own preview-and-refine loop. After the user
accepts stage 1, stage 2 begins. Once both are accepted, the CLI runs the
existing `runPattern()` once and emits the layout alongside.

`generate schema` runs only stage 1. `generate scaffold` and `generate form`
run both. Crucially, `generate form` no longer takes a `--model` flag — the
prompt is responsible for designing the fields.

The **backend already supports this exact split** (schema endpoint + form
endpoint) — no request/response shape changes. The only backend work is
**system prompt refinements** (covered separately in the velastack repo).
The `copy` endpoint is intentionally not consumed by the CLI in this PR.

## Architecture

```
src/lib/
  ai-client.ts          // POST helpers for /ai/schema and /ai/form
  ai-existing-models.ts // withPocketbase → CollectionSpec[]
  ai-to-argv.ts         // CollectionSpec → ["model", "field1:type!", …]
  ai-grid.ts            // FormLayout → ASCII grid string
  ai-loop.ts            // generic preview-and-refine loop

src/commands/
  generate/schema.ts    // add --ai flag (stage 1 only)
  generate/scaffold.ts  // add --ai flag (stage 1 + stage 2)
  generate/form.ts      // add --ai flag (stage 1 + stage 2, no --model)
```

`ai-client.ts` exposes `aiSchema()` and `aiForm()`. Each:

- Reads `apiKey` (`requireApiKey()` from `src/lib/config.ts:36`) and
  `projectId` from `readProjectConfig()` (`src/lib/project-config.ts:13`).
  Errors with "this isn't a velastack project, run `vela create`" if
  project config is missing.
- POSTs JSON to `${API_URL}/v1/projects/${projectId}/ai/{schema|form}` with
  `Authorization: Bearer ${apiKey}`.
- Maps 401/403 → "API key invalid — run `vela login`" (matches
  `src/lib/velastack-api.ts:21-39`); 502 → surface message verbatim.

## Existing-models loader

`ai-existing-models.ts` uses the **primary entry point**
`withPocketbase(cwd, fn, creds?)` from `src/lib/pocketbase.ts:162`. It
attaches to a running `vela dev` server when present, otherwise spins up an
ephemeral `pocketbase serve`. The mapping pattern matches
`src/commands/seeds/save.ts:50-61`:

```ts
async function loadExistingModels(workspaceRootDir): Promise<CollectionSpec[]> {
  return withPocketbase(workspaceRootDir, async (pb) => {
    const all = await pb.collections.getFullList();
    const userCollections = all.filter((c) => !c.system);
    const byId = new Map(userCollections.map((c) => [c.id, c.name]));
    return userCollections.map((c) => ({
      name: c.name,
      type: c.type,
      fields: c.fields
        .filter((f) => !f.system)
        .map((f) => ({
          name: f.name,
          type: f.type,
          required: f.required,
          values: f.values,
          collectionName: f.collectionId ? byId.get(f.collectionId) : undefined,
          maxSelect: f.maxSelect,
          min: f.min,
          max: f.max
        }))
    }));
  });
}
```

If PocketBase isn't reachable (no `pb_data/`, binary missing, or auth
fails), fall back to passing `existingModels: []` and log a warning — the
agent still works, it just won't link relations to existing collections.

## Two-stage flow

```
stage 1: schema designer
  loop:
    call aiSchema({ prompt, history, context: { existingModels } })
    print field table (name | type | required)
    p.text("Refine, or press Enter to apply")
    accept → break
    refine → history = turn; prompt = next; loop
    cancel → exit (no files written)

stage 2: layout designer  (skipped for `generate schema`)
  loop:
    call aiForm({ prompt, history, context: { model: <accepted-from-stage-1> } })
    print ASCII grid
    p.text("Refine the layout, or press Enter to apply")
    accept → break
    refine → history = turn; prompt = next; loop
    cancel → exit (no files written)

commit:
  argv = aiToArgv(model)
  runPattern("generate-{schema|scaffold|form}", argv, { route?, … }, report)
  emit layout (see "Layout sidecar")
```

History is per-stage. Stage 2 starts with `history = []` and the freshly
agreed model as `context`. This keeps each agent's transcript focused.
Going back from stage 2 to stage 1 is **out of scope for v1** — cancel
restarts the whole command.

For scaffold: the layout produced in stage 2 is shared between the
generated `new` and `edit` form pages — only one prompt for the user, two
applications.

## Use-case hint (CLI-side, no backend change)

The schema agent needs to know whether it's designing for a persisted
scaffold, a one-off form, or a standalone schema. The CLI prepends a small
`Use case: …` block to its `prompt` string before sending — no API change:

```
Use case: scaffold | form | schema
- scaffold: a new persisted PocketBase collection. Lean toward
  forward-thinking field choices.
- form: a Svelte form with no DB persistence. Focus on user-input
  fields; don't worry about indexes or relations to non-existent
  collections.
- schema: a standalone zod schema. Same considerations as form.

Describe and design a model for: {user prompt}
```

## Layout sidecar (v1)

The `@velastack/patterns` package's `generate-scaffold` / `generate-form`
don't yet accept a `formLayout` input. Until they do (out of scope), v1
emits the layout two ways after the pattern runs:

1. Print the ASCII grid + the layout JSON to stdout in the result report.
2. Write `data/ai-form-layouts/<model>.json` for future pattern pickup.

No template-rewriting at this stage — the user pastes the layout JSON or
hand-tweaks the generated `+page.svelte` files.

## ASCII grid preview (`ai-grid.ts`)

Render `FormLayout` as a 12-col grid with field names sized by `span`. For
example, layout
`[{cols:[{span:6,field:"first_name"},{span:6,field:"last_name"}]},
  {cols:[{span:12,field:"email"}]},
  {cols:[{span:6,field:"city"},{span:3,field:"state"},{span:3,field:"zip"}]}]`
renders roughly as:

```
┌─────────────────────────────┬─────────────────────────────┐
│ first_name                  │ last_name                   │
├─────────────────────────────┴─────────────────────────────┤
│ email                                                     │
├─────────────────────────────┬──────────────┬──────────────┤
│ city                        │ state        │ zip          │
└─────────────────────────────┴──────────────┴──────────────┘
```

Width per col = round(terminal-width * span / 12). On narrow terminals,
fall back to a list view: `row 1: first_name(6) | last_name(6)`.

## CollectionSpec → argv (`ai-to-argv.ts`)

```
toArgv(spec): [spec.name, ...spec.fields.map(toFieldArg)]

toFieldArg(f):
  required = f.required ? "!" : ""
  return `${f.name}:${typeArg(f)}${required}`

typeArg(f):
  if f.type === 'select' && f.values?.length
    → `select(${f.values.join(',')})`
  if f.type === 'relation' && f.collectionName
    → singularize(f.collectionName)        // pattern parser resolves model name → relation
  else
    → f.type   // text|number|bool|email|date|url|file
```

Drop+warn on unrepresentable fields (e.g. `relation` without
`collectionName`).

## Per-command UX

### `vela generate schema --ai "<description>"`
1. Load existing models via `withPocketbase()`.
2. Stage 1 only (no layout). User accepts → `runPattern("generate-schema",
   argv, {}, report)`.

### `vela generate scaffold --ai "<description>" [--route <route>]`
1. Load existing models.
2. Stage 1: schema designer loop.
3. Stage 2: layout designer loop. Layout shared between new + edit forms
   (only one prompt for the user).
4. Accept → `runPattern("generate-scaffold", argv, { route }, report)`,
   then emit layout sidecar.

### `vela generate form --ai "<description>"`
No `--model` flag. The prompt names the form and designs the fields
("contact form for product inquiries" → designer returns a `contact`
model with name/email/message/etc.).

1. Load existing models.
2. Stage 1: schema designer loop. Same agent as scaffold.
3. Stage 2: layout designer loop.
4. Accept → `runPattern("generate-form", argv, {}, report)`, then emit
   layout sidecar.

## Files to add / modify

- **Add** `src/lib/ai-client.ts`, `src/lib/ai-existing-models.ts`,
  `src/lib/ai-to-argv.ts`, `src/lib/ai-grid.ts`, `src/lib/ai-loop.ts`
  + `*.test.ts` siblings.
- **Modify** `src/commands/generate/schema.ts` — add `--ai` flag (stage 1).
- **Modify** `src/commands/generate/scaffold.ts` — add `--ai` flag
  (stage 1 + stage 2).
- **Modify** `src/commands/generate/form.ts` — add `--ai` flag
  (stage 1 + stage 2); **`--ai` no longer requires `--model`**.

## Reused pieces

- `withPocketbase()` from `src/lib/pocketbase.ts:162` — primary entry for
  schema reads.
- Mapping pattern from `src/commands/seeds/save.ts:50-61` —
  `pb.collections.getFullList()` → minimal field shape.
- `requireApiKey()` from `src/lib/config.ts:36`.
- `readProjectConfig()` from `src/lib/project-config.ts:13`.
- 401/403 handling shape from `src/lib/velastack-api.ts:21-39`.
- `runPattern()` from `src/lib/pattern-runner.ts:23` — unchanged.
- `@clack/prompts` (`p.text`, `p.log.*`, `p.taskLog`) — already used.

## Verification

- **Unit**: `ai-to-argv.test.ts` (happy + select + relation + required +
  drop-with-warning), `ai-grid.test.ts` (rendering, narrow fallback),
  `ai-loop.test.ts` (accept/refine/cancel),
  `ai-client.test.ts` (URL/header/body shape, error mapping).
- **Manual end-to-end**:
  1. `vela login` (mints API key)
  2. `cd <velastack project>` so `.vela/project.json` is in scope
  3. `vela generate scaffold --ai "restaurant employees"`
  4. Stage 1 preview appears as a field table; type a refinement
     ("add a phone field") and confirm it iterates; press Enter to
     accept.
  5. Stage 2 preview appears as ASCII grid; refine ("put first_name and
     last_name in one row"); press Enter to accept.
  6. Files land via the existing `generate-scaffold` pattern; layout
     JSON appears in stdout report and at
     `data/ai-form-layouts/restaurant_employees.json`.
- **Smoke against live API**: optional env-gated test that hits
  `https://velastack.dev` with a test API key (skipped in CI).

## Out of scope (intentionally)

- The `copy` endpoint (CMS website-copy edits).
- Wiring `formLayout` directly into the `generate-scaffold` /
  `generate-form` patterns. v1 emits the layout as a sidecar JSON.
- Going back from stage 2 to stage 1 within a single command.
- Persisting AI conversation history across CLI invocations.
- Streaming responses.
- Caching AI calls.
- Any backend request/response shape change. The two-agent flow uses the
  existing endpoints exactly as built.
