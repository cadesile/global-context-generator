# Knowledge-Gap Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After all six ICM stages are generated, if an AI CLI is available, run one more AI call that reviews the whole `.context/` folder and writes a top-level `.context/KNOWLEDGE_GAPS.md` listing open questions a human should resolve.

**Architecture:** A new budgeted-context helper (`collectReviewContext`) reads the already-written stage output files off disk in priority order (03_data/04_interfaces first) plus the extraction-provenance table, feeds them to one more `callAi()` call (so it automatically inherits `stripModelPreamble()`), and writes the result to `.context/KNOWLEDGE_GAPS.md` — outside the numbered stage structure. The router gets a conditional one-line pointer to it. No new CLI flag; it runs whenever AI is available, same as 06_synthesis, and is skipped (no file at all) otherwise.

**Tech Stack:** Node.js (no dependencies), `node:test` for tests — matches the rest of `generate_project_context.js`.

## Global Constraints

- Node.js >= 18, no npm dependencies (spec: 2026-07-20-icm-context-generator-design.md).
- No new CLI flag — triggered by the same `ai.useAi` condition as 06_synthesis.
- `KNOWLEDGE_GAPS.md` lives at `.context/KNOWLEDGE_GAPS.md` (top-level), never inside `stages/`.
- Under `--no-ai` or no AI CLI on PATH: no file written, no router pointer, no stub.
- Every AI call goes through the existing `callAi(aiCli, prompt)` — do not bypass it (that's what gives this feature the preamble-stripping fix for free).
- Every gap must cite a specific file/class/section from the input; cap at 8 gaps; return fewer rather than padding with generic filler (same discipline already applied to the 06_synthesis prompts).

---

### Task 1: `buildExtractionRows` helper + router pointer to `KNOWLEDGE_GAPS.md`

**Files:**
- Modify: `generate_project_context.js:1289-1325` (the `writeRouter` function)
- Modify: `generate_project_context.js:1483-1494` (module.exports)
- Test: `test/unit.test.js`

**Interfaces:**
- Produces: `buildExtractionRows(stageIndex) -> string[]` (one `| \`stage/file\` | method |` row per stage output with a recorded `extraction` method) — used by both `writeRouter` and, in Task 2, `collectReviewContext`.
- Modifies: `writeRouter(root, contextDir, { repoName, label, stageIndex, hasKnowledgeGaps })` — new optional `hasKnowledgeGaps` field in the options object; when true, the router body includes a line pointing at `KNOWLEDGE_GAPS.md`.

Currently `writeRouter` builds its extraction-provenance rows inline with a `.filter().flatMap()` chain. Task 2 needs the identical row-building logic for the AI review's input, so this task extracts it into a shared helper first (DRY) and adds the new pointer line while it's already touching this function.

- [ ] **Step 1: Write the failing test**

Add to `test/unit.test.js` (after the existing `parseArgs --dir` test):

```js
test('writeRouter adds a KNOWLEDGE_GAPS.md pointer only when hasKnowledgeGaps is true', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'router-'));
  fs.mkdirSync(path.join(tmp, '.context'), { recursive: true });
  const stageIndex = [{ stage: '01_overview', purpose: 'p', files: [] }];

  g.writeRouter(tmp, '.context', { repoName: 'demo', label: 'node', stageIndex, hasKnowledgeGaps: true });
  const withGaps = fs.readFileSync(path.join(tmp, '.context/CONTEXT.md'), 'utf8');
  assert.match(withGaps, /Unresolved: see `KNOWLEDGE_GAPS\.md`/);

  g.writeRouter(tmp, '.context', { repoName: 'demo', label: 'node', stageIndex, hasKnowledgeGaps: false });
  const withoutGaps = fs.readFileSync(path.join(tmp, '.context/CONTEXT.md'), 'utf8');
  assert.ok(!withoutGaps.includes('KNOWLEDGE_GAPS.md'));
});

test('buildExtractionRows produces one row per recorded extraction method', () => {
  const stageIndex = [
    { stage: '03_data', extraction: { 'schema.md': 'static-regex-scan' } },
    { stage: '02_architecture' }, // no extraction field — must be skipped, not throw
  ];
  assert.deepStrictEqual(g.buildExtractionRows(stageIndex), ['| `03_data/schema.md` | static-regex-scan |']);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/unit.test.js`
Expected: FAIL — `g.writeRouter is not a function` is already exported so it will run but fail the assertion (no pointer line exists yet); `g.buildExtractionRows` is not a function (not yet defined/exported).

- [ ] **Step 3: Implement `buildExtractionRows` and update `writeRouter`**

Replace `generate_project_context.js:1289-1325`:

```js
// Shared by writeRouter() and collectReviewContext() (Task 2) — one row per
// stage output whose extraction method was recorded (see buildStages01to04()).
function buildExtractionRows(stageIndex) {
  return stageIndex
    .filter((s) => s.extraction && Object.keys(s.extraction).length)
    .flatMap((s) => Object.entries(s.extraction).map(([file, method]) => `| \`${s.stage}/${file}\` | ${method} |`));
}

