'use strict';
const test = require('node:test');
const assert = require('node:assert');
const g = require('../generate_project_context.js');

test('parseArgs defaults', () => {
  const a = g.parseArgs([]);
  assert.deepStrictEqual(a, { aiCli: 'claude', contextDir: '.context', treeDepth: 3, debugDetection: false, dir: '.' });
});

test('parseArgs flags', () => {
  const a = g.parseArgs(['--ai', 'gemini', '--context-dir', 'ctx', '--depth', '5', '--debug-detection']);
  assert.deepStrictEqual(a, { aiCli: 'gemini', contextDir: 'ctx', treeDepth: 5, debugDetection: true, dir: '.' });
});

test('parseArgs unknown flag throws', () => {
  assert.throws(() => g.parseArgs(['--bogus']), /Unknown option: --bogus/);
});

test('grepLines returns matching lines up to limit', () => {
  const out = g.grepLines('a1\nb2\na3\na4', /^a/, 2);
  assert.deepStrictEqual(out, ['a1', 'a3']);
});

test('sha256 is stable hex', () => {
  assert.strictEqual(g.sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

const fsx = require('node:fs');
const pathx = require('node:path');
const osx = require('node:os');

test('ignore matcher: defaults, gitignore, custom file', () => {
  const tmp = fsx.mkdtempSync(pathx.join(osx.tmpdir(), 'icm-ign-'));
  fsx.writeFileSync(pathx.join(tmp, '.gitignore'), '*.log\n/secret\n!keep.log\nbuilt/**\n# comment\n');
  fsx.mkdirSync(pathx.join(tmp, '.context/_config'), { recursive: true });
  fsx.writeFileSync(pathx.join(tmp, '.context/_config/ignore'), 'legacy-docs/\n');
  const ignored = g.createIgnoreMatcher({ root: tmp, contextDir: '.context' });
  assert.ok(ignored('node_modules/pkg/README.md'), 'default dir ignored at any depth');
  assert.ok(ignored('deep/node_modules/x.md'));
  assert.ok(ignored('app.log'), 'gitignore glob');
  assert.ok(ignored('keep.log'), 'negation unsupported; *.log still matches');
  assert.ok(ignored('secret/notes.md'), 'root-anchored gitignore path');
  assert.ok(ignored('legacy-docs/old.md'), 'custom ignore file');
  assert.ok(ignored('built'), 'dir/** matches bare directory');
  assert.ok(ignored('built/js/app.md'), 'dir/** matches files under directory');
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

test('parseArgs --depth falls back to 3 on non-numeric', () => {
  assert.strictEqual(g.parseArgs(['--depth', 'abc']).treeDepth, 3);
});

test('parseArgs --dir', () => {
  assert.strictEqual(g.parseArgs(['--dir', '/some/place']).dir, '/some/place');
});

test('stripModelPreamble removes leaked self-talk/routing sentences but keeps real content', () => {
  assert.strictEqual(
    g.stripModelPreamble('This is a plain content-generation task (writing a doc summary), not creative feature work or a coding task — no skill applies here.\n\nThe project is a Symfony API.'),
    'The project is a Symfony API.',
  );
  assert.strictEqual(g.stripModelPreamble('No skill applies here. The service handles billing.'), 'The service handles billing.');
  assert.strictEqual(g.stripModelPreamble("Let me analyze this. The service handles billing."), 'The service handles billing.');
  // legitimate content that merely contains "task" elsewhere must survive untouched
  assert.strictEqual(g.stripModelPreamble('The queue worker processes background tasks nightly.'), 'The queue worker processes background tasks nightly.');
});

test('extractDomainNotes parses markdown-table "Key Entities"/"Key Services" sections and "Key Gotchas" field notes', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'domain-notes-'));
  fs.writeFileSync(path.join(tmp, 'CLAUDE.md'), [
    '## Key Entities', '', '| Entity | Purpose |', '|---|---|', '| `Club` | A football club. |', '',
    '## Key Gotchas', '', '- `hallOfFamePoints`: max(current, incoming) — never decreases.', '',
    '## Key Services', '', '| Service | Purpose |', '|---|---|', '| `EconomicService` | Computes economy figures. |',
  ].join('\n'));
  const notes = g.extractDomainNotes({ root: tmp });
  assert.strictEqual(notes.entities.Club, 'A football club.');
  assert.strictEqual(notes.services.EconomicService, 'Computes economy figures.');
  assert.strictEqual(notes.gotchas.length, 1);
  assert.deepStrictEqual(notes.gotchas[0].names, ['hallOfFamePoints']);
});

test('annotateWithDomainNotes annotates every heading found (present note or explicit absence)', () => {
  const md = '#### `Known`\n```php\nprivate int $id;\n```\n\n#### `Unknown`\n```php\nprivate int $id;\n```\n';
  const out = g.annotateWithDomainNotes(md, { Known: 'A known thing.' });
  assert.match(out, /#### `Known`\n\n> \*\*Purpose:\*\* A known thing\./);
  assert.match(out, /#### `Unknown`\n\n> _No hand-written notes found/);
});

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

test('dedupeGotchaHits drops hits whose field-name set is a subset of another hit, keeping the most complete one', () => {
  const full = { names: ['a', 'b', 'c'], text: 'full sentence about a, b, and c' };
  const partial1 = { names: ['a'], text: 'a note about just a' };
  const partial2 = { names: ['b', 'c'], text: 'a differently-worded note about b and c' };
  assert.deepStrictEqual(g.dedupeGotchaHits([full, partial1, partial2]), [full]);
  // order independence: dedup must not depend on the "complete" hit coming first
  assert.deepStrictEqual(g.dedupeGotchaHits([partial1, full, partial2]), [full]);
});

test('dedupeGotchaHits keeps genuinely independent hits (no subset relationship) and collapses exact duplicates', () => {
  const aOnly = { names: ['a'], text: 'note about a' };
  const bOnly = { names: ['b'], text: 'note about b' };
  assert.deepStrictEqual(g.dedupeGotchaHits([aOnly, bOnly]), [aOnly, bOnly]);

  const dup1 = { names: ['a'], text: 'note about a' };
  const dup2 = { names: ['a'], text: 'note about a' };
  assert.deepStrictEqual(g.dedupeGotchaHits([dup1, dup2]), [dup1]);
});

test('extractDeclaredFieldNames pulls real property names but not incidental type/keyword text', () => {
  const php = 'private int $hallOfFamePoints;\n    #[ORM\\Column(type: \'json\')]\n    private array $appearance;\n';
  const names = g.extractDeclaredFieldNames(php);
  assert.ok(names.has('hallOfFamePoints'));
  assert.ok(names.has('appearance'));
  assert.ok(!names.has('json'), 'a type keyword must not be treated as a declared field name');
  assert.ok(!names.has('ORM'), 'a decorator namespace must not be treated as a declared field name');
});

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

test('runGenerationCall\'s prompt tells the AI to revise, not rewrite, when existing content is present', () => {
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

test('grepLines strips trailing \\r from Windows line endings', () => {
  const content = 'foo bar\r\nmatch this\r\nbaz\r\n';
  const lines = g.grepLines(content, /^match this$/);
  assert.strictEqual(lines.length, 1);
  assert.strictEqual(lines[0], 'match this');
});

test('createIgnoreMatcher correctly splits CRLF line endings and compiles patterns', () => {
  const tmp = fsx.mkdtempSync(pathx.join(osx.tmpdir(), 'icm-crlf-'));
  // Write .gitignore with actual CRLF line endings (test will verify split works correctly).
  // With .split('\n'), lines would contain '\r'; with .split(/\r?\n/), lines are clean.
  fsx.writeFileSync(pathx.join(tmp, '.gitignore'), 'crlf_dist\r\ncrlf_build\r\n', 'utf8');
  // Also test custom ignore file with CRLF
  fsx.mkdirSync(pathx.join(tmp, '.context/_config'), { recursive: true });
  fsx.writeFileSync(pathx.join(tmp, '.context/_config/ignore'), 'crlf_custom\r\n', 'utf8');

  const ignored = g.createIgnoreMatcher({ root: tmp, contextDir: '.context' });

  // Test that patterns from both CRLF-terminated files work correctly.
  // If .split('\n') were used instead of .split(/\r?\n/), the split would leave \r in the lines.
  // Even with trim() protecting it, this test verifies the full pipeline works with CRLF files.
  assert.ok(ignored('crlf_dist'), 'gitignore CRLF pattern should match');
  assert.ok(ignored('crlf_build'), 'gitignore CRLF pattern should match');
  assert.ok(ignored('crlf_custom'), 'custom ignore CRLF pattern should match');
  assert.ok(!ignored('other_file.txt'), 'non-matching file should not be ignored');
});
