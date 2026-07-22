# AI-Driven Extraction for 03_data/04_interfaces Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the per-framework regex extractors for `schema.md`/`entities.md`/`state.md`/`routes.md`/`controllers.md`/`services.md` with a stack-agnostic, two-pass AI discovery+generation pipeline, and make an AI CLI mandatory (removing `--no-ai`).

**Architecture:** Pass 1 (`discoverCodeShape`) asks the AI to classify repo paths into data-model/routes/business-logic/state categories from the directory tree + manifest alone. Pass 2 (`runGenerationCall`, called once per output file) feeds each category's discovered file content — plus the existing output file if present, for review-and-amend rather than blind overwrite — to the AI and asks for that file's markdown in the existing heading+codefence template. Generation is cached per file in the manifest ledger (source hash + last-reviewed timestamp, 30-day staleness window).

**Tech Stack:** Node.js (no dependencies), `node:test`, the existing `callAi()`/`fake-ai.js` test-double pattern.

## Global Constraints

- Node stays deterministic for: directory tree, git log/activity, file counts, stack/dev-env/DB detection, `.env` listing, ignore engine, all file/stage writing. Only `schema.md`, `entities.md`, `state.md`, `routes.md`, `controllers.md`, `services.md` move to AI (spec: "Scope split").
- `--no-ai` is removed entirely. No AI CLI on PATH → exit 1 before any writes (spec: "AI becomes mandatory").
- Discovery = 1 AI call per run. Generation = up to 6 AI calls, one per output file, each independently cacheable/skippable (spec: "Two-pass extraction").
- Generation prompts MUST specify the `#### \`Name\`` heading + fenced-codeblock template verbatim, since `extractDomainNotes`/`annotateWithDomainNotes`/`dedupeGotchaHits`/`extractDeclaredFieldNames` parse that exact structure post-hoc (spec: "Output-shape contract").
- Generation input budget: 12,000 chars of source content per category (same default as `collectReviewContext`), plus the existing output file's full content unbudgeted when present (spec: "Pass 2 — generation").
- Cache skip requires BOTH: source hash unchanged AND last review under 30 days ago (spec: "Caching").
- Extraction provenance labels: `ai-generated`, `ai-cached (last reviewed YYYY-MM-DD)`, `ai-no-relevant-files-found`, `ai-call-failed (existing content retained)` / `ai-call-failed (no content produced)` (spec: "Extraction provenance").
- Discovery paths are validated against the real filesystem (`walkFiles()`) before use — a hallucinated path is silently dropped (spec: "Pass 1 — discovery").

---

### Task 1: Pass-2 core helpers — content budgeting, hashing, staleness

**Files:**
- Modify: `generate_project_context.js` — add new functions near `collectReviewContext` (currently around line 920)
- Modify: `generate_project_context.js` module.exports (currently line ~1690)
- Test: `test/unit.test.js`

**Interfaces:**
- Consumes: `readText(p)` (existing, line 46), `sha256(str)` (existing, line 48).
- Produces: `collectCategoryContent(root, paths, budget = 12000) -> string`, `computeCategoryHash(root, paths) -> string` (sha256 hex), `isCacheFresh(cacheEntry, currentHash, now = new Date()) -> boolean`, `AI_REVIEW_STALENESS_DAYS` (constant, value `30`). Task 2 consumes all four.

- [ ] **Step 1: Write the failing tests**

Add to `test/unit.test.js` (after the last existing test):

```js
test('collectCategoryContent concatenates file contents with path headers, budgeted', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cat-content-'));
  fs.writeFileSync(path.join(tmp, 'a.php'), 'class A {}');
  fs.writeFileSync(path.join(tmp, 'b.php'), 'class B {}');
  const out = g.collectCategoryContent(tmp, ['a.php', 'b.php'], 12000);
  assert.match(out, /### a\.php\n```\nclass A \{\}\n```/);
  assert.match(out, /### b\.php\n```\nclass B \{\}\n```/);
});

test('collectCategoryContent truncates once the budget is exhausted, skipping later files', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cat-content-budget-'));
  fs.writeFileSync(path.join(tmp, 'big.php'), 'X'.repeat(200));
  fs.writeFileSync(path.join(tmp, 'never-reached.php'), 'class Never {}');
  const out = g.collectCategoryContent(tmp, ['big.php', 'never-reached.php'], 50);
  assert.ok(!out.includes('X'.repeat(200)), 'big.php content must be truncated, not included in full');
  assert.ok(!out.includes('Never'), 'never-reached.php must not be included once the budget is exhausted');
});

test('computeCategoryHash is stable for the same content regardless of path order', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cat-hash-'));
  fs.writeFileSync(path.join(tmp, 'a.php'), 'class A {}');
  fs.writeFileSync(path.join(tmp, 'b.php'), 'class B {}');
  const h1 = g.computeCategoryHash(tmp, ['a.php', 'b.php']);
  const h2 = g.computeCategoryHash(tmp, ['b.php', 'a.php']);
  assert.strictEqual(h1, h2, 'hash must not depend on path array order');

  fs.writeFileSync(path.join(tmp, 'a.php'), 'class A { public $changed; }');
  const h3 = g.computeCategoryHash(tmp, ['a.php', 'b.php']);
  assert.notStrictEqual(h1, h3, 'hash must change when file content changes');
});

test('isCacheFresh requires both matching hash and last review within 30 days', () => {
  const now = new Date('2026-07-22T00:00:00Z');
  const fresh = { source_hash: 'abc', last_reviewed_at: '2026-07-01T00:00:00Z' };
  assert.strictEqual(g.isCacheFresh(fresh, 'abc', now), true, 'matching hash, 21 days old — still fresh');

  const stale = { source_hash: 'abc', last_reviewed_at: '2026-06-01T00:00:00Z' };
  assert.strictEqual(g.isCacheFresh(stale, 'abc', now), false, 'matching hash but 51 days old — stale, must re-review');

  const changed = { source_hash: 'abc', last_reviewed_at: '2026-07-21T00:00:00Z' };
  assert.strictEqual(g.isCacheFresh(changed, 'xyz', now), false, 'hash mismatch — never fresh regardless of age');

  assert.strictEqual(g.isCacheFresh(null, 'abc', now), false, 'no prior cache entry — never fresh');
  assert.strictEqual(g.isCacheFresh(undefined, 'abc', now), false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/unit.test.js`
Expected: FAIL — `g.collectCategoryContent is not a function` (and similarly for the other three; none exist yet).

- [ ] **Step 3: Implement the four functions**

In `generate_project_context.js`, immediately before `function collectAiContextFiles(ctx) {` (currently line 920, right after `collectReviewContext`), add:

```js
// ── AI-driven extraction: pass-2 shared building blocks ──────────────────────
// See docs/superpowers/specs/2026-07-22-ai-driven-extraction-design.md.
function collectCategoryContent(root, paths, budget = 12000) {
  let out = '';
  for (const p of paths) {
    if (out.length >= budget) break;
    const content = readText(path.join(root, p));
    if (!content) continue;
    const remaining = budget - out.length;
    out += `### ${p}\n\`\`\`\n${content.slice(0, remaining)}\n\`\`\`\n\n`;
  }
  return out;
}

function computeCategoryHash(root, paths) {
  const sorted = [...paths].sort();
  const combined = sorted.map((p) => `${p}:${readText(path.join(root, p)) || ''}`).join('\n---\n');
  return sha256(combined);
}

const AI_REVIEW_STALENESS_DAYS = 30;
function isCacheFresh(cacheEntry, currentHash, now = new Date()) {
  if (!cacheEntry || cacheEntry.source_hash !== currentHash) return false;
  const ageMs = now.getTime() - new Date(cacheEntry.last_reviewed_at).getTime();
  return ageMs < AI_REVIEW_STALENESS_DAYS * 24 * 60 * 60 * 1000;
}
```

In `generate_project_context.js` module.exports (currently line ~1690), find the line:

```js
  writeStage, seedIgnoreFile, stackLabel, devSetupBlock, buildStages01to04, writeRouter, buildExtractionRows,
```

and add the four new names to the `collectReviewContext` export line (currently `checkAiAvailable, callAi, stripModelPreamble, collectAiContextFiles, collectReviewContext, makeAiSummarizer,`) — change it to:

```js
  checkAiAvailable, callAi, stripModelPreamble, collectAiContextFiles, collectReviewContext, makeAiSummarizer,
  collectCategoryContent, computeCategoryHash, isCacheFresh, AI_REVIEW_STALENESS_DAYS,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/unit.test.js`
Expected: PASS — all four new tests green, no regressions in the rest of the file.

- [ ] **Step 5: Commit**

```bash
git add generate_project_context.js test/unit.test.js
git commit -m "Add pass-2 core helpers: collectCategoryContent, computeCategoryHash, isCacheFresh"
```

---

### Task 2: `runGenerationCall` — the shared per-file generation runner

**Files:**
- Modify: `generate_project_context.js` — add immediately after Task 1's new functions
- Modify: module.exports
- Test: `test/unit.test.js`

**Interfaces:**
- Consumes: `collectCategoryContent`, `computeCategoryHash`, `isCacheFresh` (Task 1), `callAi(aiCli, prompt)` (existing, line 900).
- Produces: `runGenerationCall(ctx, { paths, promptInstructions, existingContent, oldCacheEntry }) -> { content: string, method: string, cacheEntry: {source_hash, last_reviewed_at} | null }`. `ctx` must have `.root` and `.aiCli`. Tasks 4/5 call this once per output file.

- [ ] **Step 1: Write the failing tests**

These tests need a real (fake) AI CLI on PATH. Add to `test/unit.test.js`, using the same "write a tiny throwaway fake CLI script inline" pattern already used in `test/generator.test.js`'s `'fake AI CLI: stage 06...'` test:

```js
function makeFakeAiScript(tmp, responseFn) {
  const fs = require('node:fs');
  const path = require('node:path');
  const scriptPath = path.join(tmp, 'fake-ai-runner.js');
  fs.writeFileSync(scriptPath, `#!/usr/bin/env node\nconst prompt = process.argv[3] || '';\n${responseFn}\n`);
  fs.chmodSync(scriptPath, 0o755);
  return scriptPath;
}

