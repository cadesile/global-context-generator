---
name: icm-codebase-context
description: >
  Maintains this repo's .context/ knowledge base (ICM methodology) — a
  routed, stage-by-stage record of stack, architecture, data model,
  interfaces, docs, and synthesis. Use when the user asks about the
  codebase's structure, architecture, data model, or API surface; when
  .context/ is empty or missing (first run); or when a change you're
  making would make an existing .context/ stage output stale.
---

# icm-codebase-context

You are the agent that builds and maintains this repo's `.context/`
knowledge base by following ICM (Interpretable Context Methodology):
routed, stage-by-stage markdown instead of one monolithic file, so a future
agent (possibly you, in a later session) loads only what's relevant.

There is no generator script here and no AI subprocess to call — **you**
explore the repo with your own tools (Read/Glob/Grep/Bash) and write the
output yourself, following each stage's instructions.

## Triggers

| Situation | Action |
|---|---|
| `.context/stages/*/output/` all empty or missing | This is first run ("warming") — start at `stages/01_overview/CONTEXT.md` now, in this session |
| User asks "what stack/framework is this", "how is this structured", "where's the data model/API" | Read `.context/CONTEXT.md`, jump straight to the relevant stage's `output/` — don't re-run a stage that already has output just to answer a question |
| You just changed schema, migrations, or persisted state | Update `.context/stages/03_data/output/*.md` before finishing the task |
| You just added/changed routes, controllers, services, or an external API surface | Update `.context/stages/04_interfaces/output/*.md` before finishing the task |
| You just changed top-level architecture (new service, moved a directory, changed the framework) | Update `.context/stages/02_architecture/output/*.md`, and `.context/shared/stack.md` if the stack itself changed |
| User explicitly asks to (re)generate or refresh context | Re-run the relevant stage(s) in order, respecting each stage's Checkpoints — don't skip them because a prior run exists |
| First time this skill is being installed into a repo | Run `setup/questionnaire.md` before stage `01_overview` |

## How to use this skill

1. Read `CONTEXT.md` (in this same folder) — it routes your current task to
   the right stage.
2. Read `_core/conventions.md` once, if you haven't already this session —
   it defines the shape every stage's `CONTEXT.md` follows and the
   load-bearing patterns (Checkpoints, Audits, Canonical Sources).
3. Open the stage(s) `CONTEXT.md` names and follow its Process yourself.
   Never shell out to another AI CLI or subprocess to do this — you already
   have the tools.
4. Respect every Checkpoint — pause and let the human confirm or correct
   before continuing. Respect every Audit — run the checklist before
   writing to `output/`, not after.
5. Write output only to `.context/stages/<stage>/output/` in the **target**
   repo (the one you're working in), never inside this skill folder itself.
