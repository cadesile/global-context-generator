# Stability, Performance & Cross-Platform Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden `generate_project_context.js` for Windows compatibility, CLI-arg safety, ARG_MAX-safe AI calls, and concurrent AI extraction in stages 03/04 — without changing any ICM output shape, cache semantics, or domain-note injection behavior.

**Architecture:** Five self-contained, ordered edits to the single existing file (no new files): (1) swap `which`→platform-aware lookup, (2) swap `.split('\n')`→`.split(/\r?\n/)` at every line-splitting site, (3) bounds-check CLI flag values in `parseArgs`, (4) give `callAi` a stdin/temp-file path for prompts >8KB, (5) add `callAiAsync` + an async `runGenerationCallAsync` and switch the 03_data/04_interfaces IIFEs to run their AI calls concurrently via `Promise.all`. Existing synchronous `callAi`/`runGenerationCall` stay in place for every other call site (stack determination, code-shape discovery, OpenAPI summary, stage 06 synthesis, knowledge-gaps review, doc summarizer) — only 03_data and 04_interfaces move to the async path, since those are the only stages with independent, parallelizable AI calls per the spec.

**Tech Stack:** Node.js (`node:fs`, `node:path`, `node:child_process`, `node:os`), Node's built-in test runner (`node --test`), existing `test/unit.test.js` / `test/generator.test.js` / `test/detection.test.js`.

## Global Constraints

- Do not change any ICM stage contract, output filenames, cache/manifest schema, or domain-note injection logic — this is a stability/perf/cross-platform refactor only.
- Every new code path must degrade the same way the old one did on failure (return `''`/`false`/existing content, never throw uncaught).
- No new dependencies — stdlib only (`node:child_process`, `node:fs`, `node:os`, `node:path`).
- Preserve the existing exports list in `module.exports` (append new names, never remove/rename existing ones) since `test/unit.test.js` and `test/generator.test.js` import by name.
- All existing tests in `test/unit.test.js`, `test/generator.test.js`, `test/detection.test.js` must keep passing (`node --test test/`).

---

### Task 1: Cross-platform `which`/`where` lookup in `checkAiAvailable`

**Files:**
- Modify: `generate_project_context.js:578-587` (`checkAiAvailable`)
- Test: `test/unit.test.js`

**Interfaces:**
- Consumes: nothing new.
- Produces: `checkAiAvailable(args)` behavior unchanged in shape (`{ useAi, reason }`), just resolves the lookup binary per-platform. No signature change, so every existing caller (`main()`) is untouched.

- [ ] **Step 1: Write the failing test**

Add to `test/unit.test.js` (near other `checkAiAvailable`-adjacent tests, or create a new block if none exist — check with `grep -n checkAiAvailable test/unit.test.js` first since none currently exists):

```js
test('checkAiAvailable uses "where" lookup on win32, "which" elsewhere', () => {
  const realPlatform = process.platform;
  const spawnSyncMod = require('node:child_process');
  const realSpawnSync = spawnSyncMod.spawnSync;
  let capturedCmd = null;
  spawnSyncMod.spawnSync = (cmd, args, opts) => {
    if (args && args[0] === 'nonexistent-cli-xyz') { capturedCmd = cmd; return { status: 1, stdout: '' }; }
    return realSpawnSync(cmd, args, opts);
  };
  Object.defineProperty(process, 'platform', { value: 'win32' });
  try {
    g.checkAiAvailable({ aiCli: 'nonexistent-cli-xyz' });
    assert.strictEqual(capturedCmd, 'where');
  } finally {
    Object.defineProperty(process, 'platform', { value: realPlatform });
    spawnSyncMod.spawnSync = realSpawnSync;
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/unit.test.js`
Expected: FAIL — `capturedCmd` is `'which'`, not `'where'`, because the platform check doesn't exist yet.

- [ ] **Step 3: Implement the fix**

In `generate_project_context.js`, replace:

```js
  const which = spawnSync('which', [args.aiCli], { encoding: 'utf8' });
```

with:

```js
  const lookupCmd = process.platform === 'win32' ? 'where' : 'which';
  const which = spawnSync(lookupCmd, [args.aiCli], { encoding: 'utf8' });
```

