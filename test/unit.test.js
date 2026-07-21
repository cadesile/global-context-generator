'use strict';
const test = require('node:test');
const assert = require('node:assert');
const g = require('../generate_project_context.js');

test('parseArgs defaults', () => {
  const a = g.parseArgs([]);
  assert.deepStrictEqual(a, { useAi: true, aiCli: 'claude', contextDir: '.context', treeDepth: 3, debugDetection: false, dir: '.' });
});

test('parseArgs flags', () => {
  const a = g.parseArgs(['--no-ai', '--ai', 'gemini', '--context-dir', 'ctx', '--depth', '5', '--debug-detection']);
  assert.deepStrictEqual(a, { useAi: false, aiCli: 'gemini', contextDir: 'ctx', treeDepth: 5, debugDetection: true, dir: '.' });
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

test('extractSqlStatements captures a CREATE TABLE in full even when a DEFAULT value contains literal braces', () => {
  const sql = "CREATE TABLE achievements (\n  id TEXT PRIMARY KEY,\n  metadata TEXT NOT NULL DEFAULT '{}'\n);\nCREATE TABLE next_table (\n  id TEXT PRIMARY KEY\n);";
  const out = g.extractSqlStatements(sql, /CREATE TABLE/i);
  assert.match(out, /metadata TEXT NOT NULL DEFAULT '\{\}'\n\);/, 'the closing `);` must survive — brace content must not be mistaken for a block delimiter');
  assert.match(out, /CREATE TABLE next_table/, 'the following statement must still be captured');
});

test('extractSqlStatements handles nested parens (DEFAULT with a function call) without closing early', () => {
  const sql = "CREATE TABLE store_state (\n  key TEXT PRIMARY KEY,\n  updated_at TEXT NOT NULL DEFAULT (datetime('now'))\n);";
  const out = g.extractSqlStatements(sql, /CREATE TABLE/i);
  assert.match(out, /updated_at TEXT NOT NULL DEFAULT \(datetime\('now'\)\)\n\);/);
});

test('extractSqlStatements has no aggregate line cap — a statement far down a long file is captured in full', () => {
  const tables = [];
  for (let i = 0; i < 30; i++) {
    tables.push(`CREATE TABLE pad_${i} (\n  id INTEGER PRIMARY KEY,\n  col_a TEXT NOT NULL,\n  col_b TEXT NOT NULL,\n  col_c TEXT NOT NULL\n);`);
  }
  tables.push('CREATE TABLE last_table (\n  id INTEGER PRIMARY KEY,\n  note TEXT NOT NULL\n);');
  const sql = tables.join('\n');
  assert.ok(sql.split('\n').length > 120, 'fixture must actually exceed the old 120-line aggregate cap to be a meaningful test');
  const out = g.extractSqlStatements(sql, /CREATE TABLE/i);
  assert.match(out, /CREATE TABLE last_table \(\n  id INTEGER PRIMARY KEY,\n  note TEXT NOT NULL\n\);/, 'a statement past the old 120-line budget must still be captured whole, not sliced off');
});

test('hasServerFramework recognizes backend frameworks and rejects bare node/client-only stacks', () => {
  const base = { stacks: { express: false, next: false, fastapi: false, flask: false, django: false, rails: false, go: false } };
  assert.strictEqual(g.hasServerFramework({ ...base, primaryFramework: 'node' }), false, 'bare node (e.g. Expo/React Native) has no server framework');
  assert.strictEqual(g.hasServerFramework({ ...base, primaryFramework: 'symfony' }), true);
  assert.strictEqual(g.hasServerFramework({ ...base, primaryFramework: 'laravel' }), true);
  assert.strictEqual(g.hasServerFramework({ ...base, primaryFramework: 'node', stacks: { ...base.stacks, express: true } }), true);
  assert.strictEqual(g.hasServerFramework({ ...base, primaryFramework: 'nextjs', stacks: { ...base.stacks, next: true } }), true);
});
