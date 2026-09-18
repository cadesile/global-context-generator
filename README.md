# icm-codebase-context

This repo is home to `packages/icm-codebase-context/` — a portable
**skill package** implementing ICM (Interpretable Context Methodology,
https://arxiv.org/html/2603.16021v2, reference implementation at
github.com/RinDig/Interpretable-Context-Methodology) for documenting an
existing codebase.

It used to be a Node script (`generate_project_context.js`) that shelled
out to an AI CLI as a subprocess to mechanically generate a `.context/`
folder. That approach has been retired — it fought the methodology rather
than implementing it. ICM's own reference implementation has no generator
script at all: it's natural-language instructions a *live agent* follows
conversationally, exploring the real repo with its own tools, pausing at
human-reviewed checkpoints, and running an audit before writing anything.
A subprocess-driven script structurally can't do any of that, and in
practice it produced confidently wrong results (see "Why this exists"
below).

## What it is

A folder of routed, stage-by-stage markdown that a future agent session
loads selectively instead of pulling one monolithic context file into
every conversation:

```
Layer 0: SKILL.md            "Where am I?"
Layer 1: CONTEXT.md          "Where do I go?"
Layer 2: Stage CONTEXT.md    "What do I do?"
Layer 3: Reference material  "What rules apply?"
Layer 4: Working artifacts   "What am I working with?"
```

Stage boundaries are also human-review points: each stage's `CONTEXT.md`
defines Checkpoints (the agent pauses and presents a finding before
continuing) and an Audit (a checklist the agent runs before writing
output). A human can hand-edit any `output/` file directly and the next
run treats that edit as authoritative.

## Installing it into a repo

```bash
npx create-icm-context /path/to/your/project
```

This is pure file-copy scaffolding — **no AI calls, no subprocess**. It:

1. Copies the skill into `<target>/.agents/skills/icm-codebase-context/`
   (deliberately not `.claude/skills/` — this works with any agent that
   reads `CLAUDE.md`/`AGENTS.md`/`GEMINI.md`, not just Claude Code).
2. Creates an empty `<target>/.context/` skeleton (a router file plus one
   directory per stage — no content yet).
3. Injects a pointer block into the target repo's `CLAUDE.md` **and**
   `AGENTS.md` — both are always created if missing, or injected into if
   they already exist. (`AGENTS.md` specifically because it's an
   increasingly vendor-neutral convention other agents beyond Claude Code
   check for by default — always having it maximizes which agents see the
   pointer.) `.claude/CLAUDE.md` and `GEMINI.md` are touched too, but only
   if the target repo already uses them — never created from scratch. Every
   pointer tells the agent to follow the installed skill and treat
   `.context/` as the source of truth, and to explicitly surface this to
   the human and ask before running setup, rather than staying silent or
   running it unasked.
4. Adds a managed block to the target repo's `.gitignore` covering
   agent-specific pointer and local-settings files (`CLAUDE.md`,
   `CLAUDE.local.md`, `.claude/settings.local.json`, `AGENTS.md`,
   `GEMINI.md`, and equivalents for other prominent agents). `.context/`
   is the master, committed source of truth — these files are thin,
   disposable pointers to it, not tracked in git. Anyone can regenerate
   their own by re-running the installer; the skill itself also knows to
   recreate one if it notices `.context/` exists but no pointer does (see
   `skill/SKILL.md`'s Triggers table).

## "Warming" — how the actual content gets written

There is no separate warm command. Warming is just the pointer block's own
instruction, acted out by whatever agent session is already running: open
the repo, read `CLAUDE.md`, see the pointer, read
`.agents/skills/icm-codebase-context/SKILL.md`, and — if
`.context/stages/*/` is still empty — start stage `01_overview` right then,
in that same session. Every later session gets the same instruction: if
you make a change that affects a stage's documented content (a schema
change, a new route, a new module), update that stage's `output/` as part
of finishing the task, not as a separate step.

There's still no separate warm *script* — nothing shells out to an AI CLI
or subprocess (`skill/SKILL.md` rules that out explicitly). But a human
doesn't have to wait to be asked either: saying "warm", "warm the
context", or `/icm-context warm` in any live agent session is a
recognized trigger (see `skill/SKILL.md`'s Triggers table) that tells the
agent to fill every stage whose `output/` is still empty, in order,
right then — respecting each stage's Checkpoints and Audits like any
other run.

## Stages

| Stage | Covers |
|---|---|
| `01_overview` | Stack, language, framework, dev environment |
| `02_architecture` | Directory layout, module boundaries, git activity |
| `03_data` | Schema, entities, client-side state, migrations |
| `04_interfaces` | Routes, controllers, services, external API surface |
| `05_ui` | Design-system tokens (color/typography/spacing) and shared component styling |
| `06_documentation` | Index of existing markdown docs already in the repo |
| `07_synthesis` | Cross-stage overview, architectural notes, current focus |

## Why this exists

A real run of the old script against a Shopify Liquid theme project
misdetected it as a generic "php" project — a near-empty `composer.json`
sitting next to a fully Shopify-shaped `package.json` and directory tree
was enough to short-circuit detection before the script's AI pass ever ran.
The fix isn't a smarter heuristic; it's removing the assumption that a
script can reliably substitute for an agent actually looking at the repo
and a human confirming what it found. Stage `01_overview`'s checkpoint
exists specifically to catch this class of mistake — see
`packages/icm-codebase-context/skill/stages/01_overview/CONTEXT.md`.

## Repo layout

```
packages/icm-codebase-context/   # the package: bin/install.js, lib/, skill/, test/
docs/2603.16021v2.pdf            # the ICM paper
docs/superpowers/                # dated design records from this repo's history — not living docs
```

## Developing this package

```bash
cd packages/icm-codebase-context
node --test test/
```
