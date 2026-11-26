# job-autopilot

Local-first AI agent that finds fresh job postings, scores how well they fit you,
writes tailored cover letters in your voice, and tracks every application.

Everything runs on your machine against one SQLite file. Your profile never
leaves it except as part of a prompt to the LLM provider you choose.

> **Status: in progress.** Steps 1–2 of 7 are done. `pnpm hunt` fetches fresh
> postings from Greenhouse, Lever, and Ashby into a local database. Scoring and
> cover letters are next. See [Roadmap](#roadmap).

## Design rules

These are enforced by code and tests, not by good intentions:

- **No scraping sites that forbid it.** Greenhouse, Lever, and Ashby public job
  board APIs, plus RSS/JSON feeds. No LinkedIn, no Indeed. The config schema
  only accepts those sources, so there is no back door.
- **Fresh means actually fresh.** Freshness comes from each board's
  first-published field (`first_published`, `createdAt`, `publishedAt`), never
  from "last updated" — on one real board, `updated_at` reports five jobs as
  new in 48 hours when none of them are.
- **Never apply twice.** A `UNIQUE` index on a normalised company+role key is
  what makes this true, so it holds even if two runs race.
- **Never invent a fact.** The cover-letter generator may use only what is in
  `profile.yaml` and the job posting, and must cite which profile fields it
  used. A test fails the build if a letter mentions a company, number, or skill
  that appears in neither.
- **Secrets stay out of the repo.** `profile.yaml`, `config.yaml`, `.env`, and
  `data/` are gitignored *and* blocked by a pre-commit hook that also scans
  staged content for credential-shaped strings.
- **A human reviews every submission.** Phase 2's form filler always stops
  before submitting. The config schema types that flag as `true` and nothing
  else, so no config file can claim otherwise.

## Setup

Requires Node 20.11+ and pnpm.

```bash
pnpm install
```

```bash
cp config.example.yaml config.yaml
cp profile.example.yaml profile.yaml
cp companies.example.yaml companies.yaml
cp .env.example .env
```

Then edit:

- `profile.yaml` — your real work history, skills, and salary rules. This is the
  only source of facts any letter may use, so write highlights as specific true
  statements. Gitignored.
- `companies.yaml` — the board tokens you care about. Ships with 20 verified
  boards (~5,000 open postings, ~150 newer than 48 hours on a given day); prune
  to taste. Tokens do go stale as companies switch providers, so a 404 from one
  board is reported per board rather than failing the run.
- `config.yaml` — provider, models, freshness window, rate limits.
- `.env` — your `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`.

Check it over:

```bash
pnpm doctor
```

`doctor` validates every file, confirms a key is present, and opens the
database. It makes no network calls and spends nothing.

## Commands

| Command | What it does |
| --- | --- |
| `pnpm doctor` | Validate config, profile, keys, and database. No network calls. |
| `pnpm hunt` | Fetch fresh postings from every enabled board. |
| `pnpm migrate` | Apply pending database migrations. |
| `pnpm test` | Run the test suite. |
| `pnpm typecheck` | Type-check without emitting. |
| `pnpm guard` | Run the pre-commit secret check by hand. |

## Hunting

```bash
pnpm hunt                        # postings from the last 48 hours
pnpm hunt --window-hours 168     # backfill a week (1-720)
pnpm hunt --only stripe          # one board, by token or name
pnpm hunt --dry-run              # fetch and report, write nothing
```

A real run over the 20 seeded boards:

```
  ✓ Stripe (greenhouse)          769 listed, 17 fresh, 17 new
  ✓ Cloudflare (greenhouse)      528 listed, 25 fresh, 25 new
  ✓ Spotify (lever)              97 listed, 7 fresh, 7 new
  ✓ OpenAI (ashby)               876 listed, 18 fresh, 18 new
  · Figma (greenhouse)           141 listed, 0 fresh, 0 new
  ✗ Nonexistent Co (lever)       ...returned HTTP 404.

5028 postings listed across 20 board(s); 132 newer than 48h.
132 new posting(s) stored, 0 already known.
20 HTTP request(s) made.
```

One request per board — all three APIs return descriptions inline, so there is
no per-job fetch. A board failing never fails the run: a 404 means the company
moved provider, which is reported and skipped. Re-running is safe; postings are
keyed on `(source, external_id)` and a second run updates `last_seen_at`
without creating duplicates.

Being polite to other people's free APIs is enforced, not advisory: a global
request ceiling, a minimum gap between hits on the same host, an identifiable
user agent, and `Retry-After` honoured when a server asks us to back off.

## Layout

```
src/
  config/       Zod schemas for config.yaml, profile.yaml, companies.yaml, .env
  db/           SQLite schema, migrations, and typed repository
  http/         The only outbound-request code: rate limits, retries, timeouts
  sources/      Per-board fetchers, freshness filter, HTML-to-text
  llm/          Provider-agnostic adapter + Anthropic and OpenAI implementations
  util/         Title/company normalisation (dedupe), logging, error types
  cli/          Command entry points
tests/
  fixtures/     Real API captures, so tests exercise the actual payload shapes
.githooks/      Pre-commit secret and private-data guard
```

Three pieces carry most of the weight:

**`src/util/normalize.ts`** decides whether two postings are the same job.
It expands board abbreviations (`Sr.` → `senior`, `SWE` → `software engineer`),
drops posting decorations (`(Remote)`, `(m/w/d)`, `| Full-Time`), removes the
posting's own location from the title, and sorts the remaining words so order
does not matter. A trailing segment it cannot identify is kept — `Engineer -
Payments` is a different job from `Engineer - Berlin`, and only the location
field tells them apart. A false split costs a duplicate application; a false
merge costs a job you never see. Both are tested as spelling pairs.

**`src/sources/`** holds one fetcher per board, sharing only an interface and
the HTTP client. They differ more than they look: Lever returns a bare array
whose title field is `text` and whose `createdAt` is epoch milliseconds; Ashby
flags unadvertised postings with `isListed: false` and can report
`isRemote: true` alongside `workplaceType: "Hybrid"` on one posting; Greenhouse
returns descriptions as *double-escaped* HTML. The tests run against captured
responses from the live APIs, so those quirks are pinned down rather than
assumed.

**`src/db/schema.sql`** separates a *posting* (something a board published,
possibly many times) from an *application* (something you did, at most once per
company+role). The `UNIQUE` index on `applications.dedupe_key` is the duplicate
guard. Scores and letters are append-only, so a letter can always name the score
it was written against.

**`src/llm/types.ts`** is the whole provider boundary: `complete` for prose and
`completeStructured` for schema-validated JSON. Provider SDKs are imported in
exactly two files. Structured output is validated locally even when the provider
claims to have constrained it.

Models are configured per task, because the two jobs have very different
shapes. Scoring reads every fresh posting — about 150 a day across the boards
in `companies.example.yaml`, median ~1,500 tokens each — while letter writing is
one call for a job you already decided you want. Measured against live board
data, one scoring run costs roughly **$2.16** on `claude-opus-5-5` versus
**$0.05** on `claude-haiku-5-5`, so `llm.scoring` and `llm.writing` default to
different models. Either can be omitted to fall back to the top-level
`llm.model`.

## Roadmap

1. ✅ Scaffold, config schemas, SQLite schema, LLM adapter interface
2. ⬜ Greenhouse / Lever / Ashby fetchers + 48h freshness filter — `pnpm hunt`
3. ⬜ Fit scoring with structured output and reasons — `pnpm score`
4. ⬜ Grounded cover letters with fact citation and tests — `pnpm draft <jobId>`
5. ⬜ Next.js dashboard
6. ⬜ Full README: screenshot, Mermaid architecture diagram, "why local-first"
7. ⬜ Phase 2: Playwright form filler, flag-gated, mandatory human review

## License

MIT. See [LICENSE](LICENSE).