test('runGenerationCall skips the AI call and returns "ai-no-relevant-files-found" when paths is empty', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-call-empty-'));
  const ctx = { root: tmp, aiCli: 'this-should-never-be-invoked' };
  const result = g.runGenerationCall(ctx, { paths: [], promptInstructions: 'irrelevant', existingContent: null, oldCacheEntry: null });
  assert.deepStrictEqual(result, { content: '', method: 'ai-no-relevant-files-found', cacheEntry: null });
});

test('runGenerationCall calls the AI and returns ai-generated with a fresh cache entry on a cache miss', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-call-miss-'));
  fs.writeFileSync(path.join(tmp, 'Foo.php'), 'class Foo { private $id; }');
  const fakeAi = makeFakeAiScript(tmp, `process.stdout.write('#### \`Foo\`\\n\`\`\`php\\nprivate $id;\\n\`\`\`\\n');`);
  const ctx = { root: tmp, aiCli: fakeAi };
  const result = g.runGenerationCall(ctx, { paths: ['Foo.php'], promptInstructions: 'Describe entities.', existingContent: null, oldCacheEntry: null });
  assert.strictEqual(result.method, 'ai-generated');
  assert.match(result.content, /#### `Foo`/);
  assert.ok(result.cacheEntry.source_hash);
  assert.ok(result.cacheEntry.last_reviewed_at);
});

test('runGenerationCall skips the AI call when the cache is fresh, reusing existing content', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-call-fresh-'));
  fs.writeFileSync(path.join(tmp, 'Foo.php'), 'class Foo { private $id; }');
  const ctx = { root: tmp, aiCli: 'this-should-never-be-invoked' };
  const sourceHash = g.computeCategoryHash(tmp, ['Foo.php']);
  const oldCacheEntry = { source_hash: sourceHash, last_reviewed_at: new Date().toISOString() };
  const result = g.runGenerationCall(ctx, { paths: ['Foo.php'], promptInstructions: 'Describe entities.', existingContent: '#### `Foo` (existing)', oldCacheEntry });
  assert.strictEqual(result.method, `ai-cached (last reviewed ${oldCacheEntry.last_reviewed_at.slice(0, 10)})`);
  assert.strictEqual(result.content, '#### `Foo` (existing)');
  assert.strictEqual(result.cacheEntry, oldCacheEntry);
});

test('runGenerationCall re-runs when the hash matches but the cache is stale (>30 days)', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-call-stale-'));
  fs.writeFileSync(path.join(tmp, 'Foo.php'), 'class Foo { private $id; }');
  const fakeAi = makeFakeAiScript(tmp, `process.stdout.write('#### \`Foo\`\\n\`\`\`php\\nprivate $id; // refreshed\\n\`\`\`\\n');`);
  const ctx = { root: tmp, aiCli: fakeAi };
  const sourceHash = g.computeCategoryHash(tmp, ['Foo.php']);
  const staleDate = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
  const result = g.runGenerationCall(ctx, { paths: ['Foo.php'], promptInstructions: 'Describe entities.', existingContent: '#### `Foo` (old)', oldCacheEntry: { source_hash: sourceHash, last_reviewed_at: staleDate } });
  assert.strictEqual(result.method, 'ai-generated');
  assert.match(result.content, /refreshed/);
});

test('runGenerationCall falls back to existing content and reports ai-call-failed when the AI returns nothing', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-call-fail-'));
  fs.writeFileSync(path.join(tmp, 'Foo.php'), 'class Foo { private $id; }');
  const fakeAi = makeFakeAiScript(tmp, `process.stdout.write('');`);
  const ctx = { root: tmp, aiCli: fakeAi };
  const result = g.runGenerationCall(ctx, { paths: ['Foo.php'], promptInstructions: 'Describe entities.', existingContent: '#### `Foo` (kept)', oldCacheEntry: null });
  assert.strictEqual(result.method, 'ai-call-failed (existing content retained)');
  assert.strictEqual(result.content, '#### `Foo` (kept)');
});

test('runGenerationCall\\'s prompt tells the AI to revise, not rewrite, when existing content is present', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-call-revise-'));
  fs.writeFileSync(path.join(tmp, 'Foo.php'), 'class Foo { private $id; }');
  // Echo the prompt back so the test can inspect what runGenerationCall sent.
  const fakeAi = makeFakeAiScript(tmp, `process.stdout.write(prompt);`);
  const ctx = { root: tmp, aiCli: fakeAi };
  const result = g.runGenerationCall(ctx, { paths: ['Foo.php'], promptInstructions: 'Describe entities.', existingContent: '#### `Foo` (existing)', oldCacheEntry: null });
  assert.match(result.content, /Existing output from a previous run — update it/);
  assert.match(result.content, /#### `Foo` \(existing\)/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/unit.test.js`
Expected: FAIL — `g.runGenerationCall is not a function`.

- [ ] **Step 3: Implement `runGenerationCall`**

Add immediately after `isCacheFresh` in `generate_project_context.js`:

```js
function runGenerationCall(ctx, { paths, promptInstructions, existingContent, oldCacheEntry }) {
  if (!paths.length) {
    return { content: '', method: 'ai-no-relevant-files-found', cacheEntry: null };
  }
  const sourceHash = computeCategoryHash(ctx.root, paths);
  const now = new Date();
  if (isCacheFresh(oldCacheEntry, sourceHash, now)) {
    return { content: existingContent || '', method: `ai-cached (last reviewed ${oldCacheEntry.last_reviewed_at.slice(0, 10)})`, cacheEntry: oldCacheEntry };
  }
  const fileContent = collectCategoryContent(ctx.root, paths);
  const existingBlock = existingContent
    ? `\n\nExisting output from a previous run — update it: keep what's still accurate (including anything a human added by hand), remove what's no longer true, add what's new. Do not rewrite from scratch unless the existing content is clearly stale or wrong.\n\n${existingContent}`
    : '';
  const prompt = `${promptInstructions}\n\nSource files:\n${fileContent}${existingBlock}\n\nOutput only the markdown content described above — no preamble, no trailing commentary.`;
  const result = callAi(ctx.aiCli, prompt);
  if (!result) {
    return {
      content: existingContent || '',
      method: existingContent ? 'ai-call-failed (existing content retained)' : 'ai-call-failed (no content produced)',
      cacheEntry: oldCacheEntry || null,
    };
  }
  return { content: result, method: 'ai-generated', cacheEntry: { source_hash: sourceHash, last_reviewed_at: now.toISOString() } };
}
```

Update the module.exports line from Task 1 to also include `runGenerationCall`:

```js
  collectCategoryContent, computeCategoryHash, isCacheFresh, AI_REVIEW_STALENESS_DAYS, runGenerationCall,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/unit.test.js`
Expected: PASS — all six new tests green.

- [ ] **Step 5: Commit**

```bash
git add generate_project_context.js test/unit.test.js
git commit -m "Add runGenerationCall: cached, review-and-amend AI generation for one output file"
```

---

### Task 3: `discoverCodeShape` — pass-1 discovery

**Files:**
- Modify: `generate_project_context.js` — add immediately after `runGenerationCall`
- Modify: module.exports
- Test: `test/unit.test.js`

**Interfaces:**
- Consumes: `treeBlock(ctx)` (existing, line 749), `readText`, `walkFiles(root, ignoreFn)` (existing, line 131), `callAi(aiCli, prompt)`.
- Produces: `discoverCodeShape(ctx) -> { dataModel: string[], routes: string[], businessLogic: string[], state: string[] }` — all four arrays contain only paths that exist on disk (validated), sorted, deduped. `ctx` must have `.root`, `.appDir`, `.detection.primaryFramework`, `.detection.primaryLang`, `.ignoreFn`, `.aiCli`, `.treeDepth`. Task 6 calls this once per run.

- [ ] **Step 1: Write the failing tests**

Add to `test/unit.test.js`:

```js
test('discoverCodeShape parses DATA_MODEL/ROUTES/BUSINESS_LOGIC/STATE and validates paths against the filesystem', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'discover-'));
  fs.mkdirSync(path.join(tmp, 'src/Entity'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'src/Controller'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'src/Entity/Foo.php'), '<?php class Foo {}');
  fs.writeFileSync(path.join(tmp, 'src/Controller/FooController.php'), '<?php class FooController {}');
  const fakeAi = path.join(tmp, 'fake-discover.js');
  fs.writeFileSync(fakeAi, [
    '#!/usr/bin/env node',
    'process.stdout.write(',
    "  'DATA_MODEL: src/Entity/Foo.php, src/NoSuchFile.php\\n' +",
    "  'ROUTES: src/Controller/FooController.php\\n' +",
    "  'BUSINESS_LOGIC: \\n' +",
    "  'STATE: \\n'",
    ');',
  ].join('\n'));
  fs.chmodSync(fakeAi, 0o755);
  const ctx = {
    root: tmp, appDir: '.', aiCli: fakeAi, treeDepth: 3,
    detection: { primaryFramework: 'symfony', primaryLang: 'php' },
    ignoreFn: g.createIgnoreMatcher({ root: tmp, contextDir: '.context' }),
  };
  const shape = g.discoverCodeShape(ctx);
  assert.deepStrictEqual(shape.dataModel, ['src/Entity/Foo.php'], 'a hallucinated path (NoSuchFile.php) must be silently dropped');
  assert.deepStrictEqual(shape.routes, ['src/Controller/FooController.php']);
  assert.deepStrictEqual(shape.businessLogic, []);
  assert.deepStrictEqual(shape.state, []);
});

