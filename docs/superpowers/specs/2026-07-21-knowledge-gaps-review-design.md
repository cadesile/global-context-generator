# Post-Generation Knowledge-Gap Review — Design

**Date:** 2026-07-21
**Status:** Approved
**Extends:** `generate_project_context.js` (see 2026-07-20-icm-context-generator-design.md)

## Problem

Static extraction and the existing 06_synthesis AI stage produce a factual
account of a codebase — schema, entities, routes, signatures, patterns — but
never surface what's *missing* or *ambiguous*: business rules that aren't
written down anywhere, sections that only came from a static-scan fallback
and were never verified live, service purposes nobody documented. Right now
a human has to read the whole `.context/` folder themselves to notice these
gaps. There's no step that reviews the generated folder as a whole and
produces a list of open questions for a human to resolve.

## Design

After all six numbered stages are written and the router regenerated, if an
AI CLI is available, make one more `callAi()` call that reviews the
generated `.context/` folder and writes `.context/KNOWLEDGE_GAPS.md` —
**outside** the numbered stage structure, since it's an action list for a
human to triage, not extracted/synthesized project context.

### Trigger

Same condition as 06_synthesis: runs whenever `ai.useAi` is true (no new
flag). If AI is unavailable (`--no-ai`, or no AI CLI on PATH), the step is
skipped entirely — no file is written, no stub, no placeholder. Absence of
the file is the signal that no review ran.

### Input construction

New helper `collectReviewContext(ctx, contextDir, stageIndex)`:

- Reads the **already-written** stage output files off disk (not
  recomputed from the extractor functions — everything for stages 01–06
  has already been written to `stages/*/output/*.md` by this point in
  `main()`).
- Budget: ~12,000 chars total. Priority order: `03_data/*` and
  `04_interfaces/*` first (schema/entities/routes/services — the densest
  source of real business-logic gaps), then `01_overview`, `02_architecture`,
  `05_documentation/index.md`, `06_synthesis/*` filling whatever budget
  remains. Same truncate-when-budget-exhausted pattern as
  `collectAiContextFiles`.
- Always also includes the extraction-provenance table already held in
  `stageIndex` (small — doesn't compete for the content budget). This lets
  the model see which outputs came from a static-scan fallback or were
  `unavailable`, so it can flag "this was never verified live" as a gap in
  its own right.

### Prompt

Goes through the same `callAi()` chokepoint as every other AI call, so it
inherits `stripModelPreamble()` automatically. Applies the same grounding
discipline the 06_synthesis prompts were tightened to:

- Up to 8 gaps. Return fewer if fewer are genuinely evidenced — no padding
  with generic gaps that could apply to any project of this framework.
- Every gap must cite a specific file/class/section from the input.
- Fixed per-gap template:

  ```
  ## <short topic>
  **Question:** <specific open question a human/agent needs to answer>
  **Why it matters:** <concrete consequence, tied to the cited file/class>
  ```

`KNOWLEDGE_GAPS.md` = `# Knowledge Gaps\n\n` + the model's bullets, written
via a plain `fs.writeFileSync` (not `writeStage` — no CONTEXT.md contract,
since it isn't a numbered stage).

### Router integration

If `KNOWLEDGE_GAPS.md` was written, `writeRouter()` gets a new one-line
pointer near the top (after the "how to use this folder" list), e.g.:

> Unresolved: see `KNOWLEDGE_GAPS.md` for open questions this generation run
> couldn't answer from the code alone.

so agents navigating via the router discover it instead of only humans
stumbling on it in the file tree.

### Manifest

No new manifest fields — this isn't a tracked stage with a ledger; whether
it ran is fully visible from the file's presence/absence.

## Testing

- Unit: `collectReviewContext` — budget truncation, priority order
  (03_data/04_interfaces before 01/02/05/06), provenance table always
  included regardless of budget.
- Integration: extend `test/fixtures/bin/fake-ai.js` to detect a "knowledge
  gap" marker in the prompt text (already receives the full prompt as an
  argv value) and return a canned gaps-shaped response distinct from its
  existing canned synthesis response. Run the generator with `--ai
  <fake-ai.js>` against the symfony-app fixture and assert:
  - `.context/KNOWLEDGE_GAPS.md` exists and matches the per-gap template.
  - The router (`CONTEXT.md`) contains the pointer line.
  - A `--no-ai` run against the same fixture produces no
    `KNOWLEDGE_GAPS.md` and no router pointer.

## README

Add a short section: `KNOWLEDGE_GAPS.md` is generated automatically
whenever AI is available, lists open questions the generator couldn't
answer from the code alone, is meant to be triaged/resolved by a human (the
tool does not attempt to answer them itself), and simply won't exist on a
`--no-ai` run.

## Out of scope

- Any mechanism for the user to answer/resolve a gap through the tool
  (e.g. writing answers back into CLAUDE.md) — this only produces the list.
- Configurable gap count or budget size via CLI flags.
- Persisting gaps across runs / diffing against a previous run's gap list.
