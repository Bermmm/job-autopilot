# job-autopilot

Local-first AI agent that finds fresh job postings, scores how well they fit you,
writes tailored cover letters in your voice, and tracks every application.

Everything runs on your machine against one SQLite file. Your profile never
leaves it except as part of a prompt to the LLM provider you choose.

> **Status: in progress.** Steps 1–4 of 7 are done. `pnpm hunt` fetches fresh
> postings, `pnpm score` rates them, `pnpm draft` writes a grounded cover
> letter. The dashboard is next. See [Roadmap](#roadmap).

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
| `pnpm score` | Score postings against your profile. |
| `pnpm draft <jobId>` | Write a grounded cover letter for one posting. |
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

## Scoring

```bash
pnpm score                       # every posting without a score yet
pnpm score --limit 20            # keep a first run small
pnpm score --job <jobId>         # one posting
pnpm score --rescore             # redo postings that already have a score
pnpm score --concurrency 8       # requests in flight (1-16, default 4)
```

```
   86 strong   Databricks — Deployment Strategist
   76 good     Cloudflare — Senior Manager, Customer Engineering      ⚠ 1
   54 partial  Cloudflare — Senior GCC Government Relations Manager   ⚠ 1
   22 no       Cloudflare — Senior Sales Manager, Digital Native      ⚠ 1

Scored 12 posting(s): 32,113 input + 1,440 output tokens.
5 at or above your minScoreToDraft of 70.
```

Scores are 0-100 against fixed bands (strong / good / partial / weak / no),
defined in the prompt so two runs are comparable. Each score carries up to five
reasons and any red flags — stated requirements your profile does not meet.

**This is the command that spends money.** It says how many postings and roughly
how many tokens before it starts, and `--limit` keeps a first run small. On the
default `claude-haiku-5-5` a full 150-posting run is about $0.05; on
`claude-opus-5-5` it is about $2.

### Judgment versus arithmetic

Not every red flag is a judgment call. Asking a model whether a posting
contains a phrase you said you will not accept is asking it to do a substring
search, and it will occasionally get it wrong. So `src/scoring/rules.ts` decides
those in code — deal-breaker phrases, a `remoteOnly` mismatch, a technology
under `skills.avoid`, a stated years-of-experience floor above your profile —
and the model is left the things that need reading comprehension, like whether
a posting's seniority matches your history. The two sets are merged, with the
exact figure winning where both speak.

A deal-breaker you named in your own words is the one thing that caps a score
outright, no matter how enthusiastic the model was:

```
clean posting                  model 92 ->  92  capped=false
deal-breaker: equity only      model 92 ->  15  capped=true
deal-breaker: 60-hour weeks    model 92 ->  15  capped=true
```

### What gets sent to the provider

Your contact details do not. `src/profile/view.ts` renders the profile for
prompts and omits your email, phone number, and links — scoring needs your
experience, not a way to reach you. Tests assert the rendered profile contains
no `@` and no URL.

Scores are append-only and stored with the prompt version that produced them,
so re-scoring after a prompt change adds a row rather than overwriting, and two
scores from different prompts are never silently compared.

## Drafting a letter

```bash
pnpm draft 801dda113882b0d1
pnpm draft <jobId> --force      # draft even if unscored or below threshold
pnpm draft <jobId> --again      # override the never-twice rule, deliberately
```

Three gates run before a single token is spent: the posting must exist, it must
score at or above `minScoreToDraft`, and there must be no existing application
for that company and role. The last one is the never-twice rule, checked on the
normalised key — so a second posting of the same job on another board, in
another city, under a different spelling, is caught.

The letter is saved to `paths.letters` with front matter recording the model,
the prompt version, and the profile fields it cited; the application moves to
`drafted`.

### Nothing unverified gets saved

A letter may claim nothing that is not in your profile or the job posting, and
that is checked rather than requested. Three checks, none of which needs a
model — a check that cannot itself hallucinate is worth more than a second
opinion:

| Check | Catches |
| --- | --- |
| **Numbers** | "cut costs by 35%" when no 35 exists anywhere. Figures spelled out ("Fifteen years") count; thousands separators don't fool it. |
| **Proper nouns** | An invented employer, a technology never used, a degree never earned. |
| **Citations** | The model names the profile field behind each claim; a path that doesn't exist, or a value the field doesn't say, fails. |

A fourth check is about tone rather than truth, because a letter can invent
nothing and still be unsendable. It blocks the usual tells — "passionate",
"leveraging", "world-class", "I am writing to apply" — including inflections,
plus any term your own `voiceNotes` puts in quotes. So `Never say "rockstar"`
in your profile becomes an enforced rule rather than a hopeful instruction.

When a letter fails, the model is told exactly which token failed and why, and
asked again — once. If the second attempt also fails, **nothing is saved**:

```
✗ Letter failed its checks after 2 attempt(s). Nothing was saved.

  ✗ [number] The letter states "35", which appears in neither the profile nor the job posting.
  ✗ [proper-noun] The letter mentions "Globex", which appears in neither the profile nor the job posting.
  ✗ [style] The letter uses "passionate", which reads as filler. Say the thing plainly or cut it.
```

A letter with an invented fact in it is worse than no letter, so a refusal is
the correct outcome. It usually means the profile is thin for that posting —
adding a relevant highlight gives the model something true to work with.

The grounding corpus is deliberately wider than the citation index: your salary
rules and standard answers are true things you may state in a letter, even
though they are not citable achievements. Your contact details are in neither,
and are never sent to a provider at all — so a letter quoting an email address
is a letter that invented it.

## Layout

```
src/
  config/       Zod schemas for config.yaml, profile.yaml, companies.yaml, .env
  db/           SQLite schema, migrations, and typed repository
  http/         The only outbound-request code: rate limits, retries, timeouts
  sources/      Per-board fetchers, freshness filter, HTML-to-text
  profile/      Prompt rendering (omits contact details) and the fact index
  scoring/      Score schema, prompt, deterministic rules, engine
  letters/      Letter schema, prompt, grounding and style checks, engine
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
2. ✅ Greenhouse / Lever / Ashby fetchers + 48h freshness filter — `pnpm hunt`
3. ✅ Fit scoring with structured output and reasons — `pnpm score`
4. ✅ Grounded cover letters with fact citation and tests — `pnpm draft <jobId>`
5. ⬜ Next.js dashboard
6. ⬜ Full README: screenshot, Mermaid architecture diagram, "why local-first"
7. ⬜ Phase 2: Playwright form filler, flag-gated, mandatory human review

## License

MIT. See [LICENSE](LICENSE).