test('discoverCodeShape returns all-empty categories when the AI call fails', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'discover-fail-'));
  const ctx = {
    root: tmp, appDir: '.', aiCli: 'this-cli-does-not-exist-anywhere', treeDepth: 3,
    detection: { primaryFramework: 'node', primaryLang: 'node' },
    ignoreFn: g.createIgnoreMatcher({ root: tmp, contextDir: '.context' }),
  };
  const shape = g.discoverCodeShape(ctx);
  assert.deepStrictEqual(shape, { dataModel: [], routes: [], businessLogic: [], state: [] });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/unit.test.js`
Expected: FAIL — `g.discoverCodeShape is not a function`.

- [ ] **Step 3: Implement `discoverCodeShape`**

Add immediately after `runGenerationCall`:

```js
// Pass 1: classify which paths define the data model, routes, business
// logic, and client-side state — stack-agnostic by construction, since it
// reasons from the directory tree and manifest rather than a fixed enum of
// framework conventions. Replaces the old modelsDir/controllersDir/
// servicesDir-based routing entirely.
function discoverCodeShape(ctx) {
  const empty = { dataModel: [], routes: [], businessLogic: [], state: [] };
  const tree = treeBlock(ctx);
  const manifestFiles = ['composer.json', 'package.json', 'go.mod', 'Cargo.toml', 'Gemfile', 'requirements.txt', 'pyproject.toml'];
  let manifestBlock = '(no manifest file found)';
  for (const f of manifestFiles) {
    const content = readText(path.join(ctx.root, ctx.appDir, f));
    if (content) { manifestBlock = `### ${f}\n\`\`\`\n${content.slice(0, 2000)}\n\`\`\`\n`; break; }
  }
  const prompt = `You are analysing a ${ctx.detection.primaryFramework} (${ctx.detection.primaryLang}) codebase to find which files define its data model, routes, business logic, and client-side state.

Directory tree:
${tree}

${manifestBlock}

Classify relevant paths (files or directories) into these categories. A path may belong to multiple categories. If a category has no relevant paths, leave its line empty after the colon. Use paths exactly as they appear in the tree above (relative, no leading ./).

Respond in exactly this format — no other text:
DATA_MODEL: <comma-separated paths, or empty>
ROUTES: <comma-separated paths, or empty>
BUSINESS_LOGIC: <comma-separated paths, or empty>
STATE: <comma-separated paths, or empty>`;

  const result = callAi(ctx.aiCli, prompt);
  if (!result) return empty;

  const parseLine = (label) => {
    const m = result.match(new RegExp(`^${label}:\\s*(.*)$`, 'm'));
    if (!m || !m[1].trim()) return [];
    return m[1].split(',').map((p) => p.trim()).filter(Boolean);
  };
  const allFiles = walkFiles(ctx.root, ctx.ignoreFn);
  const validate = (rawPaths) => {
    const valid = new Set();
    for (const raw of rawPaths) {
      const norm = raw.replace(/^\.\//, '').replace(/\/$/, '');
      for (const f of allFiles) {
        if (f === norm || f.startsWith(norm + '/')) valid.add(f);
      }
    }
    return [...valid].sort();
  };
  return {
    dataModel: validate(parseLine('DATA_MODEL')),
    routes: validate(parseLine('ROUTES')),
    businessLogic: validate(parseLine('BUSINESS_LOGIC')),
    state: validate(parseLine('STATE')),
  };
}
```

Update the module.exports line from Task 2 to also include `discoverCodeShape`:

```js
  collectCategoryContent, computeCategoryHash, isCacheFresh, AI_REVIEW_STALENESS_DAYS, runGenerationCall, discoverCodeShape,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/unit.test.js`
Expected: PASS — both new tests green.

- [ ] **Step 5: Commit**

```bash
git add generate_project_context.js test/unit.test.js
git commit -m "Add discoverCodeShape: stack-agnostic pass-1 discovery of data-model/routes/business-logic/state paths"
```

---

### Task 4: Wire 03_data (schema/entities/state) to the new pipeline; remove old extractors

**Files:**
- Modify: `generate_project_context.js` — `buildStages01to04` (03_data block, currently lines 1394–1413), delete `_schemaSqlite`/`_schemaDoctrine`/`_schemaLaravel`/`_schemaDjango`/`_schemaRails`/`_schemaGo`/`schemaBlock` (lines 416–534 approx.), `_entitiesTypescript`/`_entitiesDoctrine`/`_entitiesEloquent`/`_entitiesDjango`/`_entitiesRails`/`entitiesBlock` (lines 536–572 approx.), `stateBlock` (line 574), `extractSqlStatements` (line 433), `extractBlocks` (line 62, now fully unused once these callers are gone), `sectionLabels` simplification (line 1224)
- Modify: module.exports (remove `schemaBlock, entitiesBlock, stateBlock, extractBlocks, extractSqlStatements`)
- Modify: `test/unit.test.js` (remove tests for `extractBlocks`/`extractSqlStatements`)
- Modify: `test/detection.test.js` (remove `'expo extractors: sqlite schema, ts entities, zustand state'` and the schema/entities assertions inside `'laravel extractors: migrations and eloquent models'`)
- Test: `test/unit.test.js` (new)

**Interfaces:**
- Consumes: `runGenerationCall` (Task 2), `ctx.codeShape` (produced by Task 6 — for THIS task, assume `ctx.codeShape` already exists on `ctx` with shape `{ dataModel, routes, businessLogic, state }`; Task 6 is what actually populates it in `main()`, but `buildStages01to04` just reads it).
- Produces: `sectionLabels(detection, dbHints) -> { schema, entities, state }` (simplified, no per-framework branches). `03_data`'s `extraction` map now uses the new provenance labels from `runGenerationCall`'s `method` field directly.

- [ ] **Step 1: Confirm current 03_data block and dependents**

Read `generate_project_context.js` lines 1371–1436 (`buildStages01to04`) and 1224–1233 (`sectionLabels`) to confirm they still match what's described below — this codebase has had several rounds of changes, so re-verify line numbers before editing rather than trusting them blindly.

- [ ] **Step 2: Write the failing integration test for the new 03_data behavior**

Add to `test/generator.test.js` (after the last existing test):

```js
test('03_data (schema/entities/state) is generated via AI discovery, not per-framework regex', () => {
  const root = copyFixture('symfony-app');
  const fakeAi = path.join(__dirname, 'fixtures/bin/fake-ai.js');
  const r = runGenerator(root, ['--ai', fakeAi]);
  assert.strictEqual(r.status, 0, r.stderr);
  const schema = fs.readFileSync(path.join(root, '.context/stages/03_data/output/schema.md'), 'utf8');
  assert.match(schema, /#### `Foo`/, 'schema.md content must come from the AI generation call, in the required heading template');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, '.context/_config/manifest.json'), 'utf8'));
  assert.strictEqual(manifest.stages['03_data'].extraction['schema.md'], 'ai-generated');
});
```

(This test intentionally references `fixtures/bin/fake-ai.js` responses and fixture content that don't exist yet — Task 7 extends the fixture and Task 6 wires discovery into `main()`. Confirm it fails for "function/wiring doesn't exist yet," not for an unrelated reason, then move on; you'll return to make it pass once Tasks 5–7 land.)

- [ ] **Step 3: Simplify `sectionLabels`**

Replace (around line 1224):

```js
function sectionLabels(detection, dbHints) {
  const s = detection.stacks; const db = dbHints || 'SQL';
  if (s.symfony) return { schema: `Database Schema (Doctrine / ${db})`, entities: 'Doctrine Entity Definitions', state: '' };
  if (s.laravel) return { schema: `Database Schema (Eloquent / ${db})`, entities: 'Eloquent Model Definitions', state: '' };
  if (s.django) return { schema: `Database Schema (Django ORM / ${db})`, entities: 'Django Model Definitions', state: '' };
  if (s.rails) return { schema: `Database Schema (ActiveRecord / ${db})`, entities: 'ActiveRecord Model Definitions', state: '' };
  if (s.go) return { schema: 'Database Schema (Go structs)', entities: 'Go Type Definitions', state: '' };
  if (s.node) return { schema: `Database Schema (${db || 'SQLite'})`, entities: 'TypeScript Entity Definitions', state: 'Store Shapes (State)' };
  return { schema: 'Database Schema', entities: 'Entity Definitions', state: '' };
}
```

with:

```js
function sectionLabels(detection, dbHints) {
  const db = dbHints || 'SQL';
  return {
    schema: `Database Schema (${detection.primaryFramework} / ${db})`,
    entities: `${detection.primaryFramework} Entity Definitions`,
    state: 'Store Shapes (State)',
  };
}
```

(`state.md` is written only when `runGenerationCall` for the `state` category returns non-empty content — `writeStage` already skips empty outputs — so no per-framework branch is needed to decide whether state applies.)

- [ ] **Step 4: Delete the old schema/entities/state extractors**

Delete these functions entirely from `generate_project_context.js` (verify exact current boundaries with `grep -n "^function " generate_project_context.js` before deleting, since line numbers drift as earlier tasks land):
`extractSqlStatements`, `_schemaSqlite`, `_schemaDoctrine`, `_schemaLaravel`, `_schemaDjango`, `_schemaRails`, `_schemaGo`, `schemaBlock`, `_entitiesTypescript`, `_entitiesDoctrine`, `_entitiesEloquent`, `_entitiesDjango` (the one-liner `function _entitiesDjango(ctx) { return _schemaDjango(ctx); }`), `_entitiesRails`, `entitiesBlock`, `stateBlock`.

Also delete `extractBlocks` (the brace-balanced generic extractor near line 62) — after the above deletions it has no remaining caller anywhere in the file (confirm with `grep -n "extractBlocks(" generate_project_context.js` — it should only show its own definition line after this task).

- [ ] **Step 5: Replace the 03_data stage block**

Replace the 03_data IIFE in `buildStages01to04` (currently):

```js
    (() => {
      const schemaContent = schemaBlock(ctx);
      const entitiesContent = entitiesBlock(ctx);
      const migrationsContent = migrationsBlock(ctx);
      return { name: '03_data',
        contract: { inputs: [`source: ${ctx.detection.modelsDir || 'model files'}`, 'source: migrations / schema files'],
          process: `Extracted the data layer for ${ctx.detection.primaryFramework}: schema, entity definitions${labels.state ? ', store shapes' : ''}, and migrations.`,
          outputs: [{ file: 'schema.md', desc: labels.schema }, { file: 'entities.md', desc: labels.entities }, { file: 'state.md', desc: labels.state || 'store shapes' }, { file: 'migrations.md', desc: 'latest migrations' }] },
        outputs: {
          'schema.md': `# ${labels.schema}\n\n${schemaContent}`,
          'entities.md': `# ${labels.entities}\n\n${annotateWithDomainNotes(entitiesContent, domainNotes.entities, domainNotes.gotchas)}`,
          'state.md': labels.state ? `# ${labels.state}\n\n${stateBlock(ctx)}` : '',
          'migrations.md': `# Migrations\n\n${migrationsContent}`,
        },
        extraction: {
          'schema.md': staticScanMethod(schemaContent),
          'entities.md': staticScanMethod(entitiesContent),
          'migrations.md': staticScanMethod(migrationsContent),
        } };
    })(),
```

with:

```js
    (() => {
      const migrationsContent = migrationsBlock(ctx);
      const cache = (ctx.aiCache && ctx.aiCache['03_data']) || {};
      const existing = (file) => (ctx.existingOutputs && ctx.existingOutputs['03_data'] && ctx.existingOutputs['03_data'][file]) || null;

      const schemaGen = runGenerationCall(ctx, {
        paths: ctx.codeShape.dataModel,
        promptInstructions: `Produce the database/storage schema for this ${ctx.detection.primaryFramework} codebase as markdown: for each table or storage collection found in the source files below, describe its columns/fields, types, and constraints (primary keys, uniqueness, defaults, foreign keys).\n\nFor each table/collection found, use exactly this format (critical — other tooling parses this structure):\n\n#### \`TableName\`\n\`\`\`sql\n<column definitions, one per line>\n\`\`\`\n\nRepeat for every table/collection found. Do not add any other heading levels or wrap tables in additional sections.`,
        existingContent: existing('schema.md'),
        oldCacheEntry: cache['schema.md'],
      });
      const entitiesGen = runGenerationCall(ctx, {
        paths: ctx.codeShape.dataModel,
        promptInstructions: `Produce the code-level entity/model definitions for this ${ctx.detection.primaryFramework} codebase as markdown: for each entity/model class or type found in the source files below, list its declared fields/properties with their types.\n\nFor each entity/model found, use exactly this format (critical — other tooling parses this structure):\n\n#### \`EntityName\`\n\`\`\`${ctx.detection.primaryExt}\n<field/property declarations, one per line>\n\`\`\`\n\nRepeat for every entity/model found. Do not add any other heading levels or wrap entities in additional sections.`,
        existingContent: existing('entities.md'),
        oldCacheEntry: cache['entities.md'],
      });
      const stateGen = runGenerationCall(ctx, {
        paths: ctx.codeShape.state,
        promptInstructions: `Produce the client-side state/store shape for this ${ctx.detection.primaryFramework} codebase as markdown: for each store/state container found in the source files below, list its shape (fields and their types).\n\nFor each store found, use exactly this format (critical — other tooling parses this structure):\n\n#### \`StoreName\`\n\`\`\`${ctx.detection.primaryExt}\n<field declarations, one per line>\n\`\`\`\n\nRepeat for every store found. Do not add any other heading levels or wrap stores in additional sections.`,
        existingContent: existing('state.md'),
        oldCacheEntry: cache['state.md'],
      });

      return { name: '03_data',
        contract: { inputs: ['source: AI-discovered data-model paths (see 04_interfaces\' discovery pass)', 'source: migrations / schema files'],
          process: `Extracted the data layer for ${ctx.detection.primaryFramework} via AI discovery+generation: schema, entity definitions, store shapes, and migrations.`,
          outputs: [{ file: 'schema.md', desc: labels.schema }, { file: 'entities.md', desc: labels.entities }, { file: 'state.md', desc: labels.state }, { file: 'migrations.md', desc: 'latest migrations' }] },
        outputs: {
          'schema.md': schemaGen.content ? `# ${labels.schema}\n\n${schemaGen.content}` : '',
          'entities.md': entitiesGen.content ? `# ${labels.entities}\n\n${annotateWithDomainNotes(entitiesGen.content, domainNotes.entities, domainNotes.gotchas)}` : '',
          'state.md': stateGen.content ? `# ${labels.state}\n\n${stateGen.content}` : '',
          'migrations.md': `# Migrations\n\n${migrationsContent}`,
        },
        extraction: {
          'schema.md': schemaGen.method,
          'entities.md': entitiesGen.method,
          'state.md': stateGen.method,
          'migrations.md': staticScanMethod(migrationsContent),
        },
        aiCache: { 'schema.md': schemaGen.cacheEntry, 'entities.md': entitiesGen.cacheEntry, 'state.md': stateGen.cacheEntry } };
    })(),
```

Note: `ctx.codeShape`, `ctx.aiCache`, and `ctx.existingOutputs` don't exist yet — Task 6 populates them in `main()` before calling `buildStages01to04`. This task's own integration test (Step 2) is expected to still fail until Task 6 lands; that's fine, it was written to prove the wiring once everything is connected. Do not stub these onto `ctx` yourself in this task — Task 6 owns that.

- [ ] **Step 6: Remove now-stale direct unit tests**

In `test/unit.test.js`, delete these two tests entirely (they test functions removed in Step 4):
`'extractBlocks pulls brace-balanced blocks'` and the three `'extractSqlStatements ...'` tests (`'captures a CREATE TABLE in full even when a DEFAULT value contains literal braces'`, `'handles nested parens...'`, `'has no aggregate line cap...'`).

In `test/detection.test.js`, delete the test `'expo extractors: sqlite schema, ts entities, zustand state'` entirely, and in `'laravel extractors: migrations and eloquent models'`, remove these two lines (keep the rest of the test — the `controllersBlock`/`sectionLabels` assertions stay for now, Task 5 handles `controllersBlock`):

```js
  assert.match(g.schemaBlock(ctx), /create_users_table/);
  assert.match(g.entitiesBlock(ctx), /\$fillable/);
```

Also update the `sectionLabels` assertion in that same test — it currently reads:

```js
  const labels = g.sectionLabels(d, 'MySQL');
  assert.strictEqual(labels.entities, 'Eloquent Model Definitions');
```

Change to match the simplified `sectionLabels` from Step 3:

```js
  const labels = g.sectionLabels(d, 'MySQL');
  assert.strictEqual(labels.entities, 'laravel Entity Definitions');
```

- [ ] **Step 7: Update module.exports**

Remove `schemaBlock, entitiesBlock, stateBlock,` from the exports line, and remove `extractBlocks,` and `extractSqlStatements,` from their respective export lines.

- [ ] **Step 8: Run the full suite and confirm expected state**

Run: `node --test test/*.test.js`
Expected: the tests deleted/modified in Steps 1/6 no longer reference removed functions (no `ReferenceError`/`TypeError: g.schemaBlock is not a function`). The new test from Step 2 still FAILS at this point (expected — `ctx.codeShape` doesn't exist until Task 6). Other pre-existing tests that call `runGenerator(root, ['--no-ai'])` and assert on `schema.md`/`entities.md`/`state.md` content will also fail now, since those files are empty (no `ctx.codeShape`, so `runGenerationCall` gets `paths: undefined` — this will throw, not just fail an assertion). This is expected at this intermediate point in the plan; Task 6 fixes it. Confirm the failures are all attributable to `ctx.codeShape` being undefined (a `TypeError: Cannot read properties of undefined`), not some other bug.

- [ ] **Step 9: Commit**

```bash
git add generate_project_context.js test/unit.test.js test/detection.test.js test/generator.test.js
git commit -m "Wire 03_data (schema/entities/state) to AI generation; remove old static extractors"
```

---

### Task 5: Wire 04_interfaces (routes/controllers/services) to the new pipeline; remove old extractors

**Files:**
- Modify: `generate_project_context.js` — `buildStages01to04` (04_interfaces block), delete `_routesSymfonyStatic`/`_routesLaravelStatic`/`routesBlock`, `SIGNATURE_PATTERNS`/`signatureScan`/`modelsBlock`/`controllersBlock`/`servicesBlock`, `hasServerFramework`/`NOT_APPLICABLE_NO_SERVER_FRAMEWORK`/`routesMethod` (keep `staticScanMethod` — still used by `migrations.md`)
- Modify: module.exports
- Modify: `test/unit.test.js` (remove `hasServerFramework` test)
- Modify: `test/detection.test.js` (remove the remaining `controllersBlock` assertion and `hasServerFramework` assertion)
- Modify: `test/generator.test.js` (remove tests asserting old static-scan-specific route text — full list in Task 8)

**Interfaces:**
- Consumes: `runGenerationCall` (Task 2), `ctx.codeShape.routes`/`ctx.codeShape.businessLogic` (populated by Task 6).
- Produces: 04_interfaces's `extraction` map for `routes.md`/`controllers.md`/`services.md` now uses `runGenerationCall`'s `method` field directly (no more `hasServerFramework`/`NOT_APPLICABLE_NO_SERVER_FRAMEWORK` gating — a stack with no routes simply gets `ai-no-relevant-files-found` from discovery finding nothing, the same outcome through a different, more general mechanism).

- [ ] **Step 1: Confirm current 04_interfaces block**

Re-run `grep -n "^function \|04_interfaces" generate_project_context.js` to get current line numbers (they will have shifted from Task 4's deletions) before editing.

- [ ] **Step 2: Delete the old routes/controllers/services extractors**

Delete entirely: `_routesSymfonyStatic`, `_routesLaravelStatic`, `routesBlock`, `SIGNATURE_PATTERNS`, `signatureScan`, `modelsBlock`, `controllersBlock`, `servicesBlock`, `hasServerFramework`, `NOT_APPLICABLE_NO_SERVER_FRAMEWORK`, `routesMethod`. Do NOT delete `staticScanMethod` — it's still used for `migrations.md`'s extraction label.

- [ ] **Step 3: Replace the 04_interfaces stage block**

Replace the 04_interfaces IIFE in `buildStages01to04` (currently):

```js
    (() => {
      const routesContent = routesBlock(ctx);
      const controllersContent = controllersBlock(ctx);
      const servicesContent = servicesBlock(ctx);
      return { name: '04_interfaces',
        contract: { inputs: [`source: ${ctx.detection.controllersDir || 'controller files'}`, `source: ${ctx.detection.servicesDir || 'service files'}`, openApiFile ? `source: ${openApiFile}` : 'source: (no OpenAPI spec found)'],
          process: 'Extracted API routes, controller and service signatures, and the OpenAPI spec if present.',
          outputs: [{ file: 'routes.md', desc: 'API routes' }, { file: 'controllers.md', desc: 'controller signatures' }, { file: 'services.md', desc: 'service signatures' }, { file: 'api-spec.md', desc: 'OpenAPI/Swagger spec' }] },
        outputs: {
          'routes.md': routesContent ? `# API Routes\n\n${routesContent}` : '',
          'controllers.md': controllersContent ? `# Controllers\n\n${annotateWithDomainNotes(controllersContent, domainNotes.services)}` : '',
          'services.md': servicesContent ? `# Services\n\n${annotateWithDomainNotes(servicesContent, domainNotes.services)}` : '',
          'api-spec.md': openApiRaw ? `# API Specification\n\n${openApiRaw}` : '',
        },
        extraction: {
          'routes.md': routesMethod(ctx, routesContent),
          'controllers.md': hasServerFramework(ctx.detection) ? staticScanMethod(controllersContent) : NOT_APPLICABLE_NO_SERVER_FRAMEWORK,
          'services.md': hasServerFramework(ctx.detection) ? staticScanMethod(servicesContent) : NOT_APPLICABLE_NO_SERVER_FRAMEWORK,
          'api-spec.md': openApiRaw ? (ctx.aiOpenApi ? 'ai-summarized-openapi-spec' : 'raw-openapi-spec-excerpt') : 'unavailable',
        } };
    })(),
```

with:

```js
    (() => {
      const cache = (ctx.aiCache && ctx.aiCache['04_interfaces']) || {};
      const existing = (file) => (ctx.existingOutputs && ctx.existingOutputs['04_interfaces'] && ctx.existingOutputs['04_interfaces'][file]) || null;

      const routesGen = runGenerationCall(ctx, {
        paths: ctx.codeShape.routes,
        promptInstructions: `Produce the API routes for this ${ctx.detection.primaryFramework} codebase as markdown: a table with columns Method | Path | Handler, one row per route found in the source files below. If no routes are found, say so in one sentence instead of an empty table.`,
        existingContent: existing('routes.md'),
        oldCacheEntry: cache['routes.md'],
      });
      const controllersGen = runGenerationCall(ctx, {
        paths: ctx.codeShape.routes,
        promptInstructions: `Produce the controller/handler signatures for this ${ctx.detection.primaryFramework} codebase as markdown: for each controller/handler found in the source files below, list its method signatures.\n\nFor each controller/handler found, use exactly this format (critical — other tooling parses this structure):\n\n#### \`ControllerName\`\n\`\`\`${ctx.detection.primaryExt}\n<method signatures, one per line>\n\`\`\`\n\nRepeat for every controller/handler found. Do not add any other heading levels or wrap controllers in additional sections.`,
        existingContent: existing('controllers.md'),
        oldCacheEntry: cache['controllers.md'],
      });
      const servicesGen = runGenerationCall(ctx, {
        paths: ctx.codeShape.businessLogic,
        promptInstructions: `Produce the service/business-logic signatures for this ${ctx.detection.primaryFramework} codebase as markdown: for each service class or module found in the source files below, list its method/function signatures.\n\nFor each service found, use exactly this format (critical — other tooling parses this structure):\n\n#### \`ServiceName\`\n\`\`\`${ctx.detection.primaryExt}\n<method signatures, one per line>\n\`\`\`\n\nRepeat for every service found. Do not add any other heading levels or wrap services in additional sections.`,
        existingContent: existing('services.md'),
        oldCacheEntry: cache['services.md'],
      });

      return { name: '04_interfaces',
        contract: { inputs: ['source: AI-discovered route/business-logic paths', openApiFile ? `source: ${openApiFile}` : 'source: (no OpenAPI spec found)'],
          process: 'Extracted API routes, controller and service signatures via AI discovery+generation, and the OpenAPI spec if present.',
          outputs: [{ file: 'routes.md', desc: 'API routes' }, { file: 'controllers.md', desc: 'controller signatures' }, { file: 'services.md', desc: 'service signatures' }, { file: 'api-spec.md', desc: 'OpenAPI/Swagger spec' }] },
        outputs: {
          'routes.md': routesGen.content ? `# API Routes\n\n${routesGen.content}` : '',
          'controllers.md': controllersGen.content ? `# Controllers\n\n${annotateWithDomainNotes(controllersGen.content, domainNotes.services)}` : '',
          'services.md': servicesGen.content ? `# Services\n\n${annotateWithDomainNotes(servicesGen.content, domainNotes.services)}` : '',
          'api-spec.md': openApiRaw ? `# API Specification\n\n${openApiRaw}` : '',
        },
        extraction: {
          'routes.md': routesGen.method,
          'controllers.md': controllersGen.method,
          'services.md': servicesGen.method,
          'api-spec.md': openApiRaw ? (ctx.aiOpenApi ? 'ai-summarized-openapi-spec' : 'raw-openapi-spec-excerpt') : 'unavailable',
        },
        aiCache: { 'routes.md': routesGen.cacheEntry, 'controllers.md': controllersGen.cacheEntry, 'services.md': servicesGen.cacheEntry } };
    })(),
```

- [ ] **Step 4: Remove now-stale direct unit tests**

In `test/unit.test.js`, delete the test `'hasServerFramework recognizes backend frameworks and rejects bare node/client-only stacks'` entirely.

In `test/detection.test.js`:
- In `'detects expo/node stack'`, remove the line `assert.strictEqual(g.hasServerFramework(d), false, 'expo is a client stack with no server routing');`.
- In `'laravel extractors: migrations and eloquent models'`, remove the line `assert.match(g.controllersBlock(ctx), /public function index/);` (the only remaining assertion in that test after Task 4's Step 6 removed the schema/entities lines — if the test body is now just building `ctx` and checking `sectionLabels`, that's fine, leave the rest).

- [ ] **Step 5: Update module.exports**

Remove `controllersBlock, servicesBlock, routesBlock, hasServerFramework,` from the exports line.

- [ ] **Step 6: Run the full suite**

Run: `node --test test/*.test.js`
Expected: no references to removed functions remain (no `ReferenceError`). Integration tests calling `runGenerator` still fail at this point with the same `ctx.codeShape` `TypeError` as after Task 4 — expected, Task 6 fixes it next.

- [ ] **Step 7: Commit**

```bash
git add generate_project_context.js test/unit.test.js test/detection.test.js
git commit -m "Wire 04_interfaces (routes/controllers/services) to AI generation; remove hasServerFramework gating"
```

---

### Task 6: Wire discovery + caching into `main()`; remove `--no-ai`; hard AI-required gate

**Files:**
- Modify: `generate_project_context.js` — `parseArgs` (line ~29), `checkAiAvailable` (line ~860), `main()` (line ~1497), `loadManifest`/`saveManifest`/`emptyManifest` (need `ai_cache` support alongside existing `extraction`)

**Interfaces:**
- Consumes: `discoverCodeShape` (Task 3), `runGenerationCall` (Task 2), `buildStages01to04` (Tasks 4/5 — now expects `ctx.codeShape`, `ctx.aiCache`, `ctx.existingOutputs`).
- Produces: `main()` now populates `ctx.codeShape`, `ctx.aiCache` (read from the manifest loaded before stage 01–04 runs), `ctx.existingOutputs` (read from disk before `writeStage` wipes each stage's output dir) before calling `buildStages01to04(ctx)`. After stages 03/04 are written, their returned `aiCache` sub-objects get folded into the manifest that's saved at the end of `main()`.

- [ ] **Step 1: Remove `--no-ai` from `parseArgs`**

Replace (current, around line 29):

```js
function parseArgs(argv) {
  const args = { useAi: true, aiCli: 'claude', contextDir: '.context', treeDepth: 3, debugDetection: false, dir: '.' };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--no-ai': args.useAi = false; break;
      case '--ai': args.aiCli = argv[++i]; break;
      case '--context-dir': args.contextDir = argv[++i]; break;
      case '--depth': args.treeDepth = parseInt(argv[++i], 10); if (Number.isNaN(args.treeDepth)) args.treeDepth = 3; break;
      case '--debug-detection': args.debugDetection = true; break;
      case '--dir': args.dir = argv[++i]; break;
      default: throw new Error(`Unknown option: ${argv[i]}`);
    }
  }
  return args;
}
```

with:

```js
function parseArgs(argv) {
  const args = { aiCli: 'claude', contextDir: '.context', treeDepth: 3, debugDetection: false, dir: '.' };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--ai': args.aiCli = argv[++i]; break;
      case '--context-dir': args.contextDir = argv[++i]; break;
      case '--depth': args.treeDepth = parseInt(argv[++i], 10); if (Number.isNaN(args.treeDepth)) args.treeDepth = 3; break;
      case '--debug-detection': args.debugDetection = true; break;
      case '--dir': args.dir = argv[++i]; break;
      default: throw new Error(`Unknown option: ${argv[i]}`);
    }
  }
  return args;
}
```

Update `test/unit.test.js`'s `'parseArgs defaults'` test:

```js
test('parseArgs defaults', () => {
  const a = g.parseArgs([]);
  assert.deepStrictEqual(a, { aiCli: 'claude', contextDir: '.context', treeDepth: 3, debugDetection: false, dir: '.' });
});
```

Update `test/unit.test.js`'s `'parseArgs flags'` test:

```js
test('parseArgs flags', () => {
  const a = g.parseArgs(['--ai', 'gemini', '--context-dir', 'ctx', '--depth', '5', '--debug-detection']);
  assert.deepStrictEqual(a, { aiCli: 'gemini', contextDir: 'ctx', treeDepth: 5, debugDetection: true, dir: '.' });
});
```

- [ ] **Step 2: Simplify `checkAiAvailable`**

Read the current `checkAiAvailable` (around line 860) to confirm it still matches:

```js
function checkAiAvailable(args) {
  if (!args.useAi) return { useAi: false, reason: '--no-ai' };
  if (process.env.CLAUDECODE && args.aiCli === 'claude') {
    return { useAi: false, reason: 'Running inside a Claude Code session — AI summaries skipped (nested sessions not supported).' };
  }
  const which = spawnSync('which', [args.aiCli], { encoding: 'utf8' });
  if (which.status !== 0 || !which.stdout || !which.stdout.trim()) {
    return { useAi: false, reason: `${args.aiCli} CLI not found — AI summaries skipped. Install ${args.aiCli} to enable.` };
  }
  return { useAi: true, reason: `${args.aiCli} CLI detected — AI summaries enabled.` };
}
```

Replace with:

```js
function checkAiAvailable(args) {
  if (process.env.CLAUDECODE && args.aiCli === 'claude') {
    return { useAi: false, reason: 'Running inside a Claude Code session — nested sessions not supported. Pass --ai gemini or a different CLI.' };
  }
  const which = spawnSync('which', [args.aiCli], { encoding: 'utf8' });
  if (which.status !== 0 || !which.stdout || !which.stdout.trim()) {
    return { useAi: false, reason: `${args.aiCli} CLI not found on PATH. Install ${args.aiCli}, or pass --ai <other-cli>.` };
  }
  return { useAi: true, reason: `${args.aiCli} CLI detected.` };
}
```

- [ ] **Step 3: Add the hard AI-required gate in `main()`, and wire discovery**

In `main()`, find (current, around line 1505–1507):

```js
  // Phase 1: AI availability — needed for stack determination below.
  const ai = checkAiAvailable(args);
  if (!ai.useAi && args.useAi) log.info(ai.reason);
```

Replace with (this keeps the AI *check* here, unchanged in spirit — `determineAppStack` below still uses `ai.useAi` optionally for disambiguation — but does NOT hard-exit yet; the hard-exit must come AFTER the `--debug-detection` early-return a few lines down, since that mode is deliberately AI-optional today and must stay that way — only the actual extraction pipeline requires AI):

```js
  // Phase 1: AI availability. Checked here (not yet enforced) because
  // determineAppStack below can optionally use it for stack disambiguation
  // even in the AI-optional --debug-detection path. The hard "AI required"
  // gate is enforced further down, after the --debug-detection early-return.
  const ai = checkAiAvailable(args);
  log.info(ai.reason);
```

Find (current, around line 1514):

```js
  if (args.debugDetection) { console.log(JSON.stringify({ repoName, detection, devEnv, dbHints, versions, useAi: ai.useAi }, null, 2)); return; }
  // All filesystem writes happen after the debug-detection early-return above,
  // so --debug-detection stays strictly read-only.
  // Phase 4: Ignore rules — set up after stack is known.
```

Replace with (adds the hard gate immediately after the debug-detection early-return, so `--debug-detection` keeps working without any AI CLI on PATH, exactly as today, while every other invocation now requires one):

```js
  if (args.debugDetection) { console.log(JSON.stringify({ repoName, detection, devEnv, dbHints, versions, useAi: ai.useAi }, null, 2)); return; }
  // All filesystem writes happen after the debug-detection early-return above,
  // so --debug-detection stays strictly read-only (and, deliberately, still
  // works with no AI CLI on PATH — only the actual extraction below needs one).
  if (!ai.useAi) {
    console.error(`Error: an AI CLI is required to run this generator. ${ai.reason}`);
    process.exit(1);
  }
  // Phase 4: Ignore rules — set up after stack is known.
```

Find (current, around line 1520):

```js
  const ctx = { root, appDir, detection, devEnv, dbHints, versions, ignoreFn, treeDepth: args.treeDepth, contextDir: args.contextDir, useAi: ai.useAi, aiCli: args.aiCli, repoName };
```

Immediately after that line and before the existing OpenAPI AI-summary block, insert the discovery + cache/existing-output loading:

```js
  // Phase 4b: load the manifest early (needed for 03_data/04_interfaces's
  // generation cache) and read each stage's existing output before
  // writeStage() wipes it, so generation can review-and-amend rather than
  // blindly overwrite.
  const priorManifest = loadManifest(root, args.contextDir, repoName);
  ctx.aiCache = {
    '03_data': (priorManifest.stages['03_data'] && priorManifest.stages['03_data'].ai_cache) || {},
    '04_interfaces': (priorManifest.stages['04_interfaces'] && priorManifest.stages['04_interfaces'].ai_cache) || {},
  };
  const readExisting = (stageName, file) => readText(path.join(root, args.contextDir, 'stages', stageName, 'output', file));
  ctx.existingOutputs = {
    '03_data': { 'schema.md': readExisting('03_data', 'schema.md'), 'entities.md': readExisting('03_data', 'entities.md'), 'state.md': readExisting('03_data', 'state.md') },
    '04_interfaces': { 'routes.md': readExisting('04_interfaces', 'routes.md'), 'controllers.md': readExisting('04_interfaces', 'controllers.md'), 'services.md': readExisting('04_interfaces', 'services.md') },
  };

  log.info(`Calling ${args.aiCli} — discovering data-model/routes/business-logic/state paths...`);
  ctx.codeShape = discoverCodeShape(ctx);
```

- [ ] **Step 4: Fold each stage's returned `aiCache` into the manifest that gets saved**

Find (current, around line 1557–1561):

```js
  const stageIndex = [];
  const purposes = { '01_overview': 'Stack, environment, metrics', '02_architecture': 'Structure and git activity', '03_data': 'Schema, entities, state, migrations', '04_interfaces': 'Routes, controllers, services, API spec' };
  for (const stage of buildStages01to04(ctx)) {
    log.info(`Stage ${stage.name}...`);
    const written = writeStage(root, args.contextDir, stage.name, stage.contract, stage.outputs);
    stageIndex.push({ stage: stage.name, purpose: purposes[stage.name], extraction: stage.extraction, files: written.map((f) => ({ rel: `output/${f}`, bytes: fs.statSync(path.join(root, args.contextDir, 'stages', stage.name, 'output', f)).size })) });
  }
```

Replace with:

```js
  const stageIndex = [];
  const purposes = { '01_overview': 'Stack, environment, metrics', '02_architecture': 'Structure and git activity', '03_data': 'Schema, entities, state, migrations', '04_interfaces': 'Routes, controllers, services, API spec' };
  for (const stage of buildStages01to04(ctx)) {
    log.info(`Stage ${stage.name}...`);
    const written = writeStage(root, args.contextDir, stage.name, stage.contract, stage.outputs);
    stageIndex.push({ stage: stage.name, purpose: purposes[stage.name], extraction: stage.extraction, aiCache: stage.aiCache, files: written.map((f) => ({ rel: `output/${f}`, bytes: fs.statSync(path.join(root, args.contextDir, 'stages', stage.name, 'output', f)).size })) });
  }
```

Note: `loadManifest`/`emptyManifest`/`saveManifest` themselves need no changes — `manifest.stages[stageName]` is already a free-form object (`{ last_run, extraction }` today); this just adds an `ai_cache` key alongside `extraction` when present. Find, in `main()`, the final manifest-building loop (current, near the end of `main()`):

```js
  for (const s of stageIndex) finalManifest.stages[s.stage] = { last_run: finalManifest.generated_at, ...(s.extraction ? { extraction: s.extraction } : {}) };
```

Replace with:

```js
  for (const s of stageIndex) finalManifest.stages[s.stage] = { last_run: finalManifest.generated_at, ...(s.extraction ? { extraction: s.extraction } : {}), ...(s.aiCache ? { ai_cache: s.aiCache } : {}) };
```

- [ ] **Step 5: Run the full suite**

Run: `node --test test/*.test.js`
Expected: the Task 4/5 integration test failures from `ctx.codeShape` being undefined are now gone (the `TypeError`s are resolved). Tests still asserting old `--no-ai`-based behavior or old static-extraction content will now fail differently — either "Unknown option: --no-ai" (for tests still passing that flag) or wrong-content assertions (for tests expecting regex-derived text). This is expected; Task 8 rewrites those tests. For now, confirm no crashes/`TypeError`s remain — only assertion failures on content/flags that Task 8 will fix.

- [ ] **Step 6: Commit**

```bash
git add generate_project_context.js test/unit.test.js
git commit -m "Wire discovery + generation cache into main(); remove --no-ai; require an AI CLI to run at all"
```

---

### Task 7: Extend `fake-ai.js` for discovery + all 6 generation prompt shapes

**Files:**
- Modify: `test/fixtures/bin/fake-ai.js`

**Interfaces:**
- Consumes: nothing new — same `process.argv[3]` prompt-text convention it already uses.
- Produces: canned responses for discovery prompts (detected via the `DATA_MODEL:`/`ROUTES:`/etc. instruction text) and each of the 6 generation prompt shapes (detected via distinctive substrings from Tasks 4/5's `promptInstructions`), tailored to the `symfony-app` fixture's real files (`src/Entity/Foo.php`, `src/Entity/Bar.php`, `src/Controller/FooController.php`) so the existing domain-notes-merge tests (which assert on `Foo`/`Bar`/`FooController` content) keep passing once Task 8 migrates them to use `--ai fake-ai.js` instead of `--no-ai`.

- [ ] **Step 1: Read the current fixture**

Read `test/fixtures/bin/fake-ai.js` in full — it currently branches on whether the prompt contains "knowledge gap" (case-insensitive), returning either a gaps-shaped or a synthesis-shaped canned response, both prefixed with a leaked-preamble string used by the preamble-stripping tests.

- [ ] **Step 2: Write the failing test that exercises every new branch**

Add to `test/generator.test.js`:

```js
test('fake-ai.js responds distinctly to discovery and all 6 generation prompt shapes for the symfony fixture', () => {
  const root = copyFixture('symfony-app');
  const fakeAi = path.join(__dirname, 'fixtures/bin/fake-ai.js');
  const r = runGenerator(root, ['--ai', fakeAi]);
  assert.strictEqual(r.status, 0, r.stderr);
  const ctxDir = path.join(root, '.context');
  const schema = fs.readFileSync(path.join(ctxDir, 'stages/03_data/output/schema.md'), 'utf8');
  const entities = fs.readFileSync(path.join(ctxDir, 'stages/03_data/output/entities.md'), 'utf8');
  const routes = fs.readFileSync(path.join(ctxDir, 'stages/04_interfaces/output/routes.md'), 'utf8');
  const controllers = fs.readFileSync(path.join(ctxDir, 'stages/04_interfaces/output/controllers.md'), 'utf8');
  assert.match(schema, /#### `Foo`/);
  assert.match(entities, /#### `Foo`/);
  assert.match(entities, /#### `Bar`/);
  assert.match(routes, /Method \| Path \| Handler/);
  assert.match(controllers, /#### `FooController`/);
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `node --test test/generator.test.js`
Expected: FAIL — `fake-ai.js` doesn't yet recognize discovery/generation prompts, so it returns its default synthesis-shaped response for all of them, and `schema.md`/`entities.md`/`routes.md`/`controllers.md` won't contain the expected `#### \`Foo\`\`` / table text.

- [ ] **Step 4: Extend the fixture**

Replace the full contents of `test/fixtures/bin/fake-ai.js`:

```js
#!/usr/bin/env node
// Minimal stand-in for an AI CLI (`claude -p <prompt>`) used only in tests.
// Branches on the prompt text so different callAi() call sites (discovery,
// the 6 generation calls, 06_synthesis, the knowledge-gaps review) can be
// tested against distinct canned responses. Every response is deliberately
// contaminated with leaked routing/self-talk preamble so tests can assert
// the generator strips it before persisting any of these outputs.
const prompt = process.argv[3] || '';
const PREAMBLE = "This is a plain content-generation task (writing a doc summary), not creative feature work or a coding task — no skill applies here.\n\n";

if (/DATA_MODEL:/.test(prompt)) {
  process.stdout.write(PREAMBLE +
    'DATA_MODEL: src/Entity/Foo.php, src/Entity/Bar.php\n' +
    'ROUTES: src/Controller/FooController.php\n' +
    'BUSINESS_LOGIC: \n' +
    'STATE: \n'
  );
} else if (/database\/storage schema/.test(prompt)) {
  process.stdout.write(PREAMBLE +
    '#### `Foo`\n```sql\nid INTEGER PRIMARY KEY,\nhall_of_fame_points INTEGER\n```\n'
  );
} else if (/code-level entity\/model definitions/.test(prompt)) {
  process.stdout.write(PREAMBLE +
    '#### `Foo`\n```php\nprivate int $hallOfFamePoints;\n```\n\n' +
    '#### `Bar`\n```php\nprivate int $id;\n```\n'
  );
} else if (/client-side state\/store shape/.test(prompt)) {
  process.stdout.write(PREAMBLE); // no store found for this fixture — empty content after preamble strip
} else if (/API routes for this/.test(prompt)) {
  process.stdout.write(PREAMBLE +
    '| Method | Path | Handler |\n|---|---|---|\n| GET | /api/foo | FooController::show |\n'
  );
} else if (/controller\/handler signatures/.test(prompt)) {
  process.stdout.write(PREAMBLE +
    '#### `FooController`\n```php\npublic function show(int $id): Response\n```\n'
  );
} else if (/service\/business-logic signatures/.test(prompt)) {
  process.stdout.write(PREAMBLE); // no business-logic paths discovered for this fixture
} else if (/knowledge gap/i.test(prompt)) {
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

- [ ] **Step 5: Run to verify it passes**

Run: `node --test test/generator.test.js`
Expected: PASS for the new test. Also re-run the full suite (`node --test test/*.test.js`) and confirm the pre-existing `'06_synthesis strips leaked model self-talk...'` and `'knowledge-gap review writes KNOWLEDGE_GAPS.md...'` tests (which rely on this fixture's default/knowledge-gap branches) still pass — those prompts don't match any of the new `else if` conditions above, so they still fall through to the original branches.

- [ ] **Step 6: Commit**

```bash
git add test/fixtures/bin/fake-ai.js test/generator.test.js
git commit -m "Extend fake-ai.js to respond to discovery and all 6 generation prompt shapes"
```

---

### Task 8: Migrate `test/generator.test.js` and `test/detection.test.js` off `--no-ai`

**Files:**
- Modify: `test/generator.test.js`
- Modify: `test/detection.test.js`
- Modify: `test/helpers.js` (if needed — check `runGenerator`'s signature still works unchanged; it just passes `args` through to `spawnSync`, so no change should be needed)

**Interfaces:**
- Consumes: `fake-ai.js` (Task 7), `runGenerator(root, args)` (existing, `test/helpers.js`, unchanged).
- Produces: no new production interfaces — this task only changes tests. Every test that previously ran with `['--no-ai']` now runs with `['--ai', fakeAiPath]` (or is deleted if it specifically tested old static-extraction behavior that no longer exists).

- [ ] **Step 1: Delete tests for removed behavior**

Delete these tests from `test/generator.test.js` entirely — they test static-regex-scan-specific behavior that no longer exists:
- `'schema.md captures every CREATE TABLE in schema.sql in full, including a braced DEFAULT and a table far down a long file'` (tested `extractSqlStatements`'s specific brace/line-cap bugs — those bugs can't recur in an AI-generated file; the general "schema.md is generated correctly" property is covered by Task 4's Step 2 test and Task 7's Step 2 test instead).
- `'routes.md is marked not-applicable for a client-only stack instead of matching arbitrary client code'` (tested the old `hasServerFramework` gate specifically).
- `'symfony routes.md falls back to a static #[Route] scan when debug:router cannot be run'` and `'laravel routes.md falls back to a static Route:: scan when artisan cannot be run'` (tested the old static-scan text format).
- `'schema.md reflects newly added migrations after a rerun, not stale ones'` and `'latest-10 migration selection is not fooled by an archive/ subdirectory sorting after plain filenames'` — **do NOT delete these two**: `migrationsBlock`/`migrations.md` is untouched by this redesign (stays deterministic), so these regression tests remain valid as-is. Leave them exactly as they are.
- `'router and manifest stamp generator commit and per-output extraction provenance'` — delete this one specifically because it asserts the OLD label `static-regex-fallback` for `routes.md`; a replacement is written in Step 3 below.

- [ ] **Step 2: Update the remaining `--no-ai` integration tests to use the fake AI CLI**

For every remaining test in `test/generator.test.js` that calls `runGenerator(root, ['--no-ai'])` (and any variant like `['--no-ai', '--debug-detection']` or `['--no-ai', '--context-dir', 'docs/ctx']`), replace `'--no-ai'` with `'--ai', path.join(__dirname, 'fixtures/bin/fake-ai.js')`. Concretely, for each test, add this line near the top of the test body (after `const root = copyFixture(...)`) if not already present:

```js
  const fakeAi = path.join(__dirname, 'fixtures/bin/fake-ai.js');
```

then change every `runGenerator(root, [...'--no-ai'...])` call in that test to use `['--ai', fakeAi, ...]` in place of `['--no-ai', ...]` (same position, same other flags). Apply this mechanically to:
`'full run creates ICM skeleton with contracts (expo, no-ai)'` (rename to drop "no-ai" from its title too, since it no longer applies — rename to `'full run creates ICM skeleton with contracts (expo)'`), `'ignore seed file is never overwritten'`, `'stage 05 indexes docs, excludes vendored md, and ledger skips unchanged files'` (both `runGenerator` calls in this test), `'no-ai run marks stage 06 as not executed'` (**delete this test** instead — it specifically tested the no-AI degraded path, which no longer exists), `'laravel fixture full run'`, `'nested --context-dir produces correct index link depth'`, `'--dir targets another project from a different cwd'`, `'--dir with missing path exits 1 without writes'` (this one has no AI-related assertions and exits before any AI call — leave its `'--no-ai'` flag as harmless-but-now-invalid; actually **remove the `--no-ai` flag from this one entirely**, since the test is about the `--dir`-not-found error path, which happens before AI is even checked — verify by reading `main()`'s order: the directory-exists check happens before `checkAiAvailable`, so no AI CLI is needed for this test to pass), `'schema.md reflects newly added migrations after a rerun, not stale ones'`, `'latest-10 migration selection is not fooled by an archive/ subdirectory sorting after plain filenames'`, `'domain notes from a hand-maintained CLAUDE.md (table format) are merged uniformly into entities.md'`, `'overlapping "Key Gotchas" lines collapse into one Field note per entity, not one per field-name match'`, `'Field notes only attach to entities that actually declare every field the note names (no keyword-overlap misattribution)'`, `'the same CLAUDE.md merge covers 04_interfaces (services.md, controllers.md), not just 03_data'`, `'knowledge-gap review is skipped entirely under --no-ai: no file, no router pointer'` (**rename and rewrite** — see Step 4 below, since "under --no-ai" no longer applies).

Also delete the `'default flags without AI CLI on PATH: second run still skips via ledger'` test — it specifically tests the graceful no-AI-CLI-found degraded path, which Task 6 replaced with a hard `process.exit(1)`. A replacement covering the new hard-failure behavior is written in Step 3.

**Special case — `'--debug-detection prints JSON and writes nothing'`:** do NOT swap `--no-ai` for `--ai fakeAi` here. Task 6 deliberately kept `--debug-detection` working with no AI CLI on PATH at all (the hard gate sits after the debug-detection early-return in `main()`). Instead, just remove the `'--no-ai'` string from this test's `runGenerator(root, ['--no-ai', '--debug-detection'])` call, leaving `runGenerator(root, ['--debug-detection'])`. The test's existing assertions (parses `r.stdout` as JSON, asserts no `.context` was written) are otherwise unchanged. A dedicated regression test locking in "no AI CLI needed for this mode" is added in Step 3.

- [ ] **Step 3: Add tests for the new hard-failure and provenance behavior**

Add to `test/generator.test.js`:

```js
test('exits 1 with no writes when no AI CLI is on PATH', () => {
  const { spawnSync } = require('node:child_process');
  const root = copyFixture('expo-app');
  const SCRIPT = path.join(__dirname, '..', 'generate_project_context.js');
  const env = { ...process.env, PATH: '/usr/bin:/bin' };
  delete env.CLAUDECODE;
  const r = spawnSync(process.execPath, [SCRIPT], { cwd: root, encoding: 'utf8', env });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /an AI CLI is required/);
  assert.ok(!fs.existsSync(path.join(root, '.context')), 'no writes when the AI gate fails');
});

test('--debug-detection still works with no AI CLI on PATH at all (deliberately AI-optional)', () => {
  const { spawnSync } = require('node:child_process');
  const root = copyFixture('expo-app');
  const SCRIPT = path.join(__dirname, '..', 'generate_project_context.js');
  const env = { ...process.env, PATH: '/usr/bin:/bin' };
  delete env.CLAUDECODE;
  const r = spawnSync(process.execPath, [SCRIPT, '--debug-detection'], { cwd: root, encoding: 'utf8', env });
  assert.strictEqual(r.status, 0, r.stderr);
  const parsed = JSON.parse(r.stdout);
  assert.strictEqual(parsed.detection.primaryLang, 'node');
  assert.ok(!fs.existsSync(path.join(root, '.context')));
});

test('router and manifest stamp generator commit and AI-driven extraction provenance', () => {
  const root = copyFixture('symfony-app');
  const fakeAi = path.join(__dirname, 'fixtures/bin/fake-ai.js');
  const r = runGenerator(root, ['--ai', fakeAi]);
  assert.strictEqual(r.status, 0, r.stderr);
  const router = fs.readFileSync(path.join(root, '.context/CONTEXT.md'), 'utf8');
  assert.match(router, /Generator: v[\d.]+ \([0-9a-f]{7,}|unknown\)/);
  assert.match(router, /## Extraction provenance/);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, '.context/_config/manifest.json'), 'utf8'));
  assert.match(manifest.generator_commit, /^[0-9a-f]{7,}$|^unknown$/);
  assert.strictEqual(manifest.stages['03_data'].extraction['schema.md'], 'ai-generated');
  assert.strictEqual(manifest.stages['04_interfaces'].extraction['routes.md'], 'ai-generated');
});

test('a second run with no source changes reuses cached AI generation (ai-cached)', () => {
  const root = copyFixture('symfony-app');
  const fakeAi = path.join(__dirname, 'fixtures/bin/fake-ai.js');
  const r1 = runGenerator(root, ['--ai', fakeAi]);
  assert.strictEqual(r1.status, 0, r1.stderr);
  const r2 = runGenerator(root, ['--ai', fakeAi]);
  assert.strictEqual(r2.status, 0, r2.stderr);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, '.context/_config/manifest.json'), 'utf8'));
  assert.match(manifest.stages['03_data'].extraction['schema.md'], /^ai-cached \(last reviewed \d{4}-\d{2}-\d{2}\)$/);
});
```

- [ ] **Step 4: Rewrite the knowledge-gaps no-AI test for the new hard-failure model**

The old test `'knowledge-gap review is skipped entirely under --no-ai: no file, no router pointer'` asserted behavior under `--no-ai`, which no longer exists. Since AI is now mandatory, KNOWLEDGE_GAPS.md is written whenever the generator runs at all (per the existing knowledge-gaps review logic, unchanged by this plan) — there's no longer a "no AI" case to test for this specific file. Delete this test; the existing `'knowledge-gap review writes KNOWLEDGE_GAPS.md and a router pointer when AI is available'` test already covers the only remaining case (AI available, since it's now the only case).

- [ ] **Step 5: Update `test/detection.test.js`'s remaining `--no-ai`-adjacent assumptions**

None of `test/detection.test.js`'s tests call `runGenerator` — they call `detectStack`/extractor functions directly, so none reference `--no-ai`. No changes needed here beyond what Tasks 4/5 already made. Confirm this by re-reading the file after Tasks 4/5 land: it should have no remaining references to `schemaBlock`, `entitiesBlock`, `stateBlock`, `controllersBlock`, `servicesBlock`, `hasServerFramework`, or `--no-ai`.

- [ ] **Step 6: Run the full suite**

Run: `node --test test/*.test.js`
Expected: PASS, all tests. If any fixture-content assertion fails (e.g. a test expects specific text `fake-ai.js` doesn't produce for that fixture), extend `fake-ai.js` (Task 7's file) with an additional branch for that fixture/prompt combination rather than weakening the assertion.

- [ ] **Step 7: Commit**

```bash
git add test/generator.test.js test/detection.test.js
git commit -m "Migrate generator.test.js off --no-ai; add hard-failure and caching regression tests"
```

---

### Task 9: README update

**Files:**
- Modify: `README.md`

**Interfaces:** None (documentation only).

- [ ] **Step 1: Read the current README in full**

Confirm the exact current wording of the `## Usage` flags table, the `## Requirements` section, and the `## Supported stacks` table before editing — this file may have been touched since the last plan referenced it.

- [ ] **Step 2: Update `## Requirements`**

Change the line `- Claude CLI or Gemini CLI _(optional — enables AI summaries and stack disambiguation)_` to:

```markdown
- Claude CLI or Gemini CLI — **required**. This generator's schema/entity/route/controller/service extraction is entirely AI-driven; there is no static-regex fallback.
```

- [ ] **Step 3: Update `## Usage`**

Remove `--no-ai` from the usage line and its row from the flags table. The usage line changes from:

```
node generate_project_context.js [--no-ai] [--ai <claude|gemini>] [--context-dir <dir>] [--depth <n>] [--dir <path>] [--debug-detection]
```

to:

```
node generate_project_context.js [--ai <claude|gemini>] [--context-dir <dir>] [--depth <n>] [--dir <path>] [--debug-detection]
```

Remove the `| --no-ai | Skip all AI calls, static extraction only | AI enabled |` row from the flags table entirely.

- [ ] **Step 4: Replace `## Supported stacks`**

This table currently documents per-framework static extraction (Doctrine migrations, Eloquent `$fillable`, etc.), which no longer applies. Replace the whole section:

```markdown
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
```

with:

```markdown
## Schema/entity/route/controller/service extraction

`schema.md`, `entities.md`, `state.md`, `routes.md`, `controllers.md`, and
`services.md` are produced by a two-pass AI process, not per-framework
static extraction — this works on any stack (including ones with no known
MVC convention, like WordPress) since it reasons from the codebase's
structure rather than a fixed enum of framework layouts:

1. **Discovery** (1 AI call): the generator shows the AI the directory tree
   and manifest file, and asks which paths define the data model, routes,
   business logic, and client-side state.
2. **Generation** (up to 6 AI calls, one per output file): each file's
   content is generated from the paths discovery named for its category. If
   the file already exists from a previous run, the AI is asked to update
   it — keeping what's still accurate, adding what's new — rather than
   regenerating from scratch.

Generation results are cached per file in `_config/manifest.json`: a rerun
skips the AI call and reuses the existing file when the underlying source
hasn't changed AND the last review was within 30 days; otherwise it
re-reviews. Stack/dev-env/DB detection, the directory tree, git activity,
and file counts stay fully deterministic (no AI involved) — only the six
files above require an AI CLI to be populated.
```

- [ ] **Step 5: Proofread**

Read the full updated `README.md` top to bottom; confirm no dangling references to `--no-ai` or the removed per-stack extraction table remain anywhere else in the file (check the `## Stack detection` section specifically — it should be unaffected, since `detectStack()` itself is untouched by this plan, but verify it doesn't cross-reference the now-removed `## Supported stacks` table by name).

- [ ] **Step 6: Commit**

```bash
git add README.md
git commit -m "Document AI-driven schema/entity/route/controller/service extraction; remove --no-ai from usage docs"
```

---

## Final verification (after all tasks)

- [ ] Run the full suite once more: `node --test test/*.test.js` — expect all tests passing, zero failures.
- [ ] Manually generate against a copy of `test/fixtures/symfony-app` with the fake AI CLI and eyeball the output:

```bash
tmp=$(mktemp -d)
cp -r test/fixtures/symfony-app/. "$tmp"/
node generate_project_context.js --ai "$PWD/test/fixtures/bin/fake-ai.js" --dir "$tmp"
cat "$tmp/.context/stages/03_data/output/entities.md"
cat "$tmp/.context/stages/04_interfaces/output/routes.md"
cat "$tmp/.context/_config/manifest.json" | grep -A3 '"03_data"'
rm -rf "$tmp"
```

Expected: `entities.md` has `#### \`Foo\`` and `#### \`Bar\`` sections; `routes.md` has a Method|Path|Handler table; the manifest shows `extraction` labels of `ai-generated` and an `ai_cache` object with `source_hash`/`last_reviewed_at`.
- [ ] Confirm `node generate_project_context.js` (no args, no AI CLI on PATH) exits 1 with the "an AI CLI is required" message and writes nothing.