function writeRouter(root, contextDir, { repoName, label, stageIndex, hasKnowledgeGaps }) {
  const rows = stageIndex.map(({ stage, purpose, files }) =>
    `| \`stages/${stage}/\` | ${purpose} | ${files.map((f) => `\`${f.rel}\` (${f.bytes}b)`).join(', ') || '—'} |`).join('\n');
  const extractionRows = buildExtractionRows(stageIndex).join('\n');
  const gapsNote = hasKnowledgeGaps
    ? "\nUnresolved: see `KNOWLEDGE_GAPS.md` for open questions this generation run couldn't answer from the code alone.\n"
    : '';
  const md = `# ${repoName} — Project Context (.context)

> Generated: ${new Date().toISOString()} · Stack: ${label} · Generator: v${GENERATOR_VERSION} (${GENERATOR_COMMIT})

This folder is an **ICM (Interpretable Context Methodology)** context structure
(https://arxiv.org/html/2603.16021v2): numbered stages, each with a CONTEXT.md
contract (Inputs / Process / Outputs) and an output/ folder of focused markdown.

## How to use this folder (for agents)

1. Read this router.
2. Pick the stages relevant to your task from the index below (numbering = recommended reading order).
3. Read each chosen stage's CONTEXT.md, then load only the output files you need.
4. Do not load every file — the structure exists so you can scope your context.
5. Check the extraction provenance table below before trusting a section — some
   outputs come from a static best-effort scan rather than a live, resolved
   source, and that changes how much weight to give them.
${gapsNote}
Regenerate with: \`node generate_project_context.js\`. Ignore rules live in
\`_config/ignore\`; the parse ledger and per-stage extraction provenance in
\`_config/manifest.json\`.

## Stage index

| Stage | Purpose | Output files |
|---|---|---|
${rows}
${extractionRows ? `\n## Extraction provenance\n\n| Output | Method |\n|---|---|\n${extractionRows}\n` : ''}`;
  fs.writeFileSync(path.join(root, contextDir, 'CONTEXT.md'), md);
}
```

In `generate_project_context.js:1491` (module.exports), change:

```js
  writeStage, seedIgnoreFile, stackLabel, devSetupBlock, buildStages01to04, writeRouter,
```
to:
```js
  writeStage, seedIgnoreFile, stackLabel, devSetupBlock, buildStages01to04, writeRouter, buildExtractionRows,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/unit.test.js`
Expected: PASS — both new tests green, no other test in the file regresses.

- [ ] **Step 5: Commit**

```bash
git add generate_project_context.js test/unit.test.js
git commit -m "Extract buildExtractionRows helper and add router pointer to KNOWLEDGE_GAPS.md"
```

---

### Task 2: `collectReviewContext` — budgeted, priority-ordered input for the review call

**Files:**
- Modify: `generate_project_context.js` — add new function near `collectAiContextFiles` (around line 862), and add to module.exports
- Test: `test/unit.test.js`

**Interfaces:**
- Consumes: `buildExtractionRows(stageIndex)` from Task 1; `readText(p)` (existing helper, `generate_project_context.js:38`).
- Produces: `collectReviewContext(root, contextDir, stageIndex, budget = 12000) -> string` — used by Task 3's `main()` wiring. `stageIndex` entries are `{ stage, files: [{ rel, bytes }], extraction? }`, matching what `main()` already builds and pushes at `generate_project_context.js:1390/1404/1467`.

- [ ] **Step 1: Write the failing tests**

Add to `test/unit.test.js`:

```js
test('collectReviewContext prioritizes 03_data/04_interfaces content before earlier stages', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'review-ctx-'));
  const write = (stage, file, content) => {
    fs.mkdirSync(path.join(tmp, '.context/stages', stage, 'output'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '.context/stages', stage, 'output', file), content);
  };
  write('01_overview', 'stack.md', 'STACK CONTENT');
  write('03_data', 'schema.md', 'SCHEMA CONTENT');
  const stageIndex = [
    { stage: '01_overview', files: [{ rel: 'output/stack.md' }] },
    { stage: '03_data', files: [{ rel: 'output/schema.md' }] },
  ];
  const out = g.collectReviewContext(tmp, '.context', stageIndex, 1000);
  assert.ok(out.includes('SCHEMA CONTENT') && out.includes('STACK CONTENT'));
  assert.ok(out.indexOf('SCHEMA CONTENT') < out.indexOf('STACK CONTENT'), '03_data content must come before 01_overview content');
});

