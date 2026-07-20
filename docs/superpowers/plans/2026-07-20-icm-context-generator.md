# ICM Context Generator (Node.js rewrite) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `generate_project_context.sh` with a single-file Node.js generator that writes an ICM `.context/` folder structure (numbered stages, CONTEXT.md contracts, ledger-gated markdown parsing) per the approved spec.

**Architecture:** One CommonJS file `generate_project_context.js` exporting pure functions (detection, ignore engine, extractors, digesters, stage writers) with a `main()` guarded by `require.main === module`. Stage 05's per-markdown work is gated by a sha256 ledger in `.context/_config/manifest.json`, written only after a fully successful run. Tests are `node --test` unit + integration tests running the script against fixture projects copied to a temp dir.

**Tech Stack:** Node.js >= 18, `node:` built-ins only (`fs`, `path`, `crypto`, `child_process`, `os`, `readline`). No npm dependencies, no package.json.

**Spec:** `docs/superpowers/specs/2026-07-20-icm-context-generator-design.md` — the implementer MUST read it first. The old bash script `generate_project_context.sh` is the porting reference (line refs below).

## Global Constraints

- Single file deliverable: `generate_project_context.js` (plus tests + fixtures). Zero npm dependencies; only `node:` built-ins. No `package.json` in repo root.
- Node >= 18 required; enforce at startup: exit with error if `parseInt(process.versions.node) < 18`.
- CLI flags exactly: `--no-ai`, `--ai <claude|gemini>`, `--context-dir <dir>` (default `.context`), `--depth <n>` (default 3), `--debug-detection`. Unknown flag → print `Unknown option: <flag>` and exit 1.
- `.context/_config/ignore` is seeded once and NEVER overwritten if it exists.
- `manifest.json` is written LAST, only after all stages succeed.
- Never modify the host project's CLAUDE.md/AGENTS.md.
- All tests run with `--no-ai` semantics except the fake-AI test in Task 7.
- Commit after every task with the message given in the task's final step. End every commit message with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Run tests from repo root as: `node --test test/` (expected to pass at the end of every task).

## File Structure

- `generate_project_context.js` — the generator (create in Task 1, grow through Task 8). Internal section order: helpers → ignore engine → detection → extractors → markdown digest/ledger → AI → stage writers → main.
- `test/helpers.js` — shared test utilities (temp-dir fixture runner).
- `test/unit.test.js` — unit tests for helpers/ignore/digest/slug.
- `test/detection.test.js` — stack detection tests.
- `test/generator.test.js` — integration tests (full runs, incremental ledger behavior).
- `test/fixtures/expo-app/` — Node/Expo-like fixture.
- `test/fixtures/laravel-app/` — Laravel-like fixture.
- `README.md` — rewritten in Task 8.
- `generate_project_context.sh` — DELETED in Task 8.

---

### Task 1: Script skeleton, CLI parsing, core helpers

**Files:**
- Create: `generate_project_context.js`
- Create: `test/unit.test.js`

**Interfaces:**
- Produces (exported via `module.exports`): `parseArgs(argv) -> {useAi, aiCli, contextDir, treeDepth, debugDetection}`; `readText(p) -> string|null`; `readJson(p) -> object|null`; `grepLines(content, regex, limit) -> string[]`; `extractBlocks(content, startRegex, {maxLines}) -> string` (brace-balanced block extractor used by TS/Go/SQL scanners); `sha256(str) -> hex string`; `log.info/success/warn` (stderr, ANSI colored).

- [ ] **Step 1: Write the failing tests**

```js
// test/unit.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const g = require('../generate_project_context.js');

test('parseArgs defaults', () => {
  const a = g.parseArgs([]);
  assert.deepStrictEqual(a, { useAi: true, aiCli: 'claude', contextDir: '.context', treeDepth: 3, debugDetection: false });
});

test('parseArgs flags', () => {
  const a = g.parseArgs(['--no-ai', '--ai', 'gemini', '--context-dir', 'ctx', '--depth', '5', '--debug-detection']);
  assert.deepStrictEqual(a, { useAi: false, aiCli: 'gemini', contextDir: 'ctx', treeDepth: 5, debugDetection: true });
});

test('parseArgs unknown flag throws', () => {
  assert.throws(() => g.parseArgs(['--bogus']), /Unknown option: --bogus/);
});

test('grepLines returns matching lines up to limit', () => {
  const out = g.grepLines('a1\nb2\na3\na4', /^a/, 2);
  assert.deepStrictEqual(out, ['a1', 'a3']);
});

test('extractBlocks pulls brace-balanced blocks', () => {
  const src = 'export interface Foo {\n  a: string;\n  b: { c: number };\n}\nconst x = 1;\nexport interface Bar {\n  d: boolean;\n}\n';
  const out = g.extractBlocks(src, /^export interface /);
  assert.match(out, /interface Foo/);
  assert.match(out, /c: number/);
  assert.match(out, /interface Bar/);
  assert.ok(!out.includes('const x'));
});

test('sha256 is stable hex', () => {
  assert.strictEqual(g.sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/`
Expected: FAIL — `Cannot find module '../generate_project_context.js'`

- [ ] **Step 3: Write the skeleton implementation**

