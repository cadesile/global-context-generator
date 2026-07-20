# `--dir` Flag — Design

**Date:** 2026-07-20
**Status:** Approved
**Extends:** `generate_project_context.js` (see 2026-07-20-icm-context-generator-design.md)

## Problem

The generator operates on `process.cwd()`, so using it from its own repo
against another project requires `cd`-ing there first (or copying the script
into each project).

## Design

New CLI flag `--dir <path>` — the target project root. Default: current
working directory (unchanged behavior).

- `parseArgs` gains `dir` (default `'.'`); value resolved in `main()` via
  `path.resolve(args.dir)` so relative paths work from any cwd.
- Validation before any filesystem write: if the resolved path is not an
  existing directory, print `Directory not found: <path>` to stderr and
  exit 1.
- `main()` uses the resolved path as `root` everywhere `process.cwd()` is
  used today. Everything is target-relative, exactly as if run after `cd`:
  `.context/` (ledger, ignore file, all stages), `--context-dir`, stack
  detection, the interactive subdirectory prompt, repo name (basename of
  target), and git activity (the `git()` helper already takes `root` as cwd).
- The generator's own repo is never touched when targeting another project.

## Testing

- Unit: `parseArgs([])` yields `dir: '.'`; `parseArgs(['--dir', 'x'])` yields
  `dir: 'x'`.
- Integration: from a cwd that is NOT the target, run the generator with
  `--dir <fixture copy>`; assert `.context/` is created inside the fixture
  and not in the cwd. Invalid path → exit 1, no writes.

## README

Add `--dir <path>` to the flags table and a "run from anywhere" example:
`node ~/path/to/generate_project_context.js --dir /some/place/local`.

## Out of scope

Positional-argument form; multiple targets per invocation.
