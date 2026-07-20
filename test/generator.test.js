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
  assert.strictEqual(m2.parsed_markdown['docs/stable.md'].parsed_at, m1.parsed_markdown['docs/stable.md'].parsed_at);
});