test('collectReviewContext truncates stage content to the budget but always appends extraction provenance', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'review-ctx-budget-'));
  fs.mkdirSync(path.join(tmp, '.context/stages/03_data/output'), { recursive: true });
  fs.writeFileSync(path.join(tmp, '.context/stages/03_data/output/schema.md'), 'X'.repeat(500));
  const stageIndex = [
    { stage: '03_data', files: [{ rel: 'output/schema.md' }], extraction: { 'schema.md': 'static-regex-scan' } },
  ];
  const out = g.collectReviewContext(tmp, '.context', stageIndex, 100);
  assert.ok(!out.includes('X'.repeat(500)), 'stage content must be truncated, not included in full, when it exceeds the budget');
  assert.match(out, /Extraction provenance/);
  assert.match(out, /schema\.md` \| static-regex-scan/);
});

test('collectReviewContext skips stages not present in stageIndex without throwing', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'review-ctx-empty-'));
  assert.strictEqual(g.collectReviewContext(tmp, '.context', [], 1000), '');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/unit.test.js`
Expected: FAIL with `g.collectReviewContext is not a function`.

- [ ] **Step 3: Implement `collectReviewContext`**

Add this function to `generate_project_context.js` immediately before `function collectAiContextFiles(ctx) {` (currently line 862):

```js
// Priority order for the knowledge-gaps review input: domain/interface
// stages first (schema, entities, routes, services — the densest source of
// real business-logic gaps), then the rest, filling whatever budget remains.
const REVIEW_STAGE_PRIORITY = ['03_data', '04_interfaces', '01_overview', '02_architecture', '05_documentation', '06_synthesis'];

function collectReviewContext(root, contextDir, stageIndex, budget = 12000) {
  const byStage = new Map(stageIndex.map((s) => [s.stage, s]));
  let out = '';
  for (const stageName of REVIEW_STAGE_PRIORITY) {
    const entry = byStage.get(stageName);
    if (!entry) continue;
    for (const f of entry.files || []) {
      if (out.length >= budget) break;
      const abs = path.join(root, contextDir, 'stages', stageName, f.rel);
      const content = readText(abs);
      if (!content) continue;
      const remaining = budget - out.length;
      out += `### ${stageName}/${f.rel}\n${content.slice(0, remaining)}\n\n`;
    }
  }
  const extractionRows = buildExtractionRows(stageIndex);
  if (extractionRows.length) {
    out += `### Extraction provenance\n\n| Output | Method |\n|---|---|\n${extractionRows.join('\n')}\n`;
  }
  return out;
}
```

Add `collectReviewContext` to module.exports, in the same line as `collectAiContextFiles`:
```js
  checkAiAvailable, callAi, stripModelPreamble, collectAiContextFiles, collectReviewContext, makeAiSummarizer,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/unit.test.js`
Expected: PASS — all three new tests green, no regressions.

- [ ] **Step 5: Commit**

```bash
git add generate_project_context.js test/unit.test.js
git commit -m "Add collectReviewContext: budgeted, priority-ordered .context input for the knowledge-gaps review"
```

---

### Task 3: Wire the review call into `main()`

**Files:**
- Modify: `generate_project_context.js:1467-1469` (between the 06_synthesis `stageIndex.push` and the existing `writeRouter` call)

**Interfaces:**
- Consumes: `collectReviewContext(root, contextDir, stageIndex, budget?)` (Task 2), `callAi(aiCli, prompt)` (existing, `generate_project_context.js:846`), `writeRouter(root, contextDir, { repoName, label, stageIndex, hasKnowledgeGaps })` (Task 1).
- Produces: `.context/KNOWLEDGE_GAPS.md` on disk when AI is available and returns non-empty content; `hasKnowledgeGaps` boolean passed into `writeRouter`.

- [ ] **Step 1: Write the failing integration test**

Add to `test/generator.test.js` (after the "router and manifest stamp generator commit..." test):

```js
test('knowledge-gap review writes KNOWLEDGE_GAPS.md and a router pointer when AI is available', () => {
  const root = copyFixture('symfony-app');
  const fakeAi = path.join(__dirname, 'fixtures/bin/fake-ai.js');
  const r = runGenerator(root, ['--ai', fakeAi]);
  assert.strictEqual(r.status, 0, r.stderr);

  const gapsPath = path.join(root, '.context/KNOWLEDGE_GAPS.md');
  assert.ok(fs.existsSync(gapsPath));
  const gaps = fs.readFileSync(gapsPath, 'utf8');
  assert.match(gaps, /^# Knowledge Gaps/);
  assert.match(gaps, /## hallOfFamePoints refund handling/);
  assert.match(gaps, /\*\*Question:\*\*/);
  assert.match(gaps, /\*\*Why it matters:\*\*/);
  assert.ok(!/no skill applies/i.test(gaps), 'leaked preamble must be stripped from KNOWLEDGE_GAPS.md too');

  const router = fs.readFileSync(path.join(root, '.context/CONTEXT.md'), 'utf8');
  assert.match(router, /Unresolved: see `KNOWLEDGE_GAPS\.md`/);
});

test('knowledge-gap review is skipped entirely under --no-ai: no file, no router pointer', () => {
  const root = copyFixture('symfony-app');
  const r = runGenerator(root, ['--no-ai']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(!fs.existsSync(path.join(root, '.context/KNOWLEDGE_GAPS.md')));
  const router = fs.readFileSync(path.join(root, '.context/CONTEXT.md'), 'utf8');
  assert.ok(!router.includes('KNOWLEDGE_GAPS.md'));
});
```

Note: the first test references a `## hallOfFamePoints refund handling` heading and a specific fake-ai.js behavior that doesn't exist yet — that's added in Task 4. Write this test now (per TDD it should fail for the right reason), then implement Task 3's `main()` wiring, confirm the *second* test already passes (no fake-ai changes needed for `--no-ai`), and come back to confirm the first test once Task 4 lands.

- [ ] **Step 2: Run the new tests to verify they fail for the right reason**

Run: `node --test test/generator.test.js`
Expected: the AI-available test (`'knowledge-gap review writes KNOWLEDGE_GAPS.md...'`) FAILS with `ENOENT`/`assert.ok(fs.existsSync(...))` false, since nothing writes `KNOWLEDGE_GAPS.md` yet. The `--no-ai` test (`'knowledge-gap review is skipped entirely under --no-ai...'`) is expected to PASS already at this point — no code path writes the file today, so its assertions are trivially true. That's fine: it becomes a standing regression guard once Task 3's wiring lands, since it will keep passing precisely because the `--no-ai` branch never calls `callAi()` for this feature.

- [ ] **Step 3: Wire the review call into `main()`**

Replace `generate_project_context.js:1467-1469`:

```js
  stageIndex.push({ stage: '06_synthesis', purpose: 'AI overview, architecture notes, focus', files: written06.map((f) => ({ rel: `output/${f}`, bytes: fs.statSync(path.join(root, args.contextDir, 'stages/06_synthesis/output', f)).size })) });
  writeRouter(root, args.contextDir, { repoName, label: stackLabel(detection, versions, devEnv, dbHints), stageIndex });
  log.success(`${args.contextDir}/ generated`);
```

with:

```js
  stageIndex.push({ stage: '06_synthesis', purpose: 'AI overview, architecture notes, focus', files: written06.map((f) => ({ rel: `output/${f}`, bytes: fs.statSync(path.join(root, args.contextDir, 'stages/06_synthesis/output', f)).size })) });

  log.info('Reviewing .context for knowledge gaps...');
  let hasKnowledgeGaps = false;
  if (ai.useAi) {
    const reviewContext = collectReviewContext(root, args.contextDir, stageIndex);
    const gaps = callAi(args.aiCli, `You are reviewing a generated project-context folder for a ${detection.primaryFramework} (${detection.primaryLang}) codebase to find open questions a human should resolve — not to describe what's already documented.

Generated context (schema, entities, routes, services, docs, synthesis — truncated, most relevant stages first):
${reviewContext}

Identify up to 8 knowledge gaps: business rules, edge cases, or intent that isn't derivable from the content above, or sections whose extraction method is a static fallback or unavailable (see the provenance table) and so unverified. Every gap must cite a specific file, class, or section from the content above. Do not invent generic gaps that could apply to any ${detection.primaryFramework} project. Return fewer than 8 if fewer are genuinely evidenced — do not pad.

Format each gap exactly as:

## <short topic>
**Question:** <specific open question a human/agent needs to answer>
**Why it matters:** <concrete consequence, tied to the cited file/class>

Output only the gaps in that format — no preamble, no trailing commentary.`);
    if (gaps) {
      fs.writeFileSync(path.join(root, args.contextDir, 'KNOWLEDGE_GAPS.md'), `# Knowledge Gaps\n\n${gaps.trimEnd()}\n`);
      hasKnowledgeGaps = true;
    }
  }

  writeRouter(root, args.contextDir, { repoName, label: stackLabel(detection, versions, devEnv, dbHints), stageIndex, hasKnowledgeGaps });
  log.success(`${args.contextDir}/ generated`);
```

- [ ] **Step 4: Run tests to verify the `--no-ai` case passes**

Run: `node --test test/generator.test.js`
Expected: "knowledge-gap review is skipped entirely under --no-ai" PASSES. "knowledge-gap review writes KNOWLEDGE_GAPS.md..." still FAILS (fake-ai.js doesn't yet return a gaps-shaped response) — expected at this point, resolved in Task 4.

- [ ] **Step 5: Commit**

```bash
git add generate_project_context.js test/generator.test.js
git commit -m "Wire knowledge-gaps AI review call into main(), gated on AI availability"
```

---

### Task 4: Extend the fake-AI test fixture and confirm the full integration test passes

**Files:**
- Modify: `test/fixtures/bin/fake-ai.js`
- Test: `test/generator.test.js` (already written in Task 3, Step 1 — no new test code needed here)

**Interfaces:**
- Consumes: nothing new — reads `process.argv[3]` (the prompt string `callAi()` passes as the CLI's second argument, per `spawnSync(aiCli, ['-p', prompt], ...)` at `generate_project_context.js:864` — see existing `callAi` definition).
- Produces: two distinct canned responses from the same fake CLI, selected by whether the prompt contains "knowledge gap" (case-insensitive) — lets one fixture serve both the existing 06_synthesis test and the new knowledge-gaps test without cross-contamination.

- [ ] **Step 1: Confirm current fake-ai.js content and the test it must keep passing**

Read `test/fixtures/bin/fake-ai.js` — it currently always writes the same contaminated-preamble + synthesis-shaped response, used by the existing test `'06_synthesis strips leaked model self-talk/routing preamble before writing output files'` in `test/generator.test.js`. That test must keep passing after this change (its response should still be returned whenever the prompt is NOT a knowledge-gaps prompt).

- [ ] **Step 2: Update the fixture to branch on prompt content**

Replace the full contents of `test/fixtures/bin/fake-ai.js`:

```js
#!/usr/bin/env node
// Minimal stand-in for an AI CLI (`claude -p <prompt>`) used only in tests.
// Branches on the prompt text so different callAi() call sites (06_synthesis
// vs. the knowledge-gaps review) can be tested against distinct canned
// responses. Every response is deliberately contaminated with leaked
// routing/self-talk preamble so tests can assert the generator strips it
// before persisting either kind of output.
const prompt = process.argv[3] || '';
const PREAMBLE = "This is a plain content-generation task (writing a doc summary), not creative feature work or a coding task — no skill applies here.\n\n";

if (/knowledge gap/i.test(prompt)) {
  process.stdout.write(PREAMBLE +
    "## hallOfFamePoints refund handling\n" +
    "**Question:** What happens to Foo's hallOfFamePoints if a refund is issued after points were already awarded?\n" +
    "**Why it matters:** FooController::create persists new Foo records but no code here shows points being reversed.\n"
  );
} else {
  process.stdout.write(PREAMBLE +
    "The FooController handles inbound foo requests. Foo tracks a hall-of-fame point total.\n"
  );
}
```

- [ ] **Step 3: Run the full test suite**

Run: `node --test test/*.test.js`
Expected: PASS for both knowledge-gaps tests from Task 3 Step 1, PASS for the pre-existing `'06_synthesis strips leaked model self-talk/routing preamble...'` test (still gets the non-gaps branch), and no other regressions. The one pre-existing unrelated failure (`'default flags without AI CLI on PATH: second run still skips via ledger'`) is expected to remain — it predates this feature (confirmed via `git stash` in the prior round).

- [ ] **Step 4: Commit**

```bash
git add test/fixtures/bin/fake-ai.js
git commit -m "Extend fake-ai test fixture to return a distinct canned response for knowledge-gaps prompts"
```

---

### Task 5: README documentation

**Files:**
- Modify: `README.md`

**Interfaces:** None (documentation only).

- [ ] **Step 1: Update the output-structure diagram**

In `README.md`, the "## Output structure" code block currently ends with:

```
    06_synthesis/    CONTEXT.md + output/   # AI overview, architecture notes, dev focus (skipped without AI)
```

Add a new line immediately after the closing of that code block's `stages/` section, i.e. change the block (`README.md:67-80`) from:

```
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
```

to:

```
```
.context/
  CONTEXT.md                     # router — stage index, links into each stage
  KNOWLEDGE_GAPS.md               # AI review of the whole folder — open questions for a human (only when AI is available)
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
```

- [ ] **Step 2: Add a new "Knowledge-gap review" section**

In `README.md`, immediately after the "## The ledger (incremental re-runs)" section and before "## Ignore rules" (i.e. after the line `stage pointing at outputs that don't exist.` and before the `## Ignore rules` heading), insert:

```markdown
## Knowledge-gap review

After all six stages are written, if an AI CLI is available, one more AI
call reviews the whole `.context/` folder — prioritizing `03_data` and
`04_interfaces`, plus the extraction-provenance table — and writes
`.context/KNOWLEDGE_GAPS.md`: a list of open questions the generator
couldn't answer from the code or docs alone. Each entry has a short topic,
the specific open question, and why it matters, e.g. a business rule that
isn't written down anywhere, or a section that only came from a
static-scan fallback and was never verified live.

This file is meant to be **triaged by a human**, not auto-resolved by the
tool — answer the questions yourself (e.g. by adding them to
CLAUDE.md/AGENTS.md, which the generator already merges into
`entities.md`/`services.md` on the next run) or file them as tickets.

Under `--no-ai` (or with no AI CLI on PATH), this step is skipped entirely:
`KNOWLEDGE_GAPS.md` is not created, and the router has no pointer to it.
```

- [ ] **Step 3: Add one sentence to "## For agents"**

Change `README.md`'s "## For agents" section from:

```markdown
## For agents

Read `.context/CONTEXT.md` first; it's the router into the stage index. Load
only the stage `output/` files you actually need for the task at hand instead
of pulling the whole tree into context.
```

to:

```markdown
## For agents

Read `.context/CONTEXT.md` first; it's the router into the stage index. Load
only the stage `output/` files you actually need for the task at hand instead
of pulling the whole tree into context. If the router links to
`KNOWLEDGE_GAPS.md`, that file lists open questions the generation run
flagged — read it as a caveat list, not as extracted fact.
```

- [ ] **Step 4: Proofread**

Read the full updated `README.md` top to bottom; confirm no broken markdown (matching code fences, no dangling headings) and that the new section reads consistently with the existing ones (same heading level, same tone).

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "Document the knowledge-gap review in README"
```

---

## Final verification (after all tasks)

- [ ] Run the full suite once more: `node --test test/*.test.js` — expect the same pass count as Task 4's run, no new failures.
- [ ] Manually generate against the `symfony-app` fixture with the fake AI CLI and eyeball the output:

```bash
tmp=$(mktemp -d)
cp -r test/fixtures/symfony-app/. "$tmp"/
node generate_project_context.js --ai "$PWD/test/fixtures/bin/fake-ai.js" --dir "$tmp"
cat "$tmp/.context/KNOWLEDGE_GAPS.md"
cat "$tmp/.context/CONTEXT.md" | grep -A1 Unresolved
rm -rf "$tmp"
```

Expected: `KNOWLEDGE_GAPS.md` contains the `## hallOfFamePoints refund handling` entry with no leaked preamble; the router contains the `Unresolved:` line.
