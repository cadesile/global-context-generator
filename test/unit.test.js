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