```js
#!/usr/bin/env node
'use strict';
// generate_project_context.js — generates an ICM .context/ structure for any project.
// Spec: docs/superpowers/specs/2026-07-20-icm-context-generator-design.md
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const GENERATOR_VERSION = '2.0.0';

// ── Logging ──────────────────────────────────────────────────────────────────
const log = {
  info:    (m) => process.stderr.write(`\x1b[0;34m▸ ${m}\x1b[0m\n`),
  success: (m) => process.stderr.write(`\x1b[0;32m✓ ${m}\x1b[0m\n`),
  warn:    (m) => process.stderr.write(`\x1b[1;33m⚠ ${m}\x1b[0m\n`),
};

// ── CLI ──────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = { useAi: true, aiCli: 'claude', contextDir: '.context', treeDepth: 3, debugDetection: false };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--no-ai': args.useAi = false; break;
      case '--ai': args.aiCli = argv[++i]; break;
      case '--context-dir': args.contextDir = argv[++i]; break;
      case '--depth': args.treeDepth = parseInt(argv[++i], 10); break;
      case '--debug-detection': args.debugDetection = true; break;
      default: throw new Error(`Unknown option: ${argv[i]}`);
    }
  }
  return args;
}

// ── Small helpers ────────────────────────────────────────────────────────────
function readText(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } }
function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }
function sha256(str) { return crypto.createHash('sha256').update(str).digest('hex'); }
function exists(p) { try { fs.accessSync(p); return true; } catch { return false; } }
function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }

function grepLines(content, regex, limit = Infinity) {
  const out = [];
  for (const line of content.split('\n')) {
    if (regex.test(line)) { out.push(line); if (out.length >= limit) break; }
  }
  return out;
}

// Brace-balanced block extractor: from each line matching startRegex, capture
// until braces close (or the line ends in ';' before any '{' opens).
function extractBlocks(content, startRegex, { maxLines = 120 } = {}) {
  const lines = content.split('\n');
  const out = [];
  let inBlock = false, depth = 0, buf = [];
  for (const line of lines) {
    if (!inBlock && startRegex.test(line)) { inBlock = true; depth = 0; buf = []; }
    if (!inBlock) continue;
    buf.push(line);
    for (const c of line) {
      if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) { out.push(buf.join('\n')); inBlock = false; } }
    }
    if (inBlock && depth === 0 && line.includes(';') && !line.includes('{')) { out.push(buf.join('\n')); inBlock = false; }
  }
  return out.join('\n\n').split('\n').slice(0, maxLines).join('\n');
}

function main() {
  if (parseInt(process.versions.node, 10) < 18) { log.warn('Node >= 18 required.'); process.exit(1); }
  let args;
  try { args = parseArgs(process.argv.slice(2)); }
  catch (e) { console.error(e.message); process.exit(1); }
  log.info(`ICM context generator v${GENERATOR_VERSION} (wiring lands in later tasks)`);
  void args;
}

module.exports = { parseArgs, readText, readJson, sha256, exists, isDir, grepLines, extractBlocks, log, GENERATOR_VERSION };
if (require.main === module) main();
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add generate_project_context.js test/unit.test.js
git commit -m "feat: add generator skeleton with CLI parsing and core helpers"
```

---

### Task 2: Ignore engine and repo walker

**Files:**
- Modify: `generate_project_context.js` (append after helpers)
- Modify: `test/unit.test.js` (append tests)

**Interfaces:**
- Consumes: `readText` from Task 1.
- Produces: `DEFAULT_IGNORES` (string[]); `compileIgnorePatterns(lines) -> matcher[]`; `createIgnoreMatcher({root, contextDir}) -> (relPath) => boolean` (merges defaults + `.gitignore` + `<contextDir>/_config/ignore`; `relPath` uses `/` separators); `walkFiles(root, ignoreFn, {extensions}) -> string[]` (sorted relative paths, skipping ignored dirs early).

- [ ] **Step 1: Write the failing tests** (append to `test/unit.test.js`)

```js
const fsx = require('node:fs');
const pathx = require('node:path');
const osx = require('node:os');

test('ignore matcher: defaults, gitignore, custom file', () => {
  const tmp = fsx.mkdtempSync(pathx.join(osx.tmpdir(), 'icm-ign-'));
  fsx.writeFileSync(pathx.join(tmp, '.gitignore'), '*.log\n/secret\n!keep.log\n# comment\n');
  fsx.mkdirSync(pathx.join(tmp, '.context/_config'), { recursive: true });
  fsx.writeFileSync(pathx.join(tmp, '.context/_config/ignore'), 'legacy-docs/\n');
  const ignored = g.createIgnoreMatcher({ root: tmp, contextDir: '.context' });
  assert.ok(ignored('node_modules/pkg/README.md'), 'default dir ignored at any depth');
  assert.ok(ignored('deep/node_modules/x.md'));
  assert.ok(ignored('app.log'), 'gitignore glob');
  assert.ok(ignored('secret/notes.md'), 'root-anchored gitignore path');
  assert.ok(ignored('legacy-docs/old.md'), 'custom ignore file');
  assert.ok(ignored('.context/CONTEXT.md'), 'context dir always self-excluded');
  assert.ok(!ignored('docs/readme.md'));
  assert.ok(!ignored('src/index.ts'));
});

test('walkFiles finds md files, skips ignored dirs, sorted', () => {
  const tmp = fsx.mkdtempSync(pathx.join(osx.tmpdir(), 'icm-walk-'));
  fsx.mkdirSync(pathx.join(tmp, 'docs'), { recursive: true });
  fsx.mkdirSync(pathx.join(tmp, 'node_modules/pkg'), { recursive: true });
  fsx.writeFileSync(pathx.join(tmp, 'README.md'), '# hi');
  fsx.writeFileSync(pathx.join(tmp, 'docs/b.md'), '# b');
  fsx.writeFileSync(pathx.join(tmp, 'node_modules/pkg/x.md'), '# no');
  const ignored = g.createIgnoreMatcher({ root: tmp, contextDir: '.context' });
  const files = g.walkFiles(tmp, ignored, { extensions: ['.md'] });
  assert.deepStrictEqual(files, ['README.md', 'docs/b.md']);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/`
Expected: FAIL — `g.createIgnoreMatcher is not a function`

- [ ] **Step 3: Implement** (append to `generate_project_context.js`, add names to `module.exports`)

```js
// ── Ignore engine ────────────────────────────────────────────────────────────
// Supported syntax (v1): comments (#), blank lines, trailing-/ dir patterns,
// leading-/ root anchors, * and ? globs, ** deep globs. Negation (!) is
// unsupported and skipped (documented in README).
const DEFAULT_IGNORES = [
  'node_modules', 'vendor', '.git', 'dist', 'build', 'out', 'coverage',
  '.next', '.nuxt', 'target', '__pycache__', '.venv', 'venv', 'tmp',
  '.cache', 'Pods', 'DerivedData', 'var',
];

function patternToRegex(pat) {
  const esc = pat.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, ' ').replace(/\*/g, '[^/]*').replace(/ /g, '.*').replace(/\?/g, '[^/]');
  return esc;
}

function compileIgnorePatterns(lines) {
  const matchers = [];
  for (let raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('!')) continue;
    let pat = line.replace(/\/+$/, '');
    const anchored = pat.startsWith('/');
    if (anchored) pat = pat.slice(1);
    const body = patternToRegex(pat);
    // Anchored or containing '/': match from root. Bare names: match any path segment.
    const re = (anchored || pat.includes('/'))
      ? new RegExp(`^${body}(/|$)`)
      : new RegExp(`(^|/)${body}(/|$)`);
    matchers.push(re);
  }
  return matchers;
}

function createIgnoreMatcher({ root, contextDir }) {
  const lines = [...DEFAULT_IGNORES];
  const gitignore = readText(path.join(root, '.gitignore'));
  if (gitignore) lines.push(...gitignore.split('\n'));
  const custom = readText(path.join(root, contextDir, '_config', 'ignore'));
  if (custom) lines.push(...custom.split('\n'));
  lines.push('/' + contextDir.replace(/\/+$/, ''));
  const matchers = compileIgnorePatterns(lines);
  return (relPath) => matchers.some((re) => re.test(relPath));
}

function walkFiles(root, ignoreFn, { extensions = null } = {}) {
  const out = [];
  (function recur(rel) {
    const abs = rel ? path.join(root, rel) : root;
    let entries;
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (ignoreFn(childRel)) continue;
      if (e.isDirectory()) recur(childRel);
      else if (e.isFile() && (!extensions || extensions.includes(path.extname(e.name).toLowerCase()))) out.push(childRel);
    }
  })('');
  return out.sort();
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add generate_project_context.js test/unit.test.js
git commit -m "feat: add layered ignore engine and repo walker"
```

---

### Task 3: Fixtures + stack/dev-env/database/version detection

**Files:**
- Create: `test/fixtures/expo-app/*` and `test/fixtures/laravel-app/*` (contents below)
- Create: `test/helpers.js`
- Create: `test/detection.test.js`
- Modify: `generate_project_context.js`

**Interfaces:**
- Produces: `detectStack(root, dir='.') -> detection` where detection = `{ stacks: {php,symfony,laravel,node,next,express,python,django,fastapi,flask,go,rust,ruby,rails}, primaryLang, primaryFramework, primaryExt, sourceDir, modelsDir, controllersDir, servicesDir }` (all dirs are paths relative to `root`, or `''`); `detectDevEnv(root, detection) -> {devEnv, landoRecipe, landoPhp, landoDb, runPrefix, consoleCmd}`; `detectDatabases(root, appDir) -> string` (e.g. `"MySQL Redis"`); `extractVersions(root, appDir, detection) -> {frameworkVersion, phpVersion, nodeVersion}`; `test/helpers.js` exports `copyFixture(name) -> tmpDir` and `runGenerator(cwd, args) -> {status, stdout, stderr}`.
- Port reference: bash lines 86–260.

- [ ] **Step 1: Create fixture files**

`test/fixtures/expo-app/`:

```
package.json:
{ "name": "expo-fixture", "engines": { "node": ">=18" },
  "dependencies": { "expo": "~51.0.0", "expo-sqlite": "~14.0.0", "zustand": "^4.5.0" },
  "devDependencies": { "typescript": "^5.4.0" } }

src/db/schema.sql:
CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL
);
CREATE TABLE tasks (
  id INTEGER PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  title TEXT
);

src/types/models.ts:
export interface User {
  id: number;
  name: string;
}
export type TaskStatus = 'open' | 'done';
export interface Task {
  id: number;
  userId: number;
  status: TaskStatus;
}

src/stores/useTaskStore.ts:
import { create } from 'zustand';
export interface TaskStore {
  tasks: string[];
  addTask: (t: string) => void;
}
export const useTaskStore = create<TaskStore>((set) => ({ tasks: [], addTask: () => {} }));

README.md:
# Expo Fixture
## Setup
Install things.
## Usage
Run things.

docs/architecture.md:
# Architecture
## Data flow
Stores wrap SQLite.

node_modules/some-pkg/README.md:
# Vendored readme that must never be indexed

.env:
API_URL=https://example.com
SECRET_KEY=supersecret
```

`test/fixtures/laravel-app/`:

```
composer.json:
{ "name": "fixture/laravel-app",
  "require": { "php": "^8.2", "laravel/framework": "^11.0" } }

app/Models/User.php:
<?php
class User extends Model {
    protected $fillable = ['name', 'email'];
    protected $casts = ['email_verified_at' => 'datetime'];
    public function tasks() { return $this->hasMany(Task::class); }
}

app/Http/Controllers/UserController.php:
<?php
class UserController extends Controller {
    public function index() {}
    public function store(Request $request) {}
}

database/migrations/2024_01_01_000000_create_users_table.php:
<?php
return new class extends Migration {
    public function up(): void {
        Schema::create('users', function (Blueprint $table) {
            $table->string('name');
            $table->string('email');
            $table->timestamps();
        });
    }
};

README.md:
# Laravel Fixture
## About
A fixture.
```

- [ ] **Step 2: Write `test/helpers.js`**

```js
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', 'generate_project_context.js');

function copyFixture(name) {
  const src = path.join(__dirname, 'fixtures', name);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `icm-${name}-`));
  fs.cpSync(src, tmp, { recursive: true });
  return tmp;
}

function runGenerator(cwd, args = []) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf8', timeout: 60000 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

module.exports = { copyFixture, runGenerator, SCRIPT };
```

- [ ] **Step 3: Write the failing tests**

```js
// test/detection.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const g = require('../generate_project_context.js');
const { copyFixture } = require('./helpers.js');

test('detects expo/node stack', () => {
  const root = copyFixture('expo-app');
  const d = g.detectStack(root);
  assert.strictEqual(d.stacks.node, true);
  assert.strictEqual(d.primaryLang, 'node');
  assert.strictEqual(d.primaryExt, 'ts');
  assert.strictEqual(d.sourceDir, 'src');
});

test('detects laravel stack with dirs', () => {
  const root = copyFixture('laravel-app');
  const d = g.detectStack(root);
  assert.strictEqual(d.stacks.laravel, true);
  assert.strictEqual(d.primaryFramework, 'laravel');
  assert.strictEqual(d.modelsDir, 'app/Models');
  assert.strictEqual(d.controllersDir, 'app/Http/Controllers');
  const v = g.extractVersions(root, '.', d);
  assert.strictEqual(v.phpVersion, '8.2');
  assert.match(v.frameworkVersion, /11/);
});

test('detectDatabases finds sqlite hint in expo fixture', () => {
  const root = copyFixture('expo-app');
  assert.match(g.detectDatabases(root, '.'), /SQLite/);
});

test('unknown stack yields unknown lang', () => {
  const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'icm-empty-'));
  const d = g.detectStack(tmp);
  assert.strictEqual(d.primaryLang, 'unknown');
});
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `node --test test/`
Expected: FAIL — `g.detectStack is not a function`

- [ ] **Step 5: Implement detection** (append; port bash lines 86–260 faithfully — key differences: JSON via `readJson` instead of jq; all returned dirs relative to `root`; `dir` param supports the app-subdirectory case)

```js
// ── Stack detection (port of bash detect_stack, lines 99–170) ────────────────
function detectStack(root, dir = '.') {
  const d = {
    stacks: { php: false, symfony: false, laravel: false, node: false, next: false, express: false,
      python: false, django: false, fastapi: false, flask: false, go: false, rust: false, ruby: false, rails: false },
    primaryLang: 'unknown', primaryFramework: 'unknown', primaryExt: 'txt',
    sourceDir: 'src', modelsDir: '', controllersDir: '', servicesDir: '',
  };
  const p = (...seg) => path.join(root, ...seg);
  const rel = (...seg) => path.posix.join(...seg.filter((s) => s && s !== '.'));

  const composer = readJson(p(dir, 'composer.json'));
  if (composer) {
    d.stacks.php = true; d.primaryLang = 'php'; d.primaryExt = 'php';
    d.sourceDir = rel(dir, 'src'); d.servicesDir = rel(dir, 'src/Service');
    const req = composer.require || {};
    if (req['symfony/framework-bundle']) {
      d.stacks.symfony = true; d.primaryFramework = 'symfony';
      d.modelsDir = rel(dir, 'src/Entity'); d.controllersDir = rel(dir, 'src/Controller');
    } else if (req['laravel/framework']) {
      d.stacks.laravel = true; d.primaryFramework = 'laravel';
      d.modelsDir = rel(dir, 'app/Models'); d.controllersDir = rel(dir, 'app/Http/Controllers'); d.servicesDir = rel(dir, 'app/Services');
    } else { d.primaryFramework = 'php'; d.modelsDir = rel(dir, 'src'); d.controllersDir = rel(dir, 'src'); }
  }

  const pkg = readJson(p(dir, 'package.json'));
  if (pkg) {
    d.stacks.node = true;
    if (d.primaryLang === 'unknown') d.primaryLang = 'node';
    d.primaryExt = 'ts';
    d.sourceDir = isDir(p(dir, 'src')) ? rel(dir, 'src') : rel(dir, 'app');
    const deps = pkg.dependencies || {};
    if (deps.next) {
      d.stacks.next = true; d.primaryFramework = 'nextjs';
      d.modelsDir = rel(dir, 'app/models'); d.controllersDir = rel(dir, 'app/api'); d.servicesDir = rel(dir, 'app/services');
    } else if (deps.express) {
      d.stacks.express = true; d.primaryFramework = 'express';
      d.modelsDir = rel(dir, 'src/models'); d.controllersDir = rel(dir, 'src/controllers'); d.servicesDir = rel(dir, 'src/services');
    }
    if (d.primaryFramework === 'unknown') d.primaryFramework = 'node';
  }

  for (const pyfile of ['requirements.txt', 'pyproject.toml', 'setup.py']) {
    const content = readText(p(dir, pyfile));
    if (content === null) continue;
    d.stacks.python = true;
    if (d.primaryLang === 'unknown') d.primaryLang = 'python';
    d.primaryExt = 'py'; d.sourceDir = rel(dir) || '.';
    const lc = content.toLowerCase();
    if (lc.includes('django')) { d.stacks.django = true; d.primaryFramework = 'django'; }
    else if (lc.includes('fastapi')) {
      d.stacks.fastapi = true; d.primaryFramework = 'fastapi';
      d.modelsDir = rel(dir, 'app/models'); d.controllersDir = rel(dir, 'app/routers'); d.servicesDir = rel(dir, 'app/services');
    } else if (lc.includes('flask')) {
      d.stacks.flask = true; d.primaryFramework = 'flask';
      d.modelsDir = rel(dir, 'app/models'); d.controllersDir = rel(dir, 'app/routes'); d.servicesDir = rel(dir, 'app/services');
    }
    break;
  }

  if (exists(p(dir, 'go.mod'))) {
    d.stacks.go = true; d.primaryLang = 'go'; d.primaryFramework = 'go'; d.primaryExt = 'go';
    d.sourceDir = rel(dir) || '.';
    d.modelsDir = rel(dir, 'internal/model'); d.controllersDir = rel(dir, 'internal/handler'); d.servicesDir = rel(dir, 'internal/service');
  }
  if (exists(p(dir, 'Cargo.toml'))) {
    d.stacks.rust = true; d.primaryLang = 'rust'; d.primaryFramework = 'rust'; d.primaryExt = 'rs';
    d.sourceDir = rel(dir, 'src'); d.modelsDir = rel(dir, 'src/models'); d.controllersDir = rel(dir, 'src/handlers'); d.servicesDir = rel(dir, 'src/services');
  }
  const gemfile = readText(p(dir, 'Gemfile'));
  if (gemfile !== null) {
    d.stacks.ruby = true; d.primaryLang = 'ruby'; d.primaryExt = 'rb';
    if (gemfile.toLowerCase().includes('rails')) {
      d.stacks.rails = true; d.primaryFramework = 'rails';
      d.modelsDir = rel(dir, 'app/models'); d.controllersDir = rel(dir, 'app/controllers'); d.servicesDir = rel(dir, 'app/services');
    }
  }
  return d;
}

// ── Dev environment (port of bash lines 195–225) ─────────────────────────────
function detectDevEnv(root, detection) {
  const out = { devEnv: 'bare', landoRecipe: '', landoPhp: '', landoDb: '', runPrefix: '', consoleCmd: '' };
  const landoFile = ['.lando.base.yml', '.lando.yml'].find((f) => exists(path.join(root, f)));
  if (landoFile) {
    out.devEnv = 'lando';
    const y = readText(path.join(root, landoFile)) || '';
    const grab = (key) => (y.match(new RegExp(`^\\s*${key}:\\s*'?([^'\\n]+)'?`, 'm')) || [])[1] || '';
    out.landoRecipe = grab('recipe'); out.landoPhp = grab('php'); out.landoDb = grab('database');
    out.runPrefix = detection.primaryLang === 'php' ? 'lando php' : detection.primaryLang === 'node' ? 'lando node' : 'lando';
  } else if (['docker-compose.yml', 'compose.yaml', 'docker-compose.yaml'].some((f) => exists(path.join(root, f)))) {
    out.devEnv = 'docker'; out.runPrefix = 'docker compose exec app';
  } else if (exists(path.join(root, '.devcontainer/devcontainer.json'))) {
    out.devEnv = 'devcontainer';
  } else {
    const mk = readText(path.join(root, 'Makefile'));
    if (mk && /^(dev|up|start)/m.test(mk)) out.devEnv = 'make';
  }
  const pre = out.runPrefix ? out.runPrefix + ' ' : '';
  out.consoleCmd = { symfony: `${pre}bin/console`, laravel: `${pre}artisan`, django: `${pre}manage.py`, rails: `${pre}rails` }[detection.primaryFramework] || out.runPrefix;
  return out;
}

// ── Database hints (port of bash lines 227–239) ──────────────────────────────
function detectDatabases(root, appDir) {
  const hints = new Set();
  for (const f of ['composer.json', 'package.json', 'requirements.txt', 'pyproject.toml', '.env', '.lando.yml']) {
    const content = readText(path.join(root, appDir, f)) ?? readText(path.join(root, f));
    if (!content) continue;
    const lc = content.toLowerCase();
    if (lc.includes('mysql')) hints.add('MySQL');
    if (lc.includes('postgres')) hints.add('PostgreSQL');
    if (lc.includes('mongodb')) hints.add('MongoDB');
    if (lc.includes('sqlite')) hints.add('SQLite');
    if (lc.includes('redis')) hints.add('Redis');
  }
  return [...hints].sort().join(' ');
}

// ── Versions (port of bash lines 241–260) ────────────────────────────────────
function extractVersions(root, appDir, detection) {
  const clean = (s) => (s || '').replace(/[>=^~< ]/g, '');
  const out = { frameworkVersion: '', phpVersion: '', nodeVersion: '' };
  const composer = readJson(path.join(root, appDir, 'composer.json'));
  if (composer) {
    out.phpVersion = clean(composer.require?.php);
    if (detection.primaryFramework === 'symfony') out.frameworkVersion = clean(composer.require?.['symfony/framework-bundle']).replace(/[*.]+$/, '');
    if (detection.primaryFramework === 'laravel') out.frameworkVersion = clean(composer.require?.['laravel/framework']);
  }
  const pkg = readJson(path.join(root, appDir, 'package.json'));
  if (pkg) {
    out.nodeVersion = clean(pkg.engines?.node);
    if (detection.primaryFramework === 'nextjs') out.frameworkVersion = clean(pkg.dependencies?.next);
  }
  return out;
}
```

Add all four to `module.exports`.

- [ ] **Step 6: Run tests to verify they pass**

Run: `node --test test/`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add test/fixtures test/helpers.js test/detection.test.js generate_project_context.js
git commit -m "feat: add fixtures and stack/dev-env/db/version detection"
```

---

### Task 4: Extractors (schema, entities, state, routes, signatures, misc blocks)

**Files:**
- Modify: `generate_project_context.js`
- Modify: `test/detection.test.js` (append extractor tests)

**Interfaces:**
- Consumes: `grepLines`, `extractBlocks`, `walkFiles`, detection objects.
- Produces: a `ctx` convention — every extractor takes `ctx = { root, appDir, detection, devEnv, dbHints, versions, ignoreFn, treeDepth }` and returns a markdown string (or `''` when not applicable):
  `schemaBlock(ctx)`, `entitiesBlock(ctx)`, `stateBlock(ctx)`, `modelsBlock(ctx)`, `controllersBlock(ctx)`, `servicesBlock(ctx)`, `routesBlock(ctx)`, `migrationsBlock(ctx)`, `envBlock(ctx)`, `depsBlock(ctx)`, `metricsBlock(ctx)`, `treeBlock(ctx)`, `gitActivityBlock(ctx)`, `findOpenApiFile(ctx) -> relPath|''`, plus `sectionLabels(detection, dbHints) -> {schema, entities, state}`.
- Port reference: bash lines 289–309 (metrics), 440–471 (deps/routes), 493–844 (scanners), 846–910 (helper blocks/labels), 1005–1011 (tree).

- [ ] **Step 1: Write the failing tests** (append to `test/detection.test.js`)

```js
test('expo extractors: sqlite schema, ts entities, zustand state', () => {
  const root = copyFixture('expo-app');
  const d = g.detectStack(root);
  const ctx = { root, appDir: '.', detection: d, ignoreFn: g.createIgnoreMatcher({ root, contextDir: '.context' }), treeDepth: 3, dbHints: 'SQLite', versions: { frameworkVersion: '', phpVersion: '', nodeVersion: '18' } };
  assert.match(g.schemaBlock(ctx), /CREATE TABLE users/);
  const ents = g.entitiesBlock(ctx);
  assert.match(ents, /interface User/);
  assert.match(ents, /TaskStatus/);
  assert.match(g.stateBlock(ctx), /interface TaskStore/);
  assert.match(g.envBlock(ctx), /SECRET_KEY=\*\*\*/);
  assert.ok(!g.envBlock(ctx).includes('supersecret'));
  assert.match(g.depsBlock(ctx), /zustand/);
});

test('laravel extractors: migrations and eloquent models', () => {
  const root = copyFixture('laravel-app');
  const d = g.detectStack(root);
  const ctx = { root, appDir: '.', detection: d, ignoreFn: g.createIgnoreMatcher({ root, contextDir: '.context' }), treeDepth: 3, dbHints: '', versions: {} };
  assert.match(g.schemaBlock(ctx), /create_users_table/);
  assert.match(g.entitiesBlock(ctx), /\$fillable/);
  assert.match(g.controllersBlock(ctx), /public function index/);
  const labels = g.sectionLabels(d, 'MySQL');
  assert.strictEqual(labels.entities, 'Eloquent Model Definitions');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/`
Expected: FAIL — `g.schemaBlock is not a function`

- [ ] **Step 3: Implement extractors** (append; each is a direct port — bash grep chains become `grepLines`, awk block scans become `extractBlocks`; every file listing goes through `walkFiles` with the ignore matcher so ignore rules apply to code scans too)

```js
// ── Extractor helpers ────────────────────────────────────────────────────────
function filesUnder(ctx, relDir, ext) {
  if (!relDir || !isDir(path.join(ctx.root, relDir))) return [];
  return walkFiles(path.join(ctx.root, relDir), (p) => ctx.ignoreFn(path.posix.join(relDir, p)), { extensions: [ext] })
    .map((f) => path.posix.join(relDir, f));
}
function codeFence(lang, body) { return body.trim() ? '```' + lang + '\n' + body.trim() + '\n```\n' : ''; }
function fileSection(title, lang, body) { return body.trim() ? `#### \`${title}\`\n${codeFence(lang, body)}\n` : ''; }

// ── Schema scanners (bash lines 496–615) ─────────────────────────────────────
function _schemaSqlite(ctx) {
  const files = walkFiles(ctx.root, ctx.ignoreFn, { extensions: ['.sql'] })
    .concat(walkFiles(ctx.root, ctx.ignoreFn, { extensions: ['.ts'] }).filter((f) => path.basename(f) === 'schema.ts'))
    .sort().slice(0, 5);
  if (!files.length) return '_No schema file found._\n';
  return files.map((f) => {
    const content = readText(path.join(ctx.root, f)) || '';
    const blocks = extractBlocks(content, /CREATE TABLE/i);
    const sqlStatements = blocks || grepLines(content, /CREATE TABLE|^\s+\w+ (TEXT|INTEGER|REAL|BLOB)/i, 40).join('\n');
    return `**\`${f}\`**\n${codeFence('sql', sqlStatements)}`;
  }).join('\n');
}
function _schemaDoctrine(ctx) {
  let out = '';
  const migs = filesUnder(ctx, path.posix.join(ctx.appDir === '.' ? '' : ctx.appDir, 'migrations'), '.php').slice(-10);
  if (migs.length) {
    out += '**Migrations (latest 10):**\n\n';
    for (const f of migs) {
      out += `- \`${path.basename(f, '.php')}\`\n`;
      const sqls = (readText(path.join(ctx.root, f)) || '').match(/addSql\('([^']+)'/g) || [];
      out += sqls.slice(0, 3).map((s) => `  → ${s.replace(/^addSql\('/, '').replace(/'$/, '')}\n`).join('');
    }
    out += '\n';
  }
  for (const f of filesUnder(ctx, ctx.detection.modelsDir, '.php')) {
    const content = readText(path.join(ctx.root, f)) || '';
    if (!/#\[ORM\\Entity\]|@ORM\\Entity/.test(content)) continue;
    const lines = grepLines(content, /#\[ORM\\(Column|Id|ManyToOne|OneToMany|ManyToMany|OneToOne|JoinColumn)|@ORM\\(Column|Id|ManyTo|JoinColumn)|\$\w+/, 25)
      .filter((l) => !/^\s*\/\//.test(l));
    out += fileSection(path.basename(f, '.php'), 'php', lines.join('\n'));
  }
  return out;
}
function _schemaLaravel(ctx) {
  let out = '';
  const migs = filesUnder(ctx, path.posix.join(ctx.appDir === '.' ? '' : ctx.appDir, 'database/migrations'), '.php').slice(-10);
  if (migs.length) {
    out += '**Migrations (latest 10):**\n\n';
    for (const f of migs) {
      out += `- \`${path.basename(f, '.php')}\`\n`;
      const fields = grepLines(readText(path.join(ctx.root, f)) || '', /->(string|integer|boolean|foreignId|timestamps|text|decimal)/, 4);
      out += fields.map((l) => `  ${l.trim()}\n`).join('');
    }
    out += '\n';
  }
  const modelsDir = ctx.detection.modelsDir || 'app/Models';
  const models = filesUnder(ctx, modelsDir, '.php');
  if (models.length) out += '**Eloquent models:**\n\n';
  for (const f of models) {
    const lines = grepLines(readText(path.join(ctx.root, f)) || '',
      /protected \$fillable|protected \$casts|protected \$table|public function (belongsTo|hasMany|hasOne|belongsToMany|morphTo|morphMany)/, 20);
    out += fileSection(path.basename(f, '.php'), 'php', lines.join('\n'));
  }
  return out;
}
function _schemaDjango(ctx) {
  return walkFiles(ctx.root, ctx.ignoreFn, { extensions: ['.py'] })
    .filter((f) => path.basename(f) === 'models.py')
    .map((f) => fileSection(f, 'python',
      grepLines(readText(path.join(ctx.root, f)) || '', /^class [A-Z]|^\s+\w+ = models\.|^\s+class Meta|^\s+ordering|^\s+db_table/, 30).join('\n')))
    .join('');
}
function _schemaRails(ctx) {
  const content = readText(path.join(ctx.root, 'db/schema.rb'));
  if (!content) return '_No `db/schema.rb` found._\n';
  return '**`db/schema.rb`**\n' + codeFence('ruby',
    grepLines(content, /create_table|t\.(string|integer|boolean|text|datetime|references|belongs_to|index)|^end/, 80).join('\n'));
}
function _schemaGo(ctx) {
  return filesUnder(ctx, ctx.detection.modelsDir, '.go')
    .map((f) => fileSection(f, 'go', extractBlocks(readText(path.join(ctx.root, f)) || '', /^type .* struct \{/, { maxLines: 60 })))
    .join('');
}
function schemaBlock(ctx) {
  const s = ctx.detection.stacks;
  if (s.node) return _schemaSqlite(ctx);
  if (s.symfony) return _schemaDoctrine(ctx);
  if (s.laravel) return _schemaLaravel(ctx);
  if (s.django) return _schemaDjango(ctx);
  if (s.rails) return _schemaRails(ctx);
  if (s.go) return _schemaGo(ctx);
  return `_No schema scanner available for detected stack (${ctx.detection.primaryFramework})._\n`;
}

// ── Entity scanners (bash lines 620–708) ─────────────────────────────────────
function _entitiesTypescript(ctx) {
  let typesDir = path.posix.join(ctx.detection.sourceDir || 'src', 'types');
  if (!isDir(path.join(ctx.root, typesDir))) typesDir = 'src/types';
  return filesUnder(ctx, typesDir, '.ts').filter((f) => !f.endsWith('.test.ts'))
    .map((f) => fileSection(f, 'typescript', extractBlocks(readText(path.join(ctx.root, f)) || '', /^export (interface|type|enum) /)))
    .join('');
}
function _entitiesDoctrine(ctx) {
  return filesUnder(ctx, ctx.detection.modelsDir, '.php')
    .map((f) => fileSection(path.basename(f, '.php'), 'php',
      grepLines(readText(path.join(ctx.root, f)) || '', /^\s*(#\[|@ORM|private|protected|public)\s.*\$|\s@var\s/, 25).filter((l) => !/^\s*\/\//.test(l)).join('\n')))
    .join('');
}
function _entitiesEloquent(ctx) {
  return filesUnder(ctx, ctx.detection.modelsDir || 'app/Models', '.php')
    .map((f) => fileSection(path.basename(f, '.php'), 'php',
      grepLines(readText(path.join(ctx.root, f)) || '', /protected \$fillable|protected \$casts|protected \$hidden|public function /, 20).join('\n')))
    .join('');
}
function _entitiesDjango(ctx) { return _schemaDjango(ctx); }
function _entitiesRails(ctx) {
  return filesUnder(ctx, 'app/models', '.rb')
    .map((f) => fileSection(path.basename(f, '.rb'), 'ruby',
      grepLines(readText(path.join(ctx.root, f)) || '', /^\s*(belongs_to|has_many|has_one|has_and_belongs_to_many|validates|scope|enum|attribute)/, 20).join('\n')))
    .join('');
}
function entitiesBlock(ctx) {
  const s = ctx.detection.stacks;
  if (s.node) return _entitiesTypescript(ctx);
  if (s.symfony) return _entitiesDoctrine(ctx);
  if (s.laravel) return _entitiesEloquent(ctx);
  if (s.django) return _entitiesDjango(ctx);
  if (s.rails) return _entitiesRails(ctx);
  if (s.go) return _schemaGo(ctx);
  return `_No entity scanner available for detected stack (${ctx.detection.primaryFramework})._\n`;
}

// ── State layer: Zustand (bash lines 713–738) ────────────────────────────────
function stateBlock(ctx) {
  if (!ctx.detection.stacks.node) return '';
  let storesDir = path.posix.join(ctx.detection.sourceDir || 'src', 'stores');
  if (!isDir(path.join(ctx.root, storesDir))) storesDir = 'src/stores';
  return filesUnder(ctx, storesDir, '.ts').filter((f) => !f.endsWith('.test.ts'))
    .map((f) => fileSection(path.basename(f, '.ts'), 'typescript', extractBlocks(readText(path.join(ctx.root, f)) || '', /^(export )?interface /, { maxLines: 60 })))
    .join('');
}

// ── Signature scanners (bash lines 795–844) ──────────────────────────────────
const SIGNATURE_PATTERNS = {
  models: { php: /^\s*(private|protected|public)\s+/, python: /^\s*(class |    \w+ =|    \w+:)/, go: /^(type |func )/, node: /export (default )?class|interface|readonly |private |public /, ruby: /^\s*(belongs_to|has_many|has_one|validates|attr_)/ },
  controllers: { php: /^\s*#\[Route\(|^\s*public function/, python: /@(app|router)\.(get|post|put|delete|patch)|^def |^async def /, go: /^func /, node: /\.(get|post|put|delete|patch)\s*\(|^export /, ruby: /^\s*def / },
  services: { php: /^\s*public function/, python: /^def |^async def |^    def /, go: /^func /, node: /^export (async )?function|^\s*async \w+\s*\(/, ruby: /^\s*def / },
};
function signatureScan(ctx, dirKey, kind, limit) {
  const dir = ctx.detection[dirKey];
  const pat = SIGNATURE_PATTERNS[kind][ctx.detection.primaryLang];
  if (!dir || !pat) return '';
  return filesUnder(ctx, dir, '.' + ctx.detection.primaryExt)
    .map((f) => fileSection(path.basename(f, '.' + ctx.detection.primaryExt), ctx.detection.primaryLang,
      grepLines(readText(path.join(ctx.root, f)) || '', pat, limit).join('\n')))
    .join('');
}
function modelsBlock(ctx) { return signatureScan(ctx, 'modelsDir', 'models', 15); }
function controllersBlock(ctx) { return signatureScan(ctx, 'controllersDir', 'controllers', 20); }
function servicesBlock(ctx) { return signatureScan(ctx, 'servicesDir', 'services', 12); }

// ── Routes (bash lines 457–471; static-only port — no lando/artisan exec) ────
function routesBlock(ctx) {
  const d = ctx.detection;
  if (d.primaryFramework === 'symfony') return 'Run: `bin/console debug:router` for the live route table.\n';
  if (d.primaryFramework === 'laravel') return 'Run: `php artisan route:list` for the live route table.\n';
  if (d.stacks.express || d.stacks.next || d.stacks.node) {
    const lines = filesUnder(ctx, d.controllersDir || d.sourceDir, '.ts')
      .concat(filesUnder(ctx, d.controllersDir || d.sourceDir, '.js'))
      .flatMap((f) => grepLines(readText(path.join(ctx.root, f)) || '', /\.(get|post|put|delete|patch)\s*\(/, 40))
      .filter((l) => !/^\s*\/\//.test(l)).slice(0, 40);
    return lines.length ? codeFence('js', lines.join('\n')) : '';
  }
  if (d.stacks.fastapi || d.stacks.flask) {
    const lines = walkFiles(ctx.root, ctx.ignoreFn, { extensions: ['.py'] })
      .flatMap((f) => grepLines(readText(path.join(ctx.root, f)) || '', /@(app|router)\.(get|post|put|delete|patch)/, 40)).slice(0, 40);
    return lines.length ? codeFence('python', lines.join('\n')) : '';
  }
  if (d.stacks.rails) { const r = readText(path.join(ctx.root, 'config/routes.rb')); return r ? codeFence('ruby', r.split('\n').slice(0, 60).join('\n')) : ''; }
  return '';
}

// ── Misc blocks (bash lines 289–309, 440–455, 874–902, 1005–1011) ───────────
function migrationsBlock(ctx) {
  const mdir = ctx.detection.stacks.laravel ? 'database/migrations' : 'migrations';
  const files = filesUnder(ctx, path.posix.join(ctx.appDir === '.' ? '' : ctx.appDir, mdir), '.' + ctx.detection.primaryExt);
  if (!files.length) return '_No migrations directory found._\n';
  let out = '| Migration | Date |\n|---|---|\n';
  for (const f of files.slice(-10)) {
    const name = path.basename(f, '.' + ctx.detection.primaryExt);
    out += `| \`${name}\` | ${(name.match(/\d{8}/) || ['—'])[0]} |\n`;
  }
  if (files.length > 10) out += `\n_Showing latest 10 of ${files.length} total._\n`;
  return out;
}
function envBlock(ctx) {
  const mask = (c) => c.split('\n').filter((l) => l && !l.startsWith('#')).map((l) => l.replace(/=.*/, '=***')).join('\n');
  const plain = (c) => c.split('\n').filter((l) => l && !l.startsWith('#')).join('\n');
  for (const [f, fn] of [['.env.example', plain], ['.env', mask]]) {
    const c = readText(path.join(ctx.root, ctx.appDir, f)) ?? readText(path.join(ctx.root, f));
    if (c) return fn(c) + '\n';
  }
  return 'No .env or .env.example found.\n';
}
function depsBlock(ctx) {
  const composer = readJson(path.join(ctx.root, ctx.appDir, 'composer.json'));
  const fmt = (obj) => Object.entries(obj).map(([k, v]) => `- \`${k}\`: ${v}`).join('\n');
  if (composer) {
    let out = '';
    if (composer.require) out += '**require:**\n' + fmt(composer.require) + '\n';
    if (composer['require-dev']) out += '\n**require-dev:**\n' + fmt(composer['require-dev']) + '\n';
    return out;
  }
  const pkg = readJson(path.join(ctx.root, ctx.appDir, 'package.json'));
  if (pkg) {
    let out = '';
    if (pkg.dependencies) out += '**dependencies:**\n' + fmt(pkg.dependencies) + '\n';
    if (pkg.devDependencies) out += '\n**devDependencies:**\n' + fmt(pkg.devDependencies) + '\n';
    return out;
  }
  for (const f of ['requirements.txt', 'go.mod', 'Gemfile']) {
    const c = readText(path.join(ctx.root, ctx.appDir, f));
    if (c) return codeFence('', c);
  }
  return '';
}
function metricsBlock(ctx) {
  const counts = [];
  const extFor = { php: 'PHP', ts: 'TypeScript', py: 'Python', go: 'Go', rs: 'Rust', rb: 'Ruby' };
  const s = ctx.detection.stacks;
  const active = [s.php && 'php', s.node && 'ts', s.python && 'py', s.go && 'go', s.rust && 'rs', s.ruby && 'rb'].filter(Boolean);
  for (const ext of active) {
    const n = walkFiles(ctx.root, ctx.ignoreFn, { extensions: ['.' + ext] }).length;
    if (n > 0) counts.push([`${extFor[ext]} files`, n]);
  }
  counts.push(['Entities/Models', filesUnder(ctx, ctx.detection.modelsDir, '.' + ctx.detection.primaryExt).length]);
  counts.push(['Controllers', filesUnder(ctx, ctx.detection.controllersDir, '.' + ctx.detection.primaryExt).length]);
  counts.push(['Services', filesUnder(ctx, ctx.detection.servicesDir, '.' + ctx.detection.primaryExt).length]);
  return '| Category | Count |\n|---|---|\n' + counts.map(([k, v]) => `| ${k} | ${v} |`).join('\n') + '\n';
}
function treeBlock(ctx) {
  const dirs = [];
  (function recur(rel, depth) {
    if (depth > ctx.treeDepth) return;
    const abs = rel ? path.join(ctx.root, rel) : ctx.root;
    let entries; try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const e of entries.filter((x) => x.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (ctx.ignoreFn(childRel) || e.name.startsWith('.')) continue;
      dirs.push('  '.repeat(depth) + e.name + '/');
      recur(childRel, depth + 1);
    }
  })('', 0);
  return codeFence('', dirs.slice(0, 100).join('\n') || '(no subdirectories)');
}
function git(root, argsArr) {
  const r = spawnSync('git', argsArr, { cwd: root, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : '';
}
function gitActivityBlock(ctx) {
  const logOut = git(ctx.root, ['log', '--oneline', '-15']);
  if (!logOut) return '_No git history._\n';
  const recent = git(ctx.root, ['diff', '--name-only', 'HEAD~5', 'HEAD']).split('\n').filter(Boolean).slice(0, 20);
  let out = '**Recent commits:**\n' + codeFence('', logOut);
  if (recent.length) out += '\n**Recently changed files:**\n' + recent.map((f) => `- \`${f}\``).join('\n') + '\n';
  return out;
}
function findOpenApiFile(ctx) {
  const candidates = ['openapi.yml', 'openapi.yaml', 'openapi.json', 'swagger.yml', 'swagger.yaml', 'swagger.json',
    'api-docs.yml', 'api-docs.yaml', 'api-docs.json', 'api/openapi.yml', 'api/openapi.yaml',
    'docs/openapi.yml', 'docs/openapi.yaml', 'public/api-docs.json', 'public/openapi.json'];
  for (const c of candidates) if (exists(path.join(ctx.root, c))) return c;
  for (const f of walkFiles(ctx.root, ctx.ignoreFn, { extensions: ['.yml', '.yaml', '.json'] }).slice(0, 200)) {
    const head = (readText(path.join(ctx.root, f)) || '').slice(0, 500);
    if (/^openapi:|"openapi":/m.test(head)) return f;
  }
  return '';
}
function sectionLabels(detection, dbHints) {
  const s = detection.stacks; const db = dbHints || 'SQL';
  if (s.node) return { schema: 'Database Schema (SQLite)', entities: 'TypeScript Entity Definitions', state: 'Store Shapes (State)' };
  if (s.symfony) return { schema: `Database Schema (Doctrine / ${db})`, entities: 'Doctrine Entity Definitions', state: '' };
  if (s.laravel) return { schema: `Database Schema (Eloquent / ${db})`, entities: 'Eloquent Model Definitions', state: '' };
  if (s.django) return { schema: `Database Schema (Django ORM / ${db})`, entities: 'Django Model Definitions', state: '' };
  if (s.rails) return { schema: `Database Schema (ActiveRecord / ${db})`, entities: 'ActiveRecord Model Definitions', state: '' };
  if (s.go) return { schema: 'Database Schema (Go structs)', entities: 'Go Type Definitions', state: '' };
  return { schema: 'Database Schema', entities: 'Entity Definitions', state: '' };
}
```

Add all public names to `module.exports`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add generate_project_context.js test/detection.test.js
git commit -m "feat: port all stack extractors from bash script"
```

---

### Task 5: ICM stage writers + stages 01–04 + router

**Files:**
- Modify: `generate_project_context.js`
- Create: `test/generator.test.js`

**Interfaces:**
- Consumes: all Task 3/4 extractors.
- Produces: `writeStage(root, contextDir, stageName, contract, outputs)` — `contract = {inputs: string[], process: string, outputs: [{file, desc}]}`, `outputs = {filename: content}`; writes `stages/<stageName>/CONTEXT.md` + `output/<filename>` for truthy contents, deleting stale files in that stage's `output/` first. `buildStages01to04(ctx) -> [{name, contract, outputs}]`. `writeRouter(root, contextDir, {repoName, stackLabel, generatedAt, stageIndex})` — `stageIndex = [{stage, purpose, files: [{rel, bytes}]}]`. `seedIgnoreFile(root, contextDir)` — writes `_config/ignore` with `DEFAULT_IGNORES` + header comment ONLY if missing. `stackLabel(detection, versions, devEnv, dbHints) -> string` (port of bash lines 904–910).

- [ ] **Step 1: Write the failing test**

```js
// test/generator.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { copyFixture, runGenerator } = require('./helpers.js');

test('full run creates ICM skeleton with contracts (expo, no-ai)', () => {
  const root = copyFixture('expo-app');
  const r = runGenerator(root, ['--no-ai']);
  assert.strictEqual(r.status, 0, r.stderr);
  const ctx = path.join(root, '.context');
  assert.ok(fs.existsSync(path.join(ctx, 'CONTEXT.md')));
  assert.ok(fs.existsSync(path.join(ctx, '_config/ignore')));
  for (const stage of ['01_overview', '02_architecture', '03_data', '04_interfaces', '05_documentation', '06_synthesis']) {
    assert.ok(fs.existsSync(path.join(ctx, 'stages', stage, 'CONTEXT.md')), `${stage} contract missing`);
  }
  const contract = fs.readFileSync(path.join(ctx, 'stages/01_overview/CONTEXT.md'), 'utf8');
  assert.match(contract, /## Inputs/);
  assert.match(contract, /## Process/);
  assert.match(contract, /## Outputs/);
  assert.match(fs.readFileSync(path.join(ctx, 'stages/01_overview/output/stack.md'), 'utf8'), /expo/i);
  assert.match(fs.readFileSync(path.join(ctx, 'stages/03_data/output/schema.md'), 'utf8'), /CREATE TABLE users/);
  assert.match(fs.readFileSync(path.join(ctx, 'stages/03_data/output/state.md'), 'utf8'), /TaskStore/);
  const router = fs.readFileSync(path.join(ctx, 'CONTEXT.md'), 'utf8');
  assert.match(router, /01_overview/);
  assert.match(router, /Interpretable Context Methodology|ICM/);
});

test('ignore seed file is never overwritten', () => {
  const root = copyFixture('expo-app');
  fs.mkdirSync(path.join(root, '.context/_config'), { recursive: true });
  fs.writeFileSync(path.join(root, '.context/_config/ignore'), '# custom\nmy-dir/\n');
  const r = runGenerator(root, ['--no-ai']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(fs.readFileSync(path.join(root, '.context/_config/ignore'), 'utf8'), '# custom\nmy-dir/\n');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/generator.test.js`
Expected: FAIL — status !== 0 or missing `.context` (main isn't wired yet)

- [ ] **Step 3: Implement stage writers and wire a minimal main**

```js
// ── ICM stage writers ────────────────────────────────────────────────────────
function writeStage(root, contextDir, stageName, contract, outputs) {
  const stageDir = path.join(root, contextDir, 'stages', stageName);
  const outDir = path.join(stageDir, 'output');
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  const written = [];
  for (const [file, content] of Object.entries(outputs)) {
    if (!content || !content.trim()) continue;
    fs.writeFileSync(path.join(outDir, file), content.trimEnd() + '\n');
    written.push(file);
  }
  const contractMd = [
    `# Stage ${stageName}`, '',
    '## Inputs', ...contract.inputs.map((i) => `- ${i}`), '',
    '## Process', contract.process, '',
    '## Outputs',
    ...contract.outputs.filter((o) => written.includes(o.file)).map((o) => `- output/${o.file} — ${o.desc}`),
    ...(written.length === 0 ? ['- _No outputs produced (see Process notes)._'] : []),
  ].join('\n') + '\n';
  fs.writeFileSync(path.join(stageDir, 'CONTEXT.md'), contractMd);
  return written;
}

function seedIgnoreFile(root, contextDir) {
  const p = path.join(root, contextDir, '_config', 'ignore');
  if (exists(p)) return false;
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, [
    '# .context ignore rules (gitignore syntax; negation ! unsupported).',
    '# Seeded with defaults on first run — edit freely, this file is never overwritten.',
    ...DEFAULT_IGNORES,
  ].join('\n') + '\n');
  return true;
}

function stackLabel(detection, versions, devEnv, dbHints) {
  let label = detection.primaryFramework;
  if (versions.frameworkVersion) label += ` ${versions.frameworkVersion}`;
  if (versions.phpVersion) label += ` · PHP ${versions.phpVersion}`;
  if (versions.nodeVersion) label += ` · Node ${versions.nodeVersion}`;
  if (devEnv.landoDb) label += ` · ${devEnv.landoDb}`;
  else if (dbHints) label += ` · ${dbHints}`;
  return label;
}
```

`buildStages01to04(ctx)` returns the four stage definitions, mapping extractor output to files (omit-if-empty is handled by `writeStage`):

```js
function devSetupBlock(ctx) {
  switch (ctx.devEnv.devEnv) {
    case 'lando': return codeFence('bash', `lando start\nlando composer install\n${ctx.devEnv.consoleCmd} migrate`);
    case 'docker': return codeFence('bash', 'docker compose up -d\ndocker compose exec app composer install');
    case 'make': return codeFence('bash', 'make dev');
    default: return codeFence('bash', `${ctx.devEnv.runPrefix || 'npm'} install`);
  }
}

function buildStages01to04(ctx) {
  const labels = sectionLabels(ctx.detection, ctx.dbHints);
  const label = stackLabel(ctx.detection, ctx.versions, ctx.devEnv, ctx.dbHints);
  const openApiFile = findOpenApiFile(ctx);
  const openApiRaw = openApiFile ? `> Source: \`${openApiFile}\`\n\n` + codeFence('', (readText(path.join(ctx.root, openApiFile)) || '').slice(0, 4000)) : '';
  return [
    { name: '01_overview',
      contract: { inputs: ['source: composer.json / package.json / go.mod / Gemfile / requirements.txt (stack + versions)', 'source: .lando.yml / docker-compose.yml / .devcontainer / Makefile (dev env)', 'source: .env / .env.example (masked)'],
        process: `Detected the tech stack (${label}), dev environment (${ctx.devEnv.devEnv}), databases (${ctx.dbHints || 'none found'}), and computed file metrics. All scans respect the ignore rules in _config/ignore.`,
        outputs: [{ file: 'stack.md', desc: 'stack, versions, dependencies' }, { file: 'environment.md', desc: 'dev env, masked env vars, setup commands' }, { file: 'metrics.md', desc: 'file and component counts' }] },
      outputs: {
        'stack.md': `# Technology Stack\n\n| | |\n|---|---|\n| **Language** | ${ctx.detection.primaryLang} |\n| **Framework** | ${label} |\n| **Dev env** | ${ctx.devEnv.devEnv}${ctx.devEnv.landoRecipe ? ` (${ctx.devEnv.landoRecipe})` : ''} |\n${ctx.dbHints ? `| **Database** | ${ctx.dbHints} |\n` : ''}\n## Dependencies\n\n${depsBlock(ctx)}`,
        'environment.md': `# Environment\n\n## Environment Variables\n\n${codeFence('', envBlock(ctx))}\n## Development Setup\n\n${devSetupBlock(ctx)}`,
        'metrics.md': `# Metrics\n\n${metricsBlock(ctx)}`,
      } },
    { name: '02_architecture',
      contract: { inputs: ['source: directory tree (ignore rules applied)', 'source: git log / git diff'],
        process: 'Captured the directory structure and recent git activity.',
        outputs: [{ file: 'structure.md', desc: 'directory tree' }, { file: 'git-activity.md', desc: 'recent commits and changed files' }] },
      outputs: { 'structure.md': `# Project Structure\n\n${treeBlock(ctx)}`, 'git-activity.md': `# Recent Git Activity\n\n${gitActivityBlock(ctx)}` } },
    { name: '03_data',
      contract: { inputs: [`source: ${ctx.detection.modelsDir || 'model files'}`, 'source: migrations / schema files'],
        process: `Extracted the data layer for ${ctx.detection.primaryFramework}: schema, entity definitions${labels.state ? ', store shapes' : ''}, and migrations.`,
        outputs: [{ file: 'schema.md', desc: labels.schema }, { file: 'entities.md', desc: labels.entities }, { file: 'state.md', desc: labels.state || 'store shapes' }, { file: 'migrations.md', desc: 'latest migrations' }] },
      outputs: {
        'schema.md': `# ${labels.schema}\n\n${schemaBlock(ctx)}`,
        'entities.md': `# ${labels.entities}\n\n${entitiesBlock(ctx)}`,
        'state.md': labels.state ? `# ${labels.state}\n\n${stateBlock(ctx)}` : '',
        'migrations.md': `# Migrations\n\n${migrationsBlock(ctx)}`,
      } },
    { name: '04_interfaces',
      contract: { inputs: [`source: ${ctx.detection.controllersDir || 'controller files'}`, `source: ${ctx.detection.servicesDir || 'service files'}`, openApiFile ? `source: ${openApiFile}` : 'source: (no OpenAPI spec found)'],
        process: 'Extracted API routes, controller and service signatures, and the OpenAPI spec if present.',
        outputs: [{ file: 'routes.md', desc: 'API routes' }, { file: 'controllers.md', desc: 'controller signatures' }, { file: 'services.md', desc: 'service signatures' }, { file: 'api-spec.md', desc: 'OpenAPI/Swagger spec' }] },
      outputs: {
        'routes.md': routesBlock(ctx) ? `# API Routes\n\n${routesBlock(ctx)}` : '',
        'controllers.md': controllersBlock(ctx) ? `# Controllers\n\n${controllersBlock(ctx)}` : '',
        'services.md': servicesBlock(ctx) ? `# Services\n\n${servicesBlock(ctx)}` : '',
        'api-spec.md': openApiRaw ? `# API Specification\n\n${openApiRaw}` : '',
      } },
  ];
}
```

`writeRouter`:

```js
function writeRouter(root, contextDir, { repoName, label, stageIndex }) {
  const rows = stageIndex.map(({ stage, purpose, files }) =>
    `| \`stages/${stage}/\` | ${purpose} | ${files.map((f) => `\`${f.rel}\` (${f.bytes}b)`).join(', ') || '—'} |`).join('\n');
  const md = `# ${repoName} — Project Context (.context)

> Generated: ${new Date().toISOString()} · Stack: ${label} · Generator: v${GENERATOR_VERSION}

This folder is an **ICM (Interpretable Context Methodology)** context structure
(https://arxiv.org/html/2603.16021v2): numbered stages, each with a CONTEXT.md
contract (Inputs / Process / Outputs) and an output/ folder of focused markdown.

## How to use this folder (for agents)

1. Read this router.
2. Pick the stages relevant to your task from the index below (numbering = recommended reading order).
3. Read each chosen stage's CONTEXT.md, then load only the output files you need.
4. Do not load every file — the structure exists so you can scope your context.

Regenerate with: \`node generate_project_context.js\`. Ignore rules live in
\`_config/ignore\`; the parse ledger in \`_config/manifest.json\`.

## Stage index

| Stage | Purpose | Output files |
|---|---|---|
${rows}
`;
  fs.writeFileSync(path.join(root, contextDir, 'CONTEXT.md'), md);
}
```

Wire `main()` (replace the Task 1 stub body after arg parsing):

```js
async function main() {
  // ...Node version check + parseArgs as in Task 1...
  const root = process.cwd();
  const repoName = path.basename(root);
  seedIgnoreFile(root, args.contextDir);
  let detection = detectStack(root);
  let appDir = '.';
  if (detection.primaryLang === 'unknown' && process.stdin.isTTY) {
    const readline = require('node:readline/promises');
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    const sub = (await rl.question('  App code in a subdirectory? Enter path (or press Enter to skip): ')).trim();
    rl.close();
    if (sub && isDir(path.join(root, sub))) { detection = detectStack(root, sub); if (detection.primaryLang !== 'unknown') appDir = sub; }
  }
  const devEnv = detectDevEnv(root, detection);
  const dbHints = detectDatabases(root, appDir);
  const versions = extractVersions(root, appDir, detection);
  if (args.debugDetection) { console.log(JSON.stringify({ repoName, detection, devEnv, dbHints, versions, useAi: args.useAi }, null, 2)); return; }
  const ignoreFn = createIgnoreMatcher({ root, contextDir: args.contextDir });
  const ctx = { root, appDir, detection, devEnv, dbHints, versions, ignoreFn, treeDepth: args.treeDepth, contextDir: args.contextDir, useAi: args.useAi, aiCli: args.aiCli, repoName };

  const stageIndex = [];
  const purposes = { '01_overview': 'Stack, environment, metrics', '02_architecture': 'Structure and git activity', '03_data': 'Schema, entities, state, migrations', '04_interfaces': 'Routes, controllers, services, API spec' };
  for (const stage of buildStages01to04(ctx)) {
    log.info(`Stage ${stage.name}...`);
    const written = writeStage(root, args.contextDir, stage.name, stage.contract, stage.outputs);
    stageIndex.push({ stage: stage.name, purpose: purposes[stage.name], files: written.map((f) => ({ rel: `output/${f}`, bytes: fs.statSync(path.join(root, args.contextDir, 'stages', stage.name, 'output', f)).size })) });
  }
  // Stage 05 + 06 land in Tasks 6–7; write placeholder contracts so the skeleton is complete:
  writeStage(root, args.contextDir, '05_documentation', { inputs: ['source: **/*.md (ignore rules applied)'], process: 'Markdown documentation parsing (implemented in Task 6).', outputs: [] }, {});
  writeStage(root, args.contextDir, '06_synthesis', { inputs: ['stage outputs 01–05'], process: 'AI synthesis (implemented in Task 7).', outputs: [] }, {});
  stageIndex.push({ stage: '05_documentation', purpose: 'Markdown docs index and digests', files: [] });
  stageIndex.push({ stage: '06_synthesis', purpose: 'AI overview, architecture notes, focus', files: [] });
  writeRouter(root, args.contextDir, { repoName, label: stackLabel(detection, versions, devEnv, dbHints), stageIndex });
  log.success(`${args.contextDir}/ generated`);
  log.info('Tip: add "Read .context/CONTEXT.md first" to your CLAUDE.md / AGENTS.md.');
}
```

Note: the two placeholder `writeStage` calls above are temporary scaffolding that Tasks 6 and 7 replace — that is their designed lifecycle, not an omission.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add generate_project_context.js test/generator.test.js
git commit -m "feat: write ICM stage structure, contracts, and router for stages 01-04"
```

---

### Task 6: Stage 05 — markdown digests + manifest ledger (incremental core)

**Files:**
- Modify: `generate_project_context.js`
- Modify: `test/unit.test.js`, `test/generator.test.js`

**Interfaces:**
- Consumes: `walkFiles`, `sha256`, `writeStage`, ctx convention.
- Produces: `slugForPath(rel) -> string` (e.g. `docs/adr/001 Auth.md` → `docs-adr-001-auth`); `mdDigest(content) -> {title, headings: string[], wordCount}` (title = first `# ` line or `''`; headings = all `##`–`######` lines); `loadManifest(root, contextDir) -> object` (returns fresh empty manifest if absent/corrupt); `runDocumentationStage(ctx, oldManifest, aiSummarize) -> {indexMd, summaries: {slugFile: content}, parsedMarkdown, stats: {parsed, skipped, removed}}` where `aiSummarize(rel, content) -> string|''` is injected (Task 7 supplies the real one; `--no-ai` supplies `() => ''`); `saveManifest(root, contextDir, manifest)`.
- Manifest shape (spec): `{version: 1, generated_at, generator_version, project: {name, stack}, parsed_markdown: {rel: {sha256, mtime, summary, ai_summarized, parsed_at}}, stages: {name: {last_run}}}`.

- [ ] **Step 1: Write failing unit tests** (append to `test/unit.test.js`)

```js
test('slugForPath flattens and sanitizes', () => {
  assert.strictEqual(g.slugForPath('docs/adr/001 Auth.md'), 'docs-adr-001-auth');
  assert.strictEqual(g.slugForPath('README.md'), 'readme');
});

test('mdDigest extracts title, headings, word count', () => {
  const d = g.mdDigest('# Title\n\nSome words here.\n\n## Section A\ntext\n### Sub B\n');
  assert.strictEqual(d.title, 'Title');
  assert.deepStrictEqual(d.headings, ['## Section A', '### Sub B']);
  assert.ok(d.wordCount > 3);
});
```

- [ ] **Step 2: Write failing integration tests** (append to `test/generator.test.js`)

```js
test('stage 05 indexes docs, excludes vendored md, and ledger skips unchanged files', () => {
  const root = copyFixture('expo-app');
  const r1 = runGenerator(root, ['--no-ai']);
  assert.strictEqual(r1.status, 0, r1.stderr);
  const ctxDir = path.join(root, '.context');
  const index = fs.readFileSync(path.join(ctxDir, 'stages/05_documentation/output/index.md'), 'utf8');
  assert.match(index, /README\.md/);
  assert.match(index, /docs\/architecture\.md/);
  assert.ok(!index.includes('node_modules'), 'vendored md must not be indexed');
  const sumDir = path.join(ctxDir, 'stages/05_documentation/output/summaries');
  assert.ok(fs.existsSync(path.join(sumDir, 'readme.md')));
  assert.ok(fs.existsSync(path.join(sumDir, 'docs-architecture.md')));
  const m1 = JSON.parse(fs.readFileSync(path.join(ctxDir, '_config/manifest.json'), 'utf8'));
  const t1 = m1.parsed_markdown['README.md'].parsed_at;
  assert.strictEqual(m1.parsed_markdown['README.md'].ai_summarized, false);

  // Second run: unchanged files keep parsed_at; changed file re-parses; deleted file cleaned up.
  fs.appendFileSync(path.join(root, 'docs/architecture.md'), '\n## New section\n');
  fs.rmSync(path.join(root, 'README.md'));
  fs.writeFileSync(path.join(root, 'docs/new.md'), '# New Doc\n');
  const r2 = runGenerator(root, ['--no-ai']);
  assert.strictEqual(r2.status, 0, r2.stderr);
  const m2 = JSON.parse(fs.readFileSync(path.join(ctxDir, '_config/manifest.json'), 'utf8'));
  assert.strictEqual(m2.parsed_markdown['docs/architecture.md'].sha256 === m1.parsed_markdown['docs/architecture.md'].sha256, false);
  assert.ok(m2.parsed_markdown['docs/new.md']);
  assert.strictEqual(m2.parsed_markdown['README.md'], undefined, 'deleted file removed from ledger');
  assert.ok(!fs.existsSync(path.join(sumDir, 'readme.md')), 'deleted file summary removed');
  // unchanged file (expo fixture has no other md) — verify skip via stderr stats
  assert.match(r2.stderr, /skipped/i);
});
```

Also add to the same file a skip-verification using an untouched file: add `docs/stable.md` to the expo fixture in Task 3's layout (content `# Stable\n`), then assert here: `assert.strictEqual(m2.parsed_markdown['docs/stable.md'].parsed_at, m1.parsed_markdown['docs/stable.md'].parsed_at);`

- [ ] **Step 3: Run tests to verify they fail**

Run: `node --test test/`
Expected: FAIL — `g.slugForPath is not a function`; integration test fails on missing `index.md`

- [ ] **Step 4: Implement**

```js
// ── Markdown digests + ledger (stage 05) ─────────────────────────────────────
function slugForPath(rel) {
  return rel.replace(/\.md$/i, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function mdDigest(content) {
  const lines = content.split('\n');
  const title = (lines.find((l) => /^# /.test(l)) || '').replace(/^# /, '');
  const headings = lines.filter((l) => /^#{2,6} /.test(l));
  const wordCount = content.split(/\s+/).filter(Boolean).length;
  return { title, headings, wordCount };
}

function emptyManifest(repoName) {
  return { version: 1, generated_at: '', generator_version: GENERATOR_VERSION, project: { name: repoName, stack: '' }, parsed_markdown: {}, stages: {} };
}
function loadManifest(root, contextDir, repoName) {
  const m = readJson(path.join(root, contextDir, '_config', 'manifest.json'));
  return (m && m.version === 1 && m.parsed_markdown) ? m : emptyManifest(repoName);
}
function saveManifest(root, contextDir, manifest) {
  const p = path.join(root, contextDir, '_config', 'manifest.json');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(manifest, null, 2) + '\n');
}

function runDocumentationStage(ctx, oldManifest, aiSummarize) {
  const mdFiles = walkFiles(ctx.root, ctx.ignoreFn, { extensions: ['.md'] });
  const parsedMarkdown = {};
  const summaries = {};
  const stats = { parsed: 0, skipped: 0, removed: 0 };
  const now = new Date().toISOString();
  const usedSlugs = new Set();

  for (const rel of mdFiles) {
    const content = readText(path.join(ctx.root, rel)) || '';
    const hash = sha256(content);
    let slug = slugForPath(rel);
    while (usedSlugs.has(slug)) slug += '-2';
    usedSlugs.add(slug);
    const summaryRel = `stages/05_documentation/output/summaries/${slug}.md`;
    const old = oldManifest.parsed_markdown[rel];
    const oldSummaryContent = old && old.sha256 === hash ? readText(path.join(ctx.root, ctx.contextDir, old.summary)) : null;
    const needsAiUpgrade = ctx.useAi && old && old.ai_summarized === false;
    if (old && old.sha256 === hash && oldSummaryContent !== null && !needsAiUpgrade) {
      stats.skipped++;
      parsedMarkdown[rel] = { ...old, summary: summaryRel };
      summaries[`${slug}.md`] = oldSummaryContent;
      continue;
    }
    stats.parsed++;
    const d = mdDigest(content);
    const aiText = aiSummarize(rel, content);
    const mtime = fs.statSync(path.join(ctx.root, rel)).mtime.toISOString();
    summaries[`${slug}.md`] = [
      `# ${rel}`, '',
      `> Title: ${d.title || '(none)'} · ${d.wordCount} words · parsed ${now}`, '',
      '## Outline', d.headings.length ? d.headings.map((h) => `- ${h.replace(/^#+ /, (m) => '  '.repeat(m.trim().length - 2))}`).join('\n') : '_No sub-headings._', '',
      ...(aiText ? ['## Summary', aiText, ''] : []),
    ].join('\n');
    parsedMarkdown[rel] = { sha256: hash, mtime, summary: summaryRel, ai_summarized: Boolean(aiText), parsed_at: now };
  }
  stats.removed = Object.keys(oldManifest.parsed_markdown).filter((rel) => !parsedMarkdown[rel]).length;

  let indexMd = '# Documentation Index\n';
  let prevDir = null;
  for (const rel of mdFiles) {
    const dir = path.posix.dirname(rel);
    if (dir !== prevDir) { indexMd += `\n**${dir === '.' ? '(root)' : dir + '/'}**\n`; prevDir = dir; }
    const entry = parsedMarkdown[rel];
    const slugFile = path.posix.basename(entry.summary);
    indexMd += `- [${rel}](../../../../${rel}) — [digest](summaries/${slugFile})\n`;
  }
  return { indexMd, summaries, parsedMarkdown, stats };
}
```

Wire into `main()` replacing the Task 5 placeholder for stage 05 (note `writeStage` clears `output/` including stale `summaries/`, which handles deleted files automatically; summaries are written via the outputs map using subpath keys — extend `writeStage` to `fs.mkdirSync(path.dirname(outPath), {recursive: true})` per file so `summaries/x.md` keys work):

```js
  const manifest = loadManifest(root, args.contextDir, repoName);
  log.info('Stage 05_documentation...');
  const docResult = runDocumentationStage(ctx, manifest, () => '');  // real AI summarizer injected in Task 7
  const doc05Outputs = { 'index.md': docResult.indexMd };
  for (const [f, c] of Object.entries(docResult.summaries)) doc05Outputs[`summaries/${f}`] = c;
  const written05 = writeStage(root, args.contextDir, '05_documentation', {
    inputs: ['source: **/*.md (ignore rules from _config/ignore applied)', 'reference: _config/manifest.json (parse ledger)'],
    process: `Indexed ${Object.keys(docResult.parsedMarkdown).length} markdown files; parsed ${docResult.stats.parsed}, skipped ${docResult.stats.skipped} unchanged (ledger), removed ${docResult.stats.removed} stale.`,
    outputs: [{ file: 'index.md', desc: 'all project markdown files, grouped by directory' }, { file: 'summaries/', desc: 'one digest per markdown file' }],
  }, doc05Outputs);
  log.info(`Docs: ${docResult.stats.parsed} parsed, ${docResult.stats.skipped} skipped (unchanged), ${docResult.stats.removed} removed`);
```

and at the very end of `main()` (after the router):

```js
  const finalManifest = emptyManifest(repoName);
  finalManifest.generated_at = new Date().toISOString();
  finalManifest.project.stack = stackLabel(detection, versions, devEnv, dbHints);
  finalManifest.parsed_markdown = docResult.parsedMarkdown;
  for (const s of stageIndex) finalManifest.stages[s.stage] = { last_run: finalManifest.generated_at };
  saveManifest(root, args.contextDir, finalManifest);
```

The `writeStage` contract-filtering line must treat `summaries/` outputs as covered by the `summaries/` contract entry: change the filter to `written.includes(o.file) || (o.file.endsWith('/') && written.some((w) => w.startsWith(o.file)))`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test test/`
Expected: PASS (including both incremental assertions)

- [ ] **Step 6: Commit**

```bash
git add generate_project_context.js test/unit.test.js test/generator.test.js
git commit -m "feat: add stage 05 markdown digests with manifest ledger skipping"
```

---

### Task 7: AI integration + stage 06 synthesis

**Files:**
- Modify: `generate_project_context.js`
- Modify: `test/generator.test.js`

**Interfaces:**
- Consumes: everything prior.
- Produces: `checkAiAvailable(args) -> {useAi, reason}` (disables AI when: `--no-ai`; `$CLAUDECODE` set and cli is claude — nested-session guard from bash lines 59–69; CLI binary not on PATH); `callAi(aiCli, prompt) -> string` (`spawnSync(aiCli, ['-p', prompt], {encoding:'utf8', timeout: 120000})`, returns `''` on any failure with a `log.warn`); `makeAiSummarizer(ctx) -> (rel, content) => string` (prompt: "Summarize this project documentation file for an AI coding agent. File: <rel>. Content (truncated to 6000 chars): <content>. Write 2-4 sentences covering what the doc describes and when an agent should read it. Output only the summary."); `buildStage06(ctx, aiResults)` — overview/architecture-notes/current-focus prompts ported verbatim from bash lines 368–411 (including the `AI_CONTEXT_FILES` key-file sampling, bash lines 311–339, reimplemented as `collectAiContextFiles(ctx) -> string` with the same 6000-char budget and 800-char-per-file head); OpenAPI AI summary (bash lines 412–437) written into stage 04's `api-spec.md` when AI is on.

- [ ] **Step 1: Write the failing test** (append to `test/generator.test.js`; uses a fake `claude` binary on PATH)

```js
test('fake AI CLI: stage 06 outputs and md summaries with upgrade on re-run', () => {
  const root = copyFixture('expo-app');
  const os = require('node:os');
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'icm-bin-'));
  const fake = path.join(binDir, 'claude');
  fs.writeFileSync(fake, '#!/bin/sh\necho "FAKE_AI_OUTPUT"\n');
  fs.chmodSync(fake, 0o755);
  const env = { ...process.env, PATH: `${binDir}:${process.env.PATH}` };
  delete env.CLAUDECODE;
  const { spawnSync } = require('node:child_process');
  const SCRIPT = path.join(__dirname, '..', 'generate_project_context.js');

  // First run without AI, then with AI: ledger must upgrade ai_summarized files.
  let r = spawnSync(process.execPath, [SCRIPT, '--no-ai'], { cwd: root, encoding: 'utf8', env });
  assert.strictEqual(r.status, 0, r.stderr);
  r = spawnSync(process.execPath, [SCRIPT], { cwd: root, encoding: 'utf8', env });
  assert.strictEqual(r.status, 0, r.stderr);
  const ctxDir = path.join(root, '.context');
  assert.match(fs.readFileSync(path.join(ctxDir, 'stages/06_synthesis/output/overview.md'), 'utf8'), /FAKE_AI_OUTPUT/);
  assert.match(fs.readFileSync(path.join(ctxDir, 'stages/05_documentation/output/summaries/readme.md'), 'utf8'), /FAKE_AI_OUTPUT/);
  const m = JSON.parse(fs.readFileSync(path.join(ctxDir, '_config/manifest.json'), 'utf8'));
  assert.strictEqual(m.parsed_markdown['README.md'].ai_summarized, true);
});

test('no-ai run marks stage 06 as not executed', () => {
  const root = copyFixture('expo-app');
  const r = runGenerator(root, ['--no-ai']);
  assert.strictEqual(r.status, 0, r.stderr);
  const contract = fs.readFileSync(path.join(root, '.context/stages/06_synthesis/CONTEXT.md'), 'utf8');
  assert.match(contract, /not executed/i);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/`
Expected: FAIL — stage 06 `overview.md` missing / contract lacks "not executed"

- [ ] **Step 3: Implement** — `checkAiAvailable` + `callAi` + `collectAiContextFiles` + `makeAiSummarizer`, then in `main()`:

```js
  const ai = checkAiAvailable(args);            // before building ctx; ctx.useAi = ai.useAi
  if (!ai.useAi && args.useAi) log.info(ai.reason);
  // ... stage 05 call becomes:
  const summarizer = ai.useAi ? makeAiSummarizer(ctx) : () => '';
  const docResult = runDocumentationStage(ctx, manifest, summarizer);
  // ... stage 06 after stage 05:
  log.info('Stage 06_synthesis...');
  let stage06Outputs = {}; let stage06Process;
  if (ai.useAi) {
    const keyFiles = collectAiContextFiles(ctx);
    const gitLog = git(root, ['log', '--oneline', '-10']) || 'No git history';
    const gitRecent = git(root, ['diff', '--name-only', 'HEAD~5', 'HEAD']).split('\n').slice(0, 20).join('\n');
    const overview = callAi(args.aiCli, /* bash line 370 prompt with ${repoName}, framework, devEnv, dbHints, gitLog, keyFiles */);
    const architecture = callAi(args.aiCli, /* bash line 392 prompt with entity/service/dir lists */);
    const focus = callAi(args.aiCli, /* bash line 402 prompt with gitLog + gitRecent */);
    stage06Outputs = {
      'overview.md': overview ? `# Project Overview\n\n${overview}` : '',
      'architecture-notes.md': architecture ? `# Architecture Notes\n\n${architecture}` : '',
      'current-focus.md': focus ? `# Current Development Focus\n\n${focus}` : '',
    };
    stage06Process = `AI synthesis via ${args.aiCli}: project overview, architecture patterns, and development focus derived from stages 01–05 inputs.`;
  } else {
    stage06Process = `Not executed — AI was unavailable (${ai.reason || '--no-ai'}). Re-run with an AI CLI (claude or gemini) on PATH to generate synthesis.`;
  }
  const written06 = writeStage(root, args.contextDir, '06_synthesis', {
    inputs: ['working: stage 01–05 outputs', 'source: git log', 'source: key project files (truncated samples)'],
    process: stage06Process,
    outputs: [{ file: 'overview.md', desc: 'AI project overview' }, { file: 'architecture-notes.md', desc: 'AI pattern analysis' }, { file: 'current-focus.md', desc: 'AI reading of recent commits' }],
  }, stage06Outputs);
```

The three `/* bash line N prompt */` placeholders above mean: copy the exact prompt strings from `generate_project_context.sh` lines 370–382, 392–399, and 402–410, converting `${VAR}` interpolations to JS template literals. `ENTITY_LIST`/`SERVICE_LIST`/`DIR_LIST` (bash lines 385–390) become basename lists from `filesUnder(ctx, detection.modelsDir, ...)` etc. Also: when AI is on and `findOpenApiFile` found a spec, run the bash line 415–436 OpenAPI prompt and use its result as `api-spec.md` content in stage 04 (pass it into `buildStages01to04` via `ctx.aiOpenApi`, computed before stages are built). Update the router `stageIndex` push for 05/06 to use the real `written05`/`written06` file lists (with byte sizes, same as stages 01–04), and remove the Task 5 placeholder stage-06 write.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add generate_project_context.js test/generator.test.js
git commit -m "feat: add AI synthesis stage and ledger-aware AI summaries"
```

---

### Task 8: Finalize — laravel integration test, delete bash script, rewrite README, end-to-end verify

**Files:**
- Modify: `test/generator.test.js`
- Delete: `generate_project_context.sh`
- Modify: `README.md` (full rewrite)

- [ ] **Step 1: Add laravel + debug-detection integration tests**

```js
test('laravel fixture full run', () => {
  const root = copyFixture('laravel-app');
  const r = runGenerator(root, ['--no-ai']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(fs.readFileSync(path.join(root, '.context/stages/03_data/output/schema.md'), 'utf8'), /create_users_table/);
  assert.match(fs.readFileSync(path.join(root, '.context/stages/03_data/output/entities.md'), 'utf8'), /\$fillable/);
  assert.ok(!fs.existsSync(path.join(root, '.context/stages/03_data/output/state.md')), 'state.md omitted for PHP stack');
});

test('--debug-detection prints JSON and writes nothing', () => {
  const root = copyFixture('expo-app');
  const r = runGenerator(root, ['--no-ai', '--debug-detection']);
  assert.strictEqual(r.status, 0, r.stderr);
  const parsed = JSON.parse(r.stdout);
  assert.strictEqual(parsed.detection.primaryLang, 'node');
  assert.ok(!fs.existsSync(path.join(root, '.context/CONTEXT.md')));
});
```

Note: `--debug-detection` currently runs after `seedIgnoreFile`; move the debug branch before any filesystem writes so it is truly read-only, then the second assertion also checks `_config/ignore` was not created: `assert.ok(!fs.existsSync(path.join(root, '.context')));`

- [ ] **Step 2: Run tests**

Run: `node --test test/`
Expected: PASS (fix the debug-detection ordering if the write-nothing assertion fails)

- [ ] **Step 3: Delete the bash script and rewrite README**

```bash
git rm generate_project_context.sh
```

README structure (full rewrite, keep the supported-stacks table):

```markdown
# generate_project_context

Generates an ICM `.context/` folder structure for any project — numbered
stages of focused markdown context that AI agents can navigate selectively,
instead of one monolithic context file.
Based on the Interpretable Context Methodology (https://arxiv.org/html/2603.16021v2).

## Requirements
- Node.js >= 18 (no npm dependencies)
- git (optional — enables git activity + AI focus sections)
- Claude CLI or Gemini CLI (optional — enables AI summaries)

## Installation
Option 1 — project-local: copy generate_project_context.js into your project.
Option 2 — global: cp generate_project_context.js /usr/local/bin/generate_project_context && chmod +x

## Usage
node generate_project_context.js [--no-ai] [--ai <claude|gemini>] [--context-dir <dir>] [--depth <n>] [--debug-detection]

## Output structure
<the .context tree from the spec, with one-line descriptions>

## The ledger (incremental re-runs)
<manifest.json semantics: sha256 skip, ai upgrade, deletion cleanup, written-last>

## Ignore rules
<defaults + .gitignore + _config/ignore precedence; negation (!) unsupported>

## Supported stacks
<existing table from old README>

## For agents
Read `.context/CONTEXT.md` first; load only the stage outputs you need.

## Tests
node --test test/
```

- [ ] **Step 4: End-to-end verification on this repository itself**

Run: `node generate_project_context.js --no-ai && find .context -type f | sort`
Expected: full `.context/` tree; `stages/05_documentation/output/index.md` lists `README.md` and `docs/superpowers/**` files.
Run again: `node generate_project_context.js --no-ai 2>&1 | grep -i skipped`
Expected: skip count equals the number of md files (nothing changed).
Then clean up: `rm -rf .context` (do not commit generated output of this repo).

- [ ] **Step 5: Run full test suite one final time**

Run: `node --test test/`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: replace bash generator with ICM .context Node.js generator"
```

---

## Verification (whole feature)

1. `node --test test/` — all unit + integration tests pass.
2. Fresh run on a fixture: `.context/` contains router, `_config/ignore`, `_config/manifest.json`, six stage folders each with `CONTEXT.md` (Inputs/Process/Outputs) and populated `output/`.
3. Incremental: second run skips all unchanged md files (stderr stats); touching one file re-parses only it; deleting one removes its summary + ledger entry.
4. Ignores: planted `node_modules/**/*.md` never appears in index or summaries; editing `_config/ignore` to add a dir excludes it on the next run and the file survives re-runs untouched.
5. `--debug-detection` prints detection JSON and writes nothing.
6. Fake-AI test proves stage 06 outputs + per-md AI summaries + `ai_summarized` upgrade.
7. Real-world smoke test on this repo (Task 8 Step 4).
