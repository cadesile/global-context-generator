# generate_project_context

Generates an ICM `.context/` folder structure for any project — numbered
stages of focused markdown context that AI agents can navigate selectively,
instead of one monolithic context file.
Based on the Interpretable Context Methodology (https://arxiv.org/html/2603.16021v2).

## Requirements

- Node.js >= 18 (no npm dependencies)
- git _(optional — enables git activity + AI focus sections)_
- Claude CLI or Gemini CLI _(optional — enables AI summaries and stack disambiguation)_

## Installation

**Option 1 — project-local**

Copy `generate_project_context.js` into your project.

**Option 2 — global**

```bash
cp generate_project_context.js /usr/local/bin/generate_project_context
chmod +x /usr/local/bin/generate_project_context
```

## Usage

```bash
node generate_project_context.js [--no-ai] [--ai <claude|gemini>] [--context-dir <dir>] [--depth <n>] [--dir <path>] [--debug-detection]
```

| Flag | Description | Default |
|---|---|---|
| `--no-ai` | Skip all AI calls, static extraction only | AI enabled |
| `--ai <claude\|gemini>` | Choose which AI CLI to use | `claude` |
| `--context-dir <dir>` | Directory to write the context tree into | `.context` |
| `--depth <n>` | Directory tree depth | `3` |
| `--dir <path>` | Target project root (run the generator from anywhere) | current directory |
| `--debug-detection` | Print detected stack/environment JSON and exit — read-only, writes nothing | off |

### Examples

```bash
# Generate context for the current project
node generate_project_context.js

# Generate context for another project without cd-ing into it
node ~/Projects/global-context-generator/generate_project_context.js --ai gemini --dir /some/place/local
```

## Stack detection

The generator runs a four-step resolution process before writing anything:

1. **Root scan** — looks for framework manifests (`composer.json`, `package.json`, `go.mod`, `Gemfile`, `requirements.txt`) at the project root.
2. **Subdir scan** — scans common backend directory names (`backend/`, `api/`, `server/`, `app/`, `web/`) for the same manifests, independent of the root scan.
3. **AI disambiguation** — when the result is ambiguous (e.g. a frontend `package.json` at root _and_ a Symfony `composer.json` in `backend/`), the AI CLI reads `CLAUDE.md`, `README.md`, and the manifests to determine which stack is primary and where the app code lives.
4. **TTY fallback** — if AI is unavailable and the stack is still ambiguous, you are prompted to enter the app subdirectory path.

This means projects with a frontend build tool (`package.json` for webpack, Vite, etc.) co-located alongside a PHP, Go, or Python backend are handled correctly — the primary backend stack always wins.

Resolved stack details (framework, `appDir`, `primaryExt`, `modelsDir`, etc.) flow into every subsequent stage so entity paths, schema scanners, section labels, and DB hints are all computed from the correct stack.

## Output structure

```
.context/
  CONTEXT.md                     # router — stage index, links into each stage
  _config/
    ignore                       # seeded once with defaults; never overwritten
    manifest.json                # parse ledger (written last, after all stages)
  stages/
    01_overview/     CONTEXT.md + output/   # stack, environment, metrics
    02_architecture/ CONTEXT.md + output/   # directory structure, git activity
    03_data/         CONTEXT.md + output/   # schema, entities, state, migrations
    04_interfaces/   CONTEXT.md + output/   # routes, controllers, services, API spec
    05_documentation/CONTEXT.md + output/   # markdown docs index + per-file digests/summaries
    06_synthesis/    CONTEXT.md + output/   # AI overview, architecture notes, dev focus (skipped without AI)
```

Each stage's `CONTEXT.md` documents its own **Inputs**, **Process**, and
**Outputs** so an agent can decide whether to open that stage at all.

## The ledger (incremental re-runs)

`_config/manifest.json` tracks every markdown file the documentation stage has
parsed, keyed by repo-relative path:

- **sha256 skip** — if a file's hash and its existing digest/summary output are
  unchanged since the last run, it's skipped (no re-parse, no AI call).
- **AI upgrade** — a file previously parsed with `--no-ai` gets re-parsed and
  upgraded to an AI summary the next time AI is available, even if its content
  hasn't changed.
- **Deletion cleanup** — files removed from the repo since the last run are
  dropped from the ledger and their digest/summary output is deleted.
- **Manifest written last** — `manifest.json` is only written after every
  stage (including the router) has finished, so a run that fails partway
  through never leaves a ledger pointing at outputs that don't exist.

## Ignore rules

Three layers apply in order, each adding to the last:

1. **Built-in defaults** — `node_modules`, `vendor`, `.git`, `dist`, `build`,
   `.next`, `__pycache__`, `.venv`, etc.
2. **Repo `.gitignore`** — read from the project root, if present.
3. **`.context/_config/ignore`** — seeded once with the defaults on first run,
   then left alone; edit it freely to exclude project-specific paths. It is
   never overwritten by later runs.

Patterns use gitignore-style syntax (comments, blank lines, `*`/`?`/`**`
globs, trailing `/` for directories, leading `/` to anchor at the repo root).
**Negation (`!`) is not supported** and such lines are ignored.

## Supported stacks

| Stack | Schema | Entities | State |
|---|---|---|---|
| Symfony | Doctrine migrations + entity columns | `#[ORM]` property map | — |
| Laravel | `database/migrations` + field chains | Eloquent `$fillable`, casts, relations | — |
| Next.js / Express / Node | SQL/`.sql` files or `schema.ts` | TypeScript interfaces & types | Zustand store shapes |
| Django | Latest migrations | `models.py` class + field definitions | — |
| Rails | `db/schema.rb` | ActiveRecord associations + validations | — |
| Go | Struct definitions | Type definitions | — |

Framework-specific stacks (Symfony, Laravel, Django, etc.) always take priority
over a generic Node detection so that projects with frontend tooling (`webpack`,
`vite`, etc.) alongside a backend framework are classified correctly.

## For agents

Read `.context/CONTEXT.md` first; it's the router into the stage index. Load
only the stage `output/` files you actually need for the task at hand instead
of pulling the whole tree into context.

## Tests

```bash
node --test
```
