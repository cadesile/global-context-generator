# ICM Context Generator — Design

**Date:** 2026-07-20
**Status:** Approved
**Replaces:** `generate_project_context.sh` (single-file markdown context generator)
**Reference:** [ICM paper — arxiv 2603.16021v2](https://arxiv.org/html/2603.16021v2)

## Problem

The current bash script generates one monolithic `<repo>-context.md` file. This
doesn't scale: the file grows unbounded, agents must load everything to use
anything, and every run re-does all work — including expensive AI summarisation
of markdown docs that haven't changed.

## Goal

Rewrite the generator so it produces an **ICM `.context/` folder structure**
(faithful to the paper's numbered-stage layout) that any agent can navigate to
understand critical project context, loading only what it needs. Re-runs must
skip markdown files already parsed and unchanged, via a persistent ledger.
Ignore rules (node_modules etc.) must be explicit, layered, and user-editable.

## Decisions (made during brainstorming)

1. **Faithful ICM numbered stages** — not a flat knowledge base. Stage folders
   with `CONTEXT.md` contracts (Inputs / Process / Outputs) and `output/` dirs.
2. **The script executes all stages itself** — agents are pure consumers.
   Stage contracts document provenance, not pending work (except stage 06 in
   `--no-ai` mode, whose contract records that synthesis was not executed).
3. **MD parsing = static digest always + AI summary when enabled.** Static
   digest is title + heading outline + word count. AI summary appended when an
   AI CLI is available and enabled.
4. **Ignore rules: built-in defaults + repo `.gitignore` + editable
   `.context/_config/ignore`** (gitignore syntax; seeded once, never
   overwritten, authoritative on re-runs).
5. **Full rewrite as a single-file Node.js script** (`generate_project_context.js`),
   Node >= 18, zero npm dependencies (only `node:` built-ins). The bash script
   is deleted; git history preserves it.

## Deliverable & CLI

`generate_project_context.js`, run from a project root:

```
node generate_project_context.js [options]
  --no-ai               Skip all AI calls (static extraction only)
  --ai <claude|gemini>  AI CLI to use (default: claude)
  --context-dir <dir>   Where to write the structure (default: .context)
  --depth <n>           Directory tree depth (default: 3)
  --debug-detection     Print detected stack variables and exit
```

Requirements drop from bash+jq to Node >= 18. `git` optional (sections degrade),
AI CLIs optional. AI calls shell out to `claude -p` / `gemini -p` via
`child_process`.

## Output structure

```
.context/
├── CONTEXT.md                  # Layer 1 router
├── _config/                    # Layer 3 config ("factory")
│   ├── ignore                  # gitignore-syntax ignore rules (editable)
│   └── manifest.json           # ledger (see below)
└── stages/
    ├── 01_overview/
    │   ├── CONTEXT.md          # stage contract: Inputs / Process / Outputs
    │   └── output/
    │       ├── stack.md        # detected stack, framework versions, dependencies
    │       ├── environment.md  # dev env, masked env vars, setup commands
    │       └── metrics.md      # file/entity/controller/service/migration counts
    ├── 02_architecture/
    │   └── output/
    │       ├── structure.md    # directory tree (depth-limited)
    │       └── git-activity.md # recent commits + changed files
    ├── 03_data/
    │   └── output/
    │       ├── schema.md       # stack-specific DB schema
    │       ├── entities.md     # entity/type/model definitions
    │       ├── state.md        # store shapes (Node stacks only; omitted otherwise)
    │       └── migrations.md   # latest migrations
    ├── 04_interfaces/
    │   └── output/
    │       ├── routes.md       # API routes
    │       ├── controllers.md  # public method signatures
    │       ├── services.md     # public method signatures
    │       └── api-spec.md     # parsed OpenAPI/Swagger (if found)
    ├── 05_documentation/
    │   └── output/
    │       ├── index.md        # all project MD files, grouped by directory
    │       └── summaries/      # one digest file per parsed MD file
    │           └── <slug>.md   # slug = path with separators → "-"
    └── 06_synthesis/
        └── output/
            ├── overview.md           # AI project overview
            ├── architecture-notes.md # AI pattern analysis
            └── current-focus.md      # AI reading of recent commits
```

- Stage numbering doubles as recommended reading order for agents.
- Files whose section doesn't apply to the detected stack are omitted, and the
  stage contract's Outputs section reflects what was actually written.
- The root `CONTEXT.md` router contains: what this folder is (with ICM
  reference), generation timestamp, one-line stack summary, a stage index
  table (stage → purpose → key files → size), and consumption guidance
  ("read this router, then load only the stage outputs you need").
- The project's own `CLAUDE.md` / `AGENTS.md` are never modified. On completion
  the script prints a suggested pointer line for the user to paste manually.

## Stage contracts

Every stage `CONTEXT.md` is generated each run with three sections, matching
the paper:

```markdown
## Inputs
- source: composer.json, package.json (stack detection)
- source: src/Entity/**/*.php

## Process
What the generator did in this stage, in one short paragraph.

## Outputs
- output/schema.md — Doctrine migrations + entity field listing
```

## The ledger (`_config/manifest.json`)

```json
{
  "version": 1,
  "generated_at": "2026-07-20T12:00:00Z",
  "generator_version": "2.0.0",
  "project": { "name": "repo-name", "stack": "Laravel (PHP)" },
  "parsed_markdown": {
    "docs/adr/001-auth.md": {
      "sha256": "…",
      "mtime": "2026-07-01T09:30:00Z",
      "summary": "stages/05_documentation/output/summaries/docs-adr-001-auth.md",
      "ai_summarized": true,
      "parsed_at": "2026-07-20T12:00:00Z"
    }
  },
  "stages": { "01_overview": { "last_run": "2026-07-20T12:00:00Z" } }
}
```

Re-run algorithm for stage 05:

1. Walk the repo for `*.md`, applying ignore rules (below). `.context/` itself
   is always excluded.
2. Hash each file (sha256).
3. Unchanged hash **and** existing summary file → skip (no re-read, no AI call).
4. New or changed → regenerate digest (and AI summary if enabled).
   A file previously parsed without AI is treated as changed when AI is now
   enabled (`ai_summarized: false` → upgrade).
5. In manifest but no longer on disk → delete its summary file and entry.
6. Manifest is written **last**, only after a fully successful run, so an
   interrupted run re-does work instead of recording it falsely.

All other stage outputs regenerate every run — they're cheap. The ledger only
gates the expensive per-MD work.

## Ignore rules

Merged, in order:

1. **Built-in defaults:** `node_modules`, `vendor`, `.git`, `dist`, `build`,
   `out`, `coverage`, `.next`, `.nuxt`, `target`, `__pycache__`, `.venv`,
   `venv`, `tmp`, `.cache`, `Pods`, `DerivedData`, `.context` (self).
2. **Repo `.gitignore`** patterns (subset of gitignore syntax: literal paths,
   directory patterns, `*` globs; no negation support in v1 — documented).
3. **`.context/_config/ignore`** — gitignore syntax. Seeded with the defaults
   on first run; afterwards user-editable and authoritative; never overwritten.

The effective rules apply to the MD walk (stage 05) and to metrics/tree
generation, so counts and structure exclude vendored noise too.

## Extraction parity

All extractors from the bash script are ported:

- Stack detection (composer.json, package.json, go.mod, Gemfile,
  requirements.txt/manage.py, Cargo.toml) incl. the interactive subdirectory
  prompt when the repo root has no detectable stack.
- Dev-env detection (Lando, Docker Compose, devcontainer, Makefile).
- Database hint scan.
- Schema scanners: SQLite (Expo), Doctrine, Laravel, Django, Rails, Go structs.
- Entity scanners: TypeScript interfaces/types/enums, Doctrine, Eloquent,
  Django, Rails, Go.
- State layer: Zustand store shapes (Node stacks).
- Routes, controller/service public signatures, migrations, masked env vars,
  OpenAPI/Swagger detection (root + one level deep).
- Git activity (last 15 commits, recent changed files).

## Error handling

- **No git repo:** git-dependent outputs omitted; contracts note why.
- **AI CLI missing or `--no-ai`:** warn once; stage 06 contract records
  "synthesis not executed — run with an AI CLI available"; per-MD digests are
  static-only with `ai_summarized: false` in the manifest.
- **AI call failure on one file:** log a warning, keep the static digest, mark
  `ai_summarized: false` so a later run retries; do not abort the run.
- **Unknown stack:** generic extraction (metrics, tree, docs, git) still runs.
- **Interrupted run:** safe by construction (manifest written last).

## Testing

`node --test test/` with fixture mini-projects under `test/fixtures/`:

- A Node/Expo-like fixture (package.json, src/types, src/stores, MD docs).
- A Laravel-like fixture (composer.json, migrations, Eloquent models).
- A planted `node_modules/**/*.md` file that must **not** appear in the index.

Assertions:

1. Correct `.context` skeleton and router generated.
2. Stage contracts present with Inputs/Process/Outputs.
3. Ignore rules exclude planted vendored MD files.
4. **Incremental behavior:** second run leaves unchanged MD entries'
   `parsed_at` untouched; mutating one file causes only that file to re-parse;
   deleting a file removes its summary and manifest entry.

Tests run with `--no-ai` (deterministic; no CLI dependencies).

## Out of scope (v1)

- gitignore negation patterns (`!pattern`).
- Watch mode / git-hook integration.
- Migrating an existing `<repo>-context.md` into `.context/` (users just
  delete the old file).
- Modifying the host project's `CLAUDE.md`/`AGENTS.md`.

## README

Rewritten for: new requirements (Node >= 18; jq/bash dropped), the `.context`
output structure, ledger semantics, ignore-rule layering, and updated
install/usage examples.