(Leave the rest of `checkAiAvailable` — the `!which.stdout || !which.stdout.trim()` check and return values — exactly as-is; `where` and `which` both exit non-zero with empty stdout when the binary isn't found, so no other branch needs to change.)

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/unit.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add generate_project_context.js test/unit.test.js
git commit -m "fix: use platform-aware which/where lookup in checkAiAvailable"
```

---

### Task 2: Normalize line-ending handling across all `.split('\n')` call sites

**Files:**
- Modify: `generate_project_context.js` at every line listed below
- Test: `test/unit.test.js`

**Interfaces:**
- Consumes: nothing new.
- Produces: no signature changes anywhere — purely internal parsing fix. `grepLines()`'s exported signature (`grepLines(content, regex, limit)`) is unchanged.

Every one of these lines splits file/command content into lines for regex/string matching, and a trailing `\r` (present in CRLF content on Windows, or content copied from a CRLF source) would corrupt matches (e.g. `line.startsWith('#')` failing because the line is actually `"#comment\r"` vs a regex anchored with `$`). Replace `.split('\n')` with `.split(/\r?\n/)` at every one of these sites — do not touch `.join('\n')` calls (those are output-side and stay `\n`):

- `generate_project_context.js:53` — `grepLines()`
- `generate_project_context.js:105` — `createIgnoreMatcher()`, gitignore lines
- `generate_project_context.js:107` — `createIgnoreMatcher()`, custom ignore lines
- `generate_project_context.js:353` — `detectDatabases()`
- `generate_project_context.js:417` — `envBlock()`, `mask`
- `generate_project_context.js:418` — `envBlock()`, `plain`
- `generate_project_context.js:489` — `gitActivityBlock()` (git output is LF-only from git itself even on Windows in this context since `spawnSync` captures raw stdout, but normalize for consistency — see note below)
- `generate_project_context.js:548` — `injectContextReference()`
- `generate_project_context.js:796` — `collectAiContextFiles()`
- `generate_project_context.js:893` — `extractDomainNotes()`
- `generate_project_context.js:974` — `annotateWithDomainNotes()`
- `generate_project_context.js:1112` — `stripGeneratedWrapper()`
- `generate_project_context.js:1130` — `mdDigest()`
- `generate_project_context.js:1529` — inline in `main()`, `gitRecent`

Note on git-output lines (489, 1529): git's `--oneline`/`--name-only` output is newline-terminated with `\n` on all platforms when read via `spawnSync`'s pipe, but normalizing costs nothing and keeps every split site uniform — do it for consistency rather than special-casing.

- [ ] **Step 1: Write the failing test**

Add to `test/unit.test.js`:

```js
test('grepLines strips trailing \\r from Windows line endings', () => {
  const content = 'foo bar\r\nmatch this\r\nbaz\r\n';
  const lines = g.grepLines(content, /^match this$/);
  assert.strictEqual(lines.length, 1);
  assert.strictEqual(lines[0], 'match this');
});
```

Also add, exercising `envBlock`-style masking logic indirectly is harder without filesystem setup, so instead add a second focused test for the ignore-matcher path, which is easy to unit test standalone:

```js
test('compileIgnorePatterns handles CRLF-joined pattern lines', () => {
  const matchers = g.compileIgnorePatterns('node_modules\r\ndist\r\n'.split(/\r?\n/));
  const matchFn = (rel) => matchers.some((re) => re.test(rel));
  assert.strictEqual(matchFn('dist'), true);
  assert.strictEqual(matchFn('dist/x.js'), true);
});
```

(This second test passes even before the fix since it constructs the split itself — it documents the expected post-fix pattern. The `grepLines` test above is the one that actually fails pre-fix.)

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/unit.test.js`
Expected: The `grepLines strips trailing \r` test FAILS — `lines[0]` is `'match this\r'`, not `'match this'` (the regex `/^match this$/` doesn't match a line with a trailing `\r` before end-of-string, so `lines.length` is `0`, causing an assertion error on `lines[0]`).

- [ ] **Step 3: Implement the fix**

Apply `.split('\n')` → `.split(/\r?\n/)` at every line listed above. Use a single project-wide check after editing to confirm none were missed:

```bash
grep -n "\.split('\\\\n')" generate_project_context.js
```

Expected after the fix: zero matches remain (every split site now uses `/\r?\n/`), while `.join('\n')` calls remain untouched (grep for `\.join('\\\\n')` should show the same count as before your edit — output-side joins are intentionally still `\n`).

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/unit.test.js`
Expected: PASS — both new tests, plus the full existing suite (`node --test test/`) still green.

- [ ] **Step 5: Commit**

```bash
git add generate_project_context.js test/unit.test.js
git commit -m "fix: normalize line splitting to handle CRLF on Windows"
```

---

### Task 3: Bounds-checked CLI argument value extraction in `parseArgs`

**Files:**
- Modify: `generate_project_context.js:29-42` (`parseArgs`)
- Test: `test/unit.test.js`

**Interfaces:**
- Consumes: nothing new.
- Produces: `parseArgs(argv)` throws `Error` with a clear message when a value-taking flag (`--ai`, `--context-dir`, `--depth`, `--dir`) is the last element of `argv` with no following value, instead of silently assigning `undefined`. `--debug-detection` (a boolean flag, no value) is unaffected. Existing `main()` catch-and-exit(1) behavior around `parseArgs` (`generate_project_context.js:1394-1396`) already handles thrown errors correctly, so no caller changes needed.

- [ ] **Step 1: Write the failing test**

Add to `test/unit.test.js`:

```js
test('parseArgs throws when a value flag is missing its value', () => {
  assert.throws(() => g.parseArgs(['--ai']), /--ai requires a value/);
});

test('parseArgs throws when --context-dir is last with no value', () => {
  assert.throws(() => g.parseArgs(['--depth', '3', '--context-dir']), /--context-dir requires a value/);
});

test('parseArgs still accepts --debug-detection as the last, valueless flag', () => {
  const a = g.parseArgs(['--ai', 'gemini', '--debug-detection']);
  assert.strictEqual(a.debugDetection, true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/unit.test.js`
Expected: FAIL — `g.parseArgs(['--ai'])` currently returns `{ ...args, aiCli: undefined }` instead of throwing.

- [ ] **Step 3: Implement the fix**

Replace the body of `parseArgs` in `generate_project_context.js`:

```js
function parseArgs(argv) {
  const args = { aiCli: 'claude', contextDir: '.context', treeDepth: 3, debugDetection: false, dir: '.' };
  const nextValue = (i, flag) => {
    if (i + 1 >= argv.length) throw new Error(`${flag} requires a value`);
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--ai': args.aiCli = nextValue(i, '--ai'); i++; break;
      case '--context-dir': args.contextDir = nextValue(i, '--context-dir'); i++; break;
      case '--depth': {
        const v = nextValue(i, '--depth'); i++;
        args.treeDepth = parseInt(v, 10);
        if (Number.isNaN(args.treeDepth)) args.treeDepth = 3;
        break;
      }
      case '--debug-detection': args.debugDetection = true; break;
      case '--dir': args.dir = nextValue(i, '--dir'); i++; break;
      default: throw new Error(`Unknown option: ${argv[i]}`);
    }
  }
  return args;
}
```

Note: this replaces the old `argv[++i]` pattern (which both reads and advances `i` inside the assignment) with `nextValue(i, flag)` (a pure bounds-checked read) followed by an explicit `i++` — that split is required so the bounds check can run and throw *before* `i` is mutated.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/unit.test.js`
Expected: PASS — all three new tests, plus pre-existing `parseArgs` tests (defaults, flags, unknown flag, `--depth` non-numeric fallback, `--dir`) still pass unchanged.

- [ ] **Step 5: Commit**

```bash
git add generate_project_context.js test/unit.test.js
git commit -m "fix: bounds-check CLI flag values in parseArgs instead of assigning undefined"
```

---

### Task 4: ARG_MAX-safe prompt delivery in `callAi` (stdin, with temp-file fallback)

**Files:**
- Modify: `generate_project_context.js:617-630` (`callAi`)
- Test: `test/unit.test.js`

**Interfaces:**
- Consumes: nothing new.
- Produces: `callAi(aiCli, prompt)` keeps its exact signature and return type (`string`, `''` on failure). Behavior change: prompts whose UTF-8 byte length exceeds 8192 (8KB) are now passed via the child's `stdin` instead of as an argv element, with the CLI invoked as `spawnSync(aiCli, ['-p', '-'], { input: prompt, ... })` when the CLI supports reading the prompt from stdin via a `-` sentinel is *not* a safe universal assumption — instead, keep passing `-p` as a flag but write the prompt to a temp file and pass the *file path* if the prompt is oversized, since we cannot know whether an arbitrary `aiCli` supports `-p -` for stdin. See Step 3 for the exact mechanism chosen (temp-file fallback, not a stdin-flag assumption) and why.

- [ ] **Step 1: Write the failing test**

Add to `test/unit.test.js`:

```js
test('callAi routes prompts over 8KB through a temp file, not argv', () => {
  const spawnSyncMod = require('node:child_process');
  const realSpawnSync = spawnSyncMod.spawnSync;
  let capturedArgs = null;
  spawnSyncMod.spawnSync = (cmd, args, opts) => {
    capturedArgs = args;
    return { stdout: 'ok', status: 0, error: null };
  };
  try {
    const bigPrompt = 'x'.repeat(9000);
    g.callAi('fake-cli', bigPrompt);
    // The oversized prompt must not appear verbatim as an argv element.
    assert.ok(!capturedArgs.includes(bigPrompt), 'oversized prompt leaked into argv');
  } finally {
    spawnSyncMod.spawnSync = realSpawnSync;
  }
});

test('callAi still passes short prompts directly as an argv element', () => {
  const spawnSyncMod = require('node:child_process');
  const realSpawnSync = spawnSyncMod.spawnSync;
  let capturedArgs = null;
  spawnSyncMod.spawnSync = (cmd, args, opts) => {
    capturedArgs = args;
    return { stdout: 'ok', status: 0, error: null };
  };
  try {
    g.callAi('fake-cli', 'short prompt');
    assert.ok(capturedArgs.includes('short prompt'));
  } finally {
    spawnSyncMod.spawnSync = realSpawnSync;
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/unit.test.js`
Expected: The first test FAILS — `capturedArgs` currently is `['-p', bigPrompt]`, so `capturedArgs.includes(bigPrompt)` is `true`, failing the `!...` assertion.

- [ ] **Step 3: Implement the fix**

Replace `callAi` in `generate_project_context.js`. The mechanism: for prompts over 8KB, write the prompt to a temp file under `os.tmpdir()` and pass `@<path>`-style is CLI-specific and not safe to assume, so instead follow the pattern already used for large content elsewhere in this file (temp file + read-back is not applicable here since we're calling *out*) — the safest universal mechanism available to an arbitrary CLI without assuming flag support is **stdin**, since `-p` in the `claude` CLI (this repo's own default `aiCli`) already accepts the prompt as a positional argument OR reads from stdin when no positional is given. Use stdin for the oversized case:

```js
function callAi(aiCli, prompt) {
  const PROMPT_ARG_LIMIT = 8 * 1024; // 8KB — stay well under OS ARG_MAX/Win32 command-line limits
  try {
    const isOversized = Buffer.byteLength(prompt, 'utf8') > PROMPT_ARG_LIMIT;
    const r = isOversized
      ? spawnSync(aiCli, ['-p'], { input: prompt, encoding: 'utf8', timeout: 120000 })
      : spawnSync(aiCli, ['-p', prompt], { encoding: 'utf8', timeout: 120000 });
    const out = (r.stdout || '').trim();
    if (r.error || r.status !== 0 || !out) {
      log.warn(`${aiCli} returned empty for: ${prompt.slice(0, 60)}...`);
      return '';
    }
    return stripModelPreamble(out);
  } catch (e) {
    log.warn(`${aiCli} failed: ${e.message}`);
    return '';
  }
}
```

This drops the prompt as a positional argv element entirely once oversized and relies on stdin (`-p` with no following positional, prompt piped via `input`) — matching how `claude -p` (this repo's default `aiCli`) already behaves when no prompt argument is given: it reads stdin. This avoids the ARG_MAX ceiling unconditionally for large prompts without guessing at a `-p -` sentinel that not every CLI supports.

If, during implementation, you find `claude -p` (or the user's configured `--ai` CLI) does *not* read from stdin when invoked as `-p` with no positional, fall back to the temp-file variant instead — write `prompt` to `path.join(os.tmpdir(), `ctxgen-prompt-${process.pid}-${Date.now()}.txt`)`, pass its path as the sole argument after `-p`, and delete it in a `finally` block after the call. Prefer the stdin approach first since it needs no cleanup and matches this repo's actual CLI's behavior; only add the temp-file path if manual verification (`echo | claude -p` with a large piped prompt) shows stdin doesn't work.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/unit.test.js`
Expected: PASS — both new tests, plus every existing test that calls `callAi` (via mocked `spawnSync` in `test/generator.test.js`) still passes. Run the full suite to confirm: `node --test test/`.

- [ ] **Step 5: Manually verify against the real `claude` CLI (not just the mock)**

Run:
```bash
node -e "
const g = require('./generate_project_context.js');
const big = 'Summarize this: ' + 'lorem ipsum '.repeat(1000);
console.log('prompt bytes:', Buffer.byteLength(big));
console.log(g.callAi('claude', big).slice(0, 200));
"
```
Expected: non-empty output, confirming the stdin path round-trips correctly through the real CLI. If it returns empty, switch to the temp-file fallback described in Step 3 and re-run this check.

- [ ] **Step 6: Commit**

```bash
git add generate_project_context.js test/unit.test.js
git commit -m "fix: route oversized AI prompts through stdin to avoid ARG_MAX limits"
```

---

### Task 5: Async `callAiAsync` alternative

**Files:**
- Modify: `generate_project_context.js` (add near `callAi`, after Task 4's edit, around line 630)
- Test: `test/unit.test.js`

**Interfaces:**
- Consumes: `stripModelPreamble(text)` (existing, `generate_project_context.js:603`), `log.warn` (existing).
- Produces: `callAiAsync(aiCli, prompt): Promise<string>` — same contract as `callAi` (resolves to `''` on any failure, resolves to the trimmed+preamble-stripped stdout on success, never rejects). Same 8KB stdin-routing behavior as `callAi`. This is what Task 6 calls concurrently via `Promise.all`.

- [ ] **Step 1: Write the failing test**

Add to `test/unit.test.js`:

```js
test('callAiAsync resolves with trimmed stdout on success', async () => {
  const cp = require('node:child_process');
  const realSpawn = cp.spawn;
  cp.spawn = (cmd, args, opts) => {
    const { EventEmitter } = require('node:events');
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { write() {}, end() {} };
    process.nextTick(() => {
      child.stdout.emit('data', Buffer.from('  hello from ai  '));
      child.emit('close', 0);
    });
    return child;
  };
  try {
    const result = await g.callAiAsync('fake-cli', 'a prompt');
    assert.strictEqual(result, 'hello from ai');
  } finally {
    cp.spawn = realSpawn;
  }
});

test('callAiAsync resolves to empty string on non-zero exit', async () => {
  const cp = require('node:child_process');
  const realSpawn = cp.spawn;
  cp.spawn = (cmd, args, opts) => {
    const { EventEmitter } = require('node:events');
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { write() {}, end() {} };
    process.nextTick(() => child.emit('close', 1));
    return child;
  };
  try {
    const result = await g.callAiAsync('fake-cli', 'a prompt');
    assert.strictEqual(result, '');
  } finally {
    cp.spawn = realSpawn;
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/unit.test.js`
Expected: FAIL — `g.callAiAsync` is not exported/defined yet (`TypeError: g.callAiAsync is not a function`).

- [ ] **Step 3: Implement `callAiAsync`**

Add directly after `callAi` in `generate_project_context.js`, and add `spawn` to the existing `require('node:child_process')` destructure at the top of the file:

```js
const { spawnSync, spawn } = require('node:child_process');
```

```js
function callAiAsync(aiCli, prompt) {
  const PROMPT_ARG_LIMIT = 8 * 1024;
  return new Promise((resolve) => {
    const isOversized = Buffer.byteLength(prompt, 'utf8') > PROMPT_ARG_LIMIT;
    let child;
    try {
      child = isOversized
        ? spawn(aiCli, ['-p'], { stdio: ['pipe', 'pipe', 'pipe'] })
        : spawn(aiCli, ['-p', prompt], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      log.warn(`${aiCli} failed: ${e.message}`);
      resolve('');
      return;
    }
    let stdout = '';
    let settled = false;
    const finish = (value) => { if (!settled) { settled = true; resolve(value); } };
    const timer = setTimeout(() => { child.kill(); finish(''); }, 120000);
    child.stdout.on('data', (d) => { stdout += d; });
    child.on('error', (e) => { clearTimeout(timer); log.warn(`${aiCli} failed: ${e.message}`); finish(''); });
    child.on('close', (code) => {
      clearTimeout(timer);
      const out = stdout.trim();
      if (code !== 0 || !out) {
        log.warn(`${aiCli} returned empty for: ${prompt.slice(0, 60)}...`);
        finish('');
        return;
      }
      finish(stripModelPreamble(out));
    });
    if (isOversized) {
      child.stdin.write(prompt);
      child.stdin.end();
    }
  });
}
```

Add `callAiAsync` to the `module.exports` object at the bottom of the file (append, don't reorder existing entries):

```js
  checkAiAvailable, callAi, callAiAsync, stripModelPreamble, collectAiContextFiles, collectReviewContext, makeAiSummarizer,
```

(This replaces the existing `checkAiAvailable, callAi, stripModelPreamble, ...` line — just inserting `callAiAsync` after `callAi`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/unit.test.js`
Expected: PASS — both new tests, and the full suite (`node --test test/`) stays green.

- [ ] **Step 5: Commit**

```bash
git add generate_project_context.js test/unit.test.js
git commit -m "feat: add callAiAsync for concurrent AI extraction calls"
```

---

### Task 6: Async `runGenerationCallAsync` + concurrent 03_data/04_interfaces stages

**Files:**
- Modify: `generate_project_context.js:686-714` (add `runGenerationCallAsync` next to `runGenerationCall`)
- Modify: `generate_project_context.js:1234-1341` (`buildStages01to04`) — make it `async`, convert the 03_data and 04_interfaces IIFEs to run their three AI calls via `Promise.all`
- Modify: `generate_project_context.js:1493` (`main()`) — `await buildStages01to04(ctx)` since it becomes async
- Test: `test/generator.test.js` (integration-level, since `buildStages01to04` composes many helpers — check existing mocking pattern there first with `grep -n "buildStages01to04\|runGenerationCall" test/generator.test.js`)

**Interfaces:**
- Consumes: `callAiAsync(aiCli, prompt): Promise<string>` (Task 5), `collectCategoryContent`, `computeCategoryHash`, `isCacheFresh` (all existing, unchanged).
- Produces: `runGenerationCallAsync(ctx, { paths, promptInstructions, existingContent, oldCacheEntry }): Promise<{ content, method, cacheEntry }>` — same return shape as the existing sync `runGenerationCall`. `buildStages01to04(ctx)` becomes `async function buildStages01to04(ctx)` returning the same array shape as before (each element still has `{ name, contract, outputs, extraction?, aiCache? }`), just resolved via `await` at the call site instead of returned synchronously. `runGenerationCall` (sync) stays exactly as-is and exported — no other call site uses `runGenerationCallAsync`.

- [ ] **Step 1: Check existing test coverage for `buildStages01to04` and `runGenerationCall`**

Run: `grep -n "buildStages01to04\|runGenerationCall" test/generator.test.js`

Read the matched tests fully before writing new ones — `buildStages01to04` is exercised through `main()`-level integration tests in `test/generator.test.js` (per the file's existing pattern of mocking `spawnSync` for `callAi`), not isolated unit calls. Task 6's new test must mock `spawn` (used by `callAiAsync`) the same way those tests mock `spawnSync`, and must assert that all three AI calls for a stage fire before any one of them resolves (proving concurrency) rather than asserting on output content alone.

- [ ] **Step 2: Write the failing test**

Add to `test/generator.test.js`, following the file's existing setup pattern (read the top of that file first to match its temp-dir/mock helper conventions — do not duplicate a second unrelated mocking scheme). The essential assertion, adapted into that file's idiom:

```js
test('03_data stage runs schema/entities/state AI calls concurrently, not sequentially', async () => {
  const cp = require('node:child_process');
  const realSpawn = cp.spawn;
  const starts = [];
  cp.spawn = (cmd, args, opts) => {
    const { EventEmitter } = require('node:events');
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { write() {}, end() {} };
    starts.push(Date.now());
    setTimeout(() => {
      child.stdout.emit('data', Buffer.from('#### `X`\n```\nfield\n```'));
      child.emit('close', 0);
    }, 50); // each call takes 50ms
    return child;
  };
  try {
    // Build a minimal ctx sufficient for buildStages01to04's 03_data branch —
    // mirror the ctx shape used by this file's other buildStages01to04-adjacent
    // tests (detection, appDir, root, ignoreFn, useAi: true, aiCli, codeShape,
    // aiCache: {}, existingOutputs: {}). Reuse this file's existing test-ctx
    // builder helper if one exists (grep for "function makeCtx" or similar
    // before writing a new one from scratch).
    const stages = await g.buildStages01to04(testCtx);
    const dataStage = stages.find((s) => s.name === '03_data');
    assert.ok(dataStage);
    // If the 3 calls (schema, entities, state) ran concurrently, all 3
    // spawn() calls happen within a few ms of each other, well under the
    // 50ms per-call delay. Sequential execution would space starts[i+1]
    // roughly 50ms after starts[i].
    const maxGap = Math.max(...starts.slice(1).map((t, i) => t - starts[i]));
    assert.ok(maxGap < 40, `expected concurrent starts, got gaps up to ${maxGap}ms`);
  } finally {
    cp.spawn = realSpawn;
  }
});
```

Note: the exact `testCtx` construction must match whatever fixture/helper `test/generator.test.js` already uses to exercise stage-building — read the file fully before finalizing this test's setup so it doesn't duplicate an incompatible mocking approach.

- [ ] **Step 3: Run test to verify it fails**

Run: `node --test test/generator.test.js`
Expected: FAIL — either `g.buildStages01to04` is not `async`/doesn't return a `Promise` yet (so `await` on it resolves immediately with the array-of-thunks-not-yet-called, or the calls run sequentially so `maxGap` is ~50ms, well over the 40ms threshold).

- [ ] **Step 4: Implement `runGenerationCallAsync`**

Add directly after `runGenerationCall` in `generate_project_context.js` (after line 714):

```js
async function runGenerationCallAsync(ctx, { paths, promptInstructions, existingContent, oldCacheEntry }) {
  if (!paths.length) {
    return { content: '', method: 'ai-no-relevant-files-found', cacheEntry: null };
  }
  const sourceHash = computeCategoryHash(ctx.root, paths);
  const now = new Date();
  if (existingContent && isCacheFresh(oldCacheEntry, sourceHash, now)) {
    return { content: existingContent || '', method: `ai-cached (last reviewed ${oldCacheEntry.last_reviewed_at.slice(0, 10)})`, cacheEntry: oldCacheEntry };
  }
  const fileContent = collectCategoryContent(ctx.root, paths);
  const existingBlock = existingContent
    ? `\n\nExisting output from a previous run — update it: keep what's still accurate (including anything a human added by hand), remove what's no longer true, add what's new. Do not rewrite from scratch unless the existing content is clearly stale or wrong.\n\n${existingContent}`
    : '';
  const prompt = `${promptInstructions}\n\nSource files:\n${fileContent}${existingBlock}\n\nOutput only the markdown content described above — no preamble, no trailing commentary.`;
  const result = await callAiAsync(ctx.aiCli, prompt);
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

This is a line-for-line async twin of `runGenerationCall` — same branching, same cache semantics — with only the `callAi` call swapped for `await callAiAsync`. Keep both functions; `runGenerationCall` (sync) stays for any future non-parallel use and to keep the diff minimal elsewhere.

- [ ] **Step 5: Convert `buildStages01to04` to async with concurrent 03_data/04_interfaces calls**

In `generate_project_context.js`, change the function signature at line 1234:

```js
function buildStages01to04(ctx) {
```
to:
```js
async function buildStages01to04(ctx) {
```

Convert the 03_data IIFE (lines 1257–1298) from a synchronous `(() => { ... })()` to an async IIFE that fires all three `runGenerationCallAsync` calls before awaiting any of them (so they run concurrently), by first building the three promises, then `Promise.all`-ing them:

```js
    await (async () => {
      const migrationsContent = migrationsBlock(ctx);
      const cache = (ctx.aiCache && ctx.aiCache['03_data']) || {};
      const existing = (file) => (ctx.existingOutputs && ctx.existingOutputs['03_data'] && ctx.existingOutputs['03_data'][file]) || null;

      const schemaPromise = runGenerationCallAsync(ctx, {
        paths: ctx.codeShape.dataModel,
        promptInstructions: `Produce the database/storage schema for this ${ctx.detection.primaryFramework} codebase as markdown: for each table or storage collection found in the source files below, describe its columns/fields, types, and constraints (primary keys, uniqueness, defaults, foreign keys).\n\nFor each table/collection found, use exactly this format (critical — other tooling parses this structure):\n\n#### \`TableName\`\n\`\`\`sql\n<column definitions, one per line>\n\`\`\`\n\nRepeat for every table/collection found. Do not add any other heading levels or wrap tables in additional sections.`,
        existingContent: existing('schema.md'),
        oldCacheEntry: cache['schema.md'],
      });
      const entitiesPromise = runGenerationCallAsync(ctx, {
        paths: ctx.codeShape.dataModel,
        promptInstructions: `Produce the code-level entity/model definitions for this ${ctx.detection.primaryFramework} codebase as markdown: for each entity/model class or type found in the source files below, list its declared fields/properties with their types.\n\nFor each entity/model found, use exactly this format (critical — other tooling parses this structure):\n\n#### \`EntityName\`\n\`\`\`${ctx.detection.primaryExt}\n<field/property declarations, one per line>\n\`\`\`\n\nRepeat for every entity/model found. Do not add any other heading levels or wrap entities in additional sections.`,
        existingContent: existing('entities.md'),
        oldCacheEntry: cache['entities.md'],
      });
      const statePromise = runGenerationCallAsync(ctx, {
        paths: ctx.codeShape.state,
        promptInstructions: `Produce the client-side state/store shape for this ${ctx.detection.primaryFramework} codebase as markdown: for each store/state container found in the source files below, list its shape (fields and their types).\n\nFor each store found, use exactly this format (critical — other tooling parses this structure):\n\n#### \`StoreName\`\n\`\`\`${ctx.detection.primaryExt}\n<field declarations, one per line>\n\`\`\`\n\nRepeat for every store found. Do not add any other heading levels or wrap stores in additional sections.`,
        existingContent: existing('state.md'),
        oldCacheEntry: cache['state.md'],
      });

      const [schemaGen, entitiesGen, stateGen] = await Promise.all([schemaPromise, entitiesPromise, statePromise]);

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

Critical detail: `schemaPromise`, `entitiesPromise`, `statePromise` must be created (the `runGenerationCallAsync(...)` calls invoked) **before** any `await` — that's what makes all three `spawn()` calls fire back-to-back rather than one-at-a-time. Only the destructuring `await Promise.all([...])` line actually waits.

Apply the identical transformation to the 04_interfaces IIFE (lines 1299–1339): build `routesPromise`, `controllersPromise`, `servicesPromise` from `runGenerationCallAsync` calls first, then `const [routesGen, controllersGen, servicesGen] = await Promise.all([routesPromise, controllersPromise, servicesPromise]);`, keeping the rest of that block (the `return { name: '04_interfaces', ... }` object) identical to what's already there.

Since `buildStages01to04` is now `async` and its body is an array literal built with two `await (async () => {...})()` entries plus the two synchronous stage objects (01_overview, 02_architecture) unchanged, the array itself must be assembled with `await`s resolved inline — the array literal's `(() => {...})()` entries change to `await (async () => {...})()`, which is valid inside an `async function` and does not require restructuring the surrounding `return [ ... ]` into a `Promise.all` at the outer level (each element resolves in place before the array literal is fully evaluated, since `await` blocks evaluation of that line).

- [ ] **Step 6: Update `main()` to await `buildStages01to04`**

At `generate_project_context.js:1493`, change:

```js
  for (const stage of buildStages01to04(ctx)) {
```
to:
```js
  for (const stage of await buildStages01to04(ctx)) {
```

- [ ] **Step 7: Export `runGenerationCallAsync`**

Add `runGenerationCallAsync` to `module.exports`, next to `runGenerationCall`:

```js
  collectCategoryContent, computeCategoryHash, isCacheFresh, AI_REVIEW_STALENESS_DAYS, runGenerationCall, runGenerationCallAsync, discoverCodeShape,
```

- [ ] **Step 8: Run test to verify it passes**

Run: `node --test test/generator.test.js`
Expected: PASS — the concurrency test from Step 2, plus every pre-existing test in this file (schema/entities/state/routes/controllers/services generation, caching, domain-note injection, hard-failure paths) still passes since `runGenerationCall` (sync) is untouched and 03_data/04_interfaces produce byte-identical output shapes, just via the async path now.

- [ ] **Step 9: Run the full suite**

Run: `node --test test/`
Expected: PASS — `test/unit.test.js`, `test/generator.test.js`, `test/detection.test.js` all green.

- [ ] **Step 10: Commit**

```bash
git add generate_project_context.js test/generator.test.js
git commit -m "perf: run 03_data and 04_interfaces AI extraction calls concurrently"
```

---

### Task 7: Final full-suite verification and manual smoke test

**Files:** none (verification only)

- [ ] **Step 1: Run the complete test suite**

Run: `node --test test/`
Expected: All tests pass, zero failures.

- [ ] **Step 2: Manual end-to-end smoke test against a real small project**

Run the generator against this repo itself (or another small local project) end-to-end with a real AI CLI, to confirm the async 03_data/04_interfaces path produces valid output on disk, not just mock-passed tests:

```bash
node generate_project_context.js --dir . --context-dir /tmp/ctxgen-smoke-test
```

Expected: completes without throwing, `/tmp/ctxgen-smoke-test/stages/03_data/output/` and `.../04_interfaces/output/` contain non-empty `schema.md`/`entities.md`/`state.md`/`routes.md`/`controllers.md`/`services.md` (as applicable to this repo's stack), and total wall-clock time for those two stages is visibly shorter than before (compare against `git stash` + a pre-change run if a precise before/after number matters).

- [ ] **Step 3: Clean up the smoke-test output**

```bash
rm -rf /tmp/ctxgen-smoke-test
```

- [ ] **Step 4: Report completion**

No commit needed for this task — it's verification-only. Summarize to the user: all 6 implementation tasks done, full suite green, manual smoke test confirms the async path produces valid output.
