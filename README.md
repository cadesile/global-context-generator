# generate_project_context

Auto-detects your tech stack and generates a single markdown context file for your project. Extracts database schemas, entity definitions, state shapes, routes, and services — structured for AI agents and easy to share. Supports React Native, Symfony, Laravel, Django, Rails, and Go.

---

## Supported Stacks

| Stack | Schema | Entities | State |
|---|---|---|---|
| React Native / Expo | SQLite (`schema.ts` / `.sql`) | TypeScript interfaces & types | Zustand store shapes |
| Symfony | Doctrine migrations + entity columns | `#[ORM]` property map | — |
| Laravel | `database/migrations` + field chains | Eloquent `$fillable`, casts, relations | — |
| Django | Latest migrations | `models.py` class + field definitions | — |
| Rails | `db/schema.rb` | ActiveRecord associations + validations | — |
| Go | Struct definitions | Type definitions | — |

---

## Installation

### Option 1 — project-local

Copy the script into your project and make it executable:

```bash
cp generate_project_context.sh /your-project/scripts/generate_project_context.sh
chmod +x /your-project/scripts/generate_project_context.sh
```

Run from your project root:

```bash
bash scripts/generate_project_context.sh
```

### Option 2 — global (run from any project)

```bash
cp generate_project_context.sh /usr/local/bin/generate_project_context
chmod +x /usr/local/bin/generate_project_context
```

Then from any project root:

```bash
generate_project_context
```

---

## Requirements

- **bash** 3.2+
- **jq** — for JSON parsing (`brew install jq` / `apt install jq`)
- **git** — for commit history and recent activity
- **tree** _(optional)_ — for richer directory output (`brew install tree`)
- **Claude CLI or Gemini CLI** _(optional)_ — for AI-generated summaries (`npm install -g @anthropic-ai/claude-code`)

---

## Usage

```bash
bash generate_project_context.sh [options]
```

### Options

| Flag | Description | Default |
|---|---|---|
| `--no-ai` | Skip all AI calls, static extraction only | AI enabled |
| `--ai <claude\|gemini>` | Choose which AI CLI to use | `claude` |
| `--output-dir <dir>` | Directory to write the output file | `docs` |
| `--depth <n>` | Directory tree depth | `3` |
| `--debug-detection` | Print detected stack variables and exit | off |

### Examples

```bash
# Static only — fast, no AI required
bash generate_project_context.sh --no-ai

# Use Gemini instead of Claude
bash generate_project_context.sh --ai gemini

# Write output to the project root
bash generate_project_context.sh --output-dir .

# Debug what the script detected about your stack
bash generate_project_context.sh --debug-detection
```

---

## Output

The script writes a single markdown file to `<output-dir>/<repo-name>-context.md`.

It contains:

- **Overview** — auto-detected stack, database, dev environment
- **Document Context** — links to all markdown files in the project
- **Metrics** — file counts by language, entity/controller/service counts
- **Technology Stack** — framework, versions, dependencies
- **Project Structure** — directory tree
- **Data Models** — model/entity file signatures
- **Database Schema** — CREATE TABLE blocks, migrations, or schema files (stack-dependent)
- **Entity Definitions** — full type/interface/model definitions (stack-dependent)
- **Store Shapes** — state interface declarations (React Native / Node only)
- **API Routes** — extracted route table or raw route list
- **Controllers** — public method signatures
- **Services** — public method signatures
- **Migrations** — latest migration files
- **Environment Variables** — masked `.env` / `.env.example`
- **Development Setup** — start commands for detected dev environment
- **Recent Git Activity** — last 15 commits
- **Architecture Notes** — AI-generated pattern analysis (if AI enabled)
- **Current Development Focus** — AI-generated from recent commits (if AI enabled)
- **API Specification** — parsed OpenAPI/Swagger spec (if found and AI enabled)

---

## How it works

1. **Stack detection** — inspects `composer.json`, `package.json`, `go.mod`, `Gemfile`, `requirements.txt` etc. to identify framework and language
2. **Dev environment detection** — checks for Lando, Docker Compose, devcontainer, or Makefile
3. **Database detection** — scans config files for MySQL, PostgreSQL, SQLite, MongoDB, Redis hints
4. **Static extraction** — pulls schemas, types, store shapes, routes, and service signatures using `grep` and `awk`
5. **AI analysis** _(optional)_ — passes extracted content to Claude or Gemini for project overview, architecture notes, and development focus

If the stack cannot be detected in the repo root, the script will prompt for a subdirectory path.
