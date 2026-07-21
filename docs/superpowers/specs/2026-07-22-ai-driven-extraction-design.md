# AI-Driven Extraction for 03_data / 04_interfaces — Design

**Date:** 2026-07-22
**Status:** Approved
**Extends:** `generate_project_context.js` (see 2026-07-20-icm-context-generator-design.md)

## Problem

The generator's schema/entity/route/controller/service extraction is a stack
of per-framework regex scanners (`_schemaDoctrine`, `_schemaLaravel`,
`_entitiesEloquent`, `_routesSymfonyStatic`, `signatureScan` +
`SIGNATURE_PATTERNS`, etc.) that assume a known MVC-style convention
(`modelsDir`, `controllersDir`, `servicesDir`). Running it against a
WordPress codebase (or any stack outside the known enum) produces mostly
gaps: no known convention to point at, so nothing gets extracted, even
though a human — or an AI — reading the same files could describe the data
model and request-handling code just fine. Hand-coding a scanner per
framework doesn't scale and will never cover every real-world layout.

## Design

### Scope split

**Stays deterministic (Node, unchanged):** directory tree (`treeBlock`), git
log/activity (`gitActivityBlock`), file/component counts (`metricsBlock`),
stack/dev-env/DB-hint detection (`detectStack`, `detectDevEnv`,
`detectDatabases`, `extractVersions`), `.env` listing (`envBlock`), the
ignore engine, and all file/stage writing (`writeStage`, `writeRouter`,
`seedIgnoreFile`). These are cheap, reliable, and don't need interpretation.

**Becomes AI-driven:** `schema.md`, `entities.md`, `state.md` (03_data) and
`routes.md`, `controllers.md`, `services.md` (04_interfaces), alongside the
already-AI-driven `06_synthesis` and `KNOWLEDGE_GAPS.md`.

### AI becomes mandatory

`--no-ai` is removed from `parseArgs`. `checkAiAvailable` (or its
replacement) becomes a hard gate in `main()`: if no AI CLI is detected on
PATH, print an error ("this generator requires an AI CLI — install `claude`
or `gemini`") and `process.exit(1)` before any filesystem writes. There is
no flag to intentionally bypass this.

### Two-pass extraction

**Pass 1 — discovery (1 AI call, `discoverCodeShape(ctx)`):** feed the
directory tree (already computed via `treeBlock`) plus the manifest file(s)
(`composer.json`/`package.json`/etc., already read for stack detection) and
ask the AI to classify paths into up to four categories:

```
DATA_MODEL: <comma-separated paths>
ROUTES: <comma-separated paths>
BUSINESS_LOGIC: <comma-separated paths>
STATE: <comma-separated paths>
```

(Same structured-text-response pattern the existing `aiDetermineStack`
already uses for `STACK:`/`APPDIR:` — parsed with the same style of regex,
no JSON parsing dependency.) Paths the AI names are validated against
`walkFiles()`'s actual output before use; anything that doesn't exist on
disk (a hallucinated path) is silently dropped. An empty category is valid
and means "generation for the files this maps to is skipped, not retried."

**Pass 2 — generation (up to 6 AI calls, one per output file):** input to
each call is the concatenated content of that category's validated
discovered paths, budgeted to 12,000 chars (same default as
`collectReviewContext`'s existing budget, truncating file-by-file once the
budget is hit) plus — when the output file already exists — its current
full content prepended as "existing output to revise" (not itself
budgeted/truncated, since it's markdown we generated, not raw source, and
is expected to be much smaller than the source budget).

| Output file | Discovery category | Prompt asks for |
|---|---|---|
| `schema.md` | `DATA_MODEL` | DB/storage shape: tables, columns, constraints |
| `entities.md` | `DATA_MODEL` | Code-level entity/type shape: classes, fields, relationships |
| `state.md` | `STATE` | Client-side store/state shape (Redux/Zustand/etc.) |
| `routes.md` | `ROUTES` | HTTP routes/endpoints: method, path, handler |
| `controllers.md` | `ROUTES` | Handler/controller signatures |
| `services.md` | `BUSINESS_LOGIC` | Service/business-logic class or function signatures |

Each generation call is skipped (no AI call, no file written) if its
discovery category came back empty after validation — writes an explicit
`_No <category>-relevant files found in this codebase._` note instead, so
absence reads as "looked and found nothing," distinct from other files'
possible absence for other reasons.

**Output-shape contract (binding on every generation prompt):** the
existing per-entity template — `#### \`Name\`` heading immediately followed
by a fenced code block — must be preserved exactly. This is not
cosmetic: `extractDomainNotes`/`annotateWithDomainNotes`/
`dedupeGotchaHits`/`extractDeclaredFieldNames` (the CLAUDE.md
Key-Entities/Key-Gotchas merge) all parse this exact structure
post-hoc, and must keep working unchanged against AI-generated content.
Every generation prompt's instructions must state the required template
literally, with an example.

### Review-before-amend (not blind regeneration)

If an output file already exists (from a previous run, or hand-edited by a
human directly), pass 2's prompt includes that existing content and asks
the AI to **update** it — preserve what's still accurate (including
anything a human added), remove what's no longer true, add what's new —
rather than regenerating from scratch. This applies whenever a generation
call actually runs, independent of who last touched the file.

