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

  // Third run, AI still on PATH: unchanged files must be skipped (ledger seam closed) —
  // parsed_at for README.md must NOT change since it's already ai_summarized.
  const readmeParsedAt2 = m.parsed_markdown['README.md'].parsed_at;
  r = spawnSync(process.execPath, [SCRIPT], { cwd: root, encoding: 'utf8', env });
  assert.strictEqual(r.status, 0, r.stderr);
  const m3 = JSON.parse(fs.readFileSync(path.join(ctxDir, '_config/manifest.json'), 'utf8'));
  assert.strictEqual(m3.parsed_markdown['README.md'].parsed_at, readmeParsedAt2);
});

test('no-ai run marks stage 06 as not executed', () => {
  const root = copyFixture('expo-app');
  const r = runGenerator(root, ['--no-ai']);
  assert.strictEqual(r.status, 0, r.stderr);
  const contract = fs.readFileSync(path.join(root, '.context/stages/06_synthesis/CONTEXT.md'), 'utf8');
  assert.match(contract, /not executed/i);
});
