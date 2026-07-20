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