### Caching (manifest-ledger based)

Discovery (pass 1) always re-runs — it's one cheap call and needs to catch
newly created files. Generation (pass 2) is cached per category in
`manifest.json`:

```json
{
  "stages": {
    "03_data": {
      "extraction": {
        "schema.md":   { "source_hash": "a1b2c3", "last_reviewed_at": "2026-07-01T00:00:00Z" },
        "entities.md": { "source_hash": "d4e5f6", "last_reviewed_at": "2026-07-10T00:00:00Z" }
      }
    }
  }
}
```

`source_hash` = sha256 of the concatenated content of that category's
validated, discovered paths (order-independent — sort paths before
concatenating). A generation call is skipped (existing file left untouched)
only if **both**: the hash matches the last recorded hash for that
category, **and** `last_reviewed_at` is less than 30 days ago. Otherwise
the call runs (as a review-and-amend per above) and both fields update.

### Extraction provenance (replaces `staticScanMethod`/`routesMethod`)

The router's existing "Extraction provenance" table and per-file manifest
entries stay — the labels just change to reflect AI-driven extraction:

- `ai-generated` — generation ran this time (cache miss or stale-review).
- `ai-cached (last reviewed YYYY-MM-DD)` — hash matched and within the
  30-day window, call skipped, existing content reused as-is.
- `ai-no-relevant-files-found` — discovery's category for this file came
  back empty (after path validation); no generation call was made.

### Removed

`_schemaSqlite`, `_schemaDoctrine`, `_schemaLaravel`, `_schemaDjango`,
`_schemaRails`, `_schemaGo`, `schemaBlock`, `_entitiesTypescript`,
`_entitiesDoctrine`, `_entitiesEloquent`, `_entitiesDjango`,
`_entitiesRails`, `entitiesBlock`, `stateBlock`, `SIGNATURE_PATTERNS`,
`signatureScan`, `modelsBlock`, `controllersBlock`, `servicesBlock`,
`_routesSymfonyStatic`, `_routesLaravelStatic`, `routesBlock`,
`extractSqlStatements`, `staticScanMethod`, `routesMethod`. `hasServerFramework`
is removed as a *gate* (04_interfaces no longer skips based on stack) — AI
discovery naturally reports "no routes found" for a stack with none, same
outcome, no special-casing. `sectionLabels` is simplified (still needed for
`schema`/`entities`/`state` heading text in 01_overview's stack label, but
no longer needs per-framework branches once framework name is just used
literally in the heading rather than picking a scanner).

`extractBlocks` stays — it's still used elsewhere (this design doesn't
touch it) unless a later audit finds no remaining caller.

### Testing

`test/fixtures/bin/fake-ai.js` extends its prompt-content branching to
cover: discovery prompts (returns canned `DATA_MODEL:`/`ROUTES:`/etc. lines
naming real paths in whichever fixture repo is under test) and all 6
generation prompt shapes (returns canned markdown in the required
heading+codefence template). Existing tests that pass `--no-ai` are
migrated to `--ai <fake-ai-path>`; tests that directly call now-deleted
functions (`schemaBlock`, `entitiesBlock`, `routesBlock`,
`signatureScan`, `hasServerFramework`, `extractSqlStatements`, and their
associated unit tests in `test/unit.test.js`/`test/detection.test.js`) are
removed and replaced with integration tests exercising the new
discovery→generation flow through the fake AI CLI. The
`dedupeGotchaHits`/`extractDomainNotes`/`annotateWithDomainNotes` tests
stay as-is (they test the merge logic in isolation, independent of where
`entities.md`'s raw content comes from).

## Out of scope

- A CLI flag to configure the 30-day staleness threshold (hardcoded
  constant for now).
- Discovery categories beyond the four listed (e.g. a separate "API spec"
  or "config" category) — `api-spec.md`'s existing OpenAPI-file-specific
  handling is untouched by this design.
- Migrating `06_synthesis`/`KNOWLEDGE_GAPS.md` prompts — already AI-driven,
  unaffected by this design.
- Parallelizing the up-to-6 pass-2 AI calls — sequential for now, matching
  the existing sequential `callAi()` usage pattern elsewhere in `main()`.
