# Copy Updater

Propose, review and approve page copy against a pixel-faithful frozen copy of the real page.

A copywriter pastes a URL. Copy Updater loads it in a real browser and freezes a
self-contained snapshot — layout, fonts and images inlined. Copy changes are then
proposed against that snapshot, previewed at desktop and mobile widths, diffed,
commented on, forked and approved.

## The core idea

**A page is a frozen snapshot; a version is an ordered list of operations applied to it.**

- **Snapshot** — the fully rendered page with all CSS, fonts and images inlined into one
  file. Immutable. Site JavaScript is stripped: a framework rehydrating inside the preview
  would rebuild the DOM and destroy the stamped ids everything depends on.
- **Block** — an element carrying text, stamped with a stable `data-cu-id` derived from its
  structural path (`body/main:1/section:1/h1:1`). A paragraph containing a link stays *one*
  editable block rather than three fragments.
- **Version** — a snapshot id, a parent version, and an op list. Versions form a tree, so
  "fork from any baseline" and "compare any two" fall out for free.

Ops go beyond rewriting text: `setText`, `setMeta`, `insert`, `remove`, `move`,
`replaceElement`, `setAttr`, `addStyle`. A flat text map could never add a bullet or reorder
a section.

Ops are the authored source of truth. Each version also stores a **resolved state** —
apply the ops, re-extract the blocks — so diffing two versions is a diff of two block lists:
`diffArrays` over ids catches adds, removes and reorders; `diffWords` within matched blocks
catches the wording.

## Running locally

Requires Node 22+ and a Postgres database.

```bash
npm install && npx playwright install chromium
```

Copy `.env.example` to `.env` and fill it in:

```bash
cp .env.example .env
```

- `AUTH_SECRET` — `openssl rand -base64 32`
- `APP_ENCRYPTION_KEY` — `openssl rand -base64 32` (encrypts the stored OpenRouter key;
  changing it makes every stored key unreadable)
- `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET` — a Google OAuth client with
  `http://localhost:3000/api/auth/callback/google` as an authorised redirect URI
- `ALLOWED_EMAIL_DOMAINS` — defaults to `waveform.com,rsrf.com`

Then:

```bash
npm run db:migrate && npm run dev
```

## Deploying to Railway

The Dockerfile builds on Microsoft's Playwright image, which ships Chromium and the system
libraries it needs. A stock Node image means chasing `libgbm`/`libnss3` by hand.

1. Create a project from this repo; Railway picks up `railway.json` and builds the Dockerfile.
2. Add a **Postgres** service. `DATABASE_URL` is injected automatically.
3. Add a **volume mounted at `/data`** — snapshots live there, and without it every deploy
   loses them.
4. Set `AUTH_SECRET`, `APP_ENCRYPTION_KEY`, `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`, and
   `AUTH_URL` (your public Railway URL). Add that URL's
   `/api/auth/callback/google` to the Google OAuth client.
5. Give the service **at least 1 GB RAM** — a Chromium instance needs several hundred MB.

Migrations run on container start, so a schema mismatch fails the deploy instead of
surfacing as runtime errors. `/api/health` is the health check.

## AI suggestions

Everything routes through **OpenRouter** — one key in Settings covers every model, encrypted
at rest and never sent to the browser. Models are listed as `vendor/model`
(`anthropic/claude-opus-4.5`, `openai/gpt-5.1`, …), with optional fallbacks tried in order so
one unavailable provider doesn't fail a copywriter's request.

Requests are sent with `provider.require_parameters: true`. That is load-bearing rather than
tuning: the whole pipeline depends on schema-valid ops, and without it OpenRouter can route
to a provider that silently ignores `response_format` and returns prose. It also replaces the
per-provider capability probing an earlier version needed.

**Reasoning** is configured once as low/medium/high. It is not a single parameter underneath —
OpenAI and Grok take an effort level while Anthropic and Gemini take a token budget — so the
level is translated per model family. Layout and directive requests are raised a step
automatically, since those have more to work out; a deliberate "low" setting is never
overridden.

**Temperature** is set per prompt shape, not globally: 0.25 for directives (apply this list
faithfully) and 0.85 for optimize (explore). One value for both makes directives drift or
options converge.

**Web search** is opt-in per request. It is genuinely useful for how a market talks — the
phrasing competitors use, the objections buyers raise — and genuinely risky for facts, since
results describe *someone else's* product. Both the search prompt and the request prompt tell
the model to treat results as language evidence only and never carry a spec, price or
guarantee onto the page.

**Genuinely different options** is also opt-in. Asking one call for three options returns
three rewordings of one idea; this instead makes one call per option with a different angle
assigned (lead with the benefit / with the objection / with specifics / …). Costs N×, which
is why it is a toggle rather than the default.

Two modes:

- **Copy only** — the model may emit `setText` and `setMeta` and nothing else. No surprise
  restructuring when you asked for a tighter headline.
- **Copy + layout** — the full op set. "Add a fourth bullet", "move the testimonial above
  the fold", "turn this paragraph into a three-item list".

And two prompt shapes: **Optimize** (improve this, plus optional direction) and **Apply my
list** (paste a list of changes; the model applies them and adjusts the copy that has to
move with them).

Original lengths are sent as *guidance, not limits* — nothing is rejected for being long.
Blocks that grow past ~130% get a "check layout" marker, and you look at them on mobile.
Hard caps just produce worse copy.

Suggestions are validated before they get anywhere near a version: ops referencing blocks
outside the request's scope are dropped and reported, inserted HTML is sanitised, and ids for
new elements are minted at op-creation time so replaying an op list is stable.

## Tests

```bash
npm test
```

Covers the ops engine, the schema against real Postgres (via PGlite), and an end-to-end run
that captures a page in a real browser and drives it through resolve → diff → export.

Two operational scripts:

```bash
npx tsx scripts/capture-url.mts https://example.com /tmp/out
npx tsx scripts/verify-snapshot.mts /tmp/out.html /tmp/out.skeleton.html /tmp/shot.png
```

`verify-snapshot` loads a stored snapshot in a real browser and drives the preview runtime
over postMessage exactly as the workspace does — useful for checking that a snapshot still
renders and that ops still apply.

## A licensing note

Asset inlining uses [SingleFile](https://github.com/gildas-lormeau/SingleFile), which is
**AGPL-3.0**. Internal use does not trigger its distribution obligations, but offering this
tool to third parties over a network would. It sits behind `lib/capture/capture.ts` so it can
be swapped if that ever matters.

## Known limits

- Site JavaScript is stripped from snapshots. Anything drawn purely by script after load
  (some star-rating widgets, chat bubbles) will not appear in the preview.
- One snapshot per capture, taken at desktop width. Mobile preview relies on the page's own
  media queries, which is correct for CSS-responsive sites but not for sites that branch on
  user agent server-side.
- Re-capturing creates a new snapshot; existing versions stay pinned to the one they were
  authored against. Re-anchoring versions onto a newer snapshot is not built yet.
- Removed blocks appear in the outline and export but not as ghosts in the preview.
