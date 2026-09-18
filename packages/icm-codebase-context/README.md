# create-icm-context

Scaffolds an ICM (Interpretable Context Methodology) codebase-context skill
into a repo. A live agent session follows the skill to build and maintain
`.context/` — a routed, stage-by-stage record of the codebase's stack,
architecture, data model, and interfaces. No AI subprocess is involved
anywhere in this package; the installer only copies files.

## Install

```bash
npx create-icm-context /path/to/your/project
```

This copies the skill to `<project>/.agents/skills/icm-codebase-context/`,
scaffolds an empty `<project>/.context/` skeleton, injects a pointer into
`<project>/CLAUDE.md` (or `.claude/CLAUDE.md`/`AGENTS.md`/`GEMINI.md`,
whichever exists first) telling any agent that reads it to follow the
skill and treat `.context/` as this codebase's source of truth, and adds a
managed block to `.gitignore` for agent-specific pointer/local files.

`.context/` is committed and is the master. The per-agent pointer files
(`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, and their `*.local.*` variants) are
deliberately gitignored — thin, disposable references to `.context/`, not
the truth themselves. Re-run the installer any time to regenerate them
(e.g. after a fresh clone); the skill also recreates one on its own if it
notices `.context/` exists but no pointer does.

## What happens next

Open an agent session in the target repo. The injected pointer tells it to
read `.agents/skills/icm-codebase-context/SKILL.md` and, if
`.context/stages/*/` is still empty, start stage `01_overview` immediately
— exploring the real repo with its own tools, pausing at a checkpoint to
confirm what it found with you, then writing output. Later sessions get
the same instruction to keep each stage's output in sync with any change
that affects it.

## Layout

```
bin/install.js   # the scaffolder (this package's only executable)
lib/             # sentinel-block injection logic, shared by the installer
skill/           # the ICM skill itself — SKILL.md, CONTEXT.md, stages/, etc.
test/            # installer correctness tests (deterministic — no AI involved)
```

## Developing

```bash
node --test test/
```
