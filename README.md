# job-autopilot

Local-first AI agent that finds fresh job postings, scores how well they fit you,
writes tailored cover letters in your voice, and tracks every application.

Everything runs on your machine against one SQLite file. Your profile never
leaves it except as part of a prompt to the LLM provider you choose.

> **Status: in progress.** Step 1 of 7 is done — scaffold, config schemas,
> database schema, and the LLM adapter layer. See [Roadmap](#roadmap).

## Design rules

These are enforced by code and tests, not by good intentions:

- **No scraping sites that forbid it.** Greenhouse, Lever, and Ashby public job
  board APIs, plus RSS/JSON feeds. No LinkedIn, no Indeed. The config schema
  only accepts those sources, so there is no back door.
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
- `companies.yaml` — the board tokens you care about.
- `config.yaml` — provider, model, freshness window, rate limits.
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
| `pnpm migrate` | Apply pending database migrations. |
| `pnpm test` | Run the test suite. |
| `pnpm typecheck` | Type-check without emitting. |
| `pnpm guard` | Run the pre-commit secret check by hand. |

## Layout

```
src/
  config/     Zod schemas for config.yaml, profile.yaml, companies.yaml, .env
  db/         SQLite schema, migrations, and typed repository
  llm/        Provider-agnostic adapter + Anthropic and OpenAI implementations
  util/       Title/company normalisation (dedupe), logging, error types
  cli/        Command entry points
tests/        Vitest: dedupe pairs, schema validation, DB constraints, retries
.githooks/    Pre-commit secret and private-data guard
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

**`src/db/schema.sql`** separates a *posting* (something a board published,
possibly many times) from an *application* (something you did, at most once per
company+role). The `UNIQUE` index on `applications.dedupe_key` is the duplicate
guard. Scores and letters are append-only, so a letter can always name the score
it was written against.

**`src/llm/types.ts`** is the whole provider boundary: `complete` for prose and
`completeStructured` for schema-validated JSON. Provider SDKs are imported in
exactly two files. Structured output is validated locally even when the provider
claims to have constrained it.

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
