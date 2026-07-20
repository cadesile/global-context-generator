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

test('envBlock prefers app subdir .env over root .env.example', () => {
  const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'icm-env-'));
  fs.mkdirSync(path.join(tmp, 'app'));
  fs.writeFileSync(path.join(tmp, 'app/.env'), 'APP_SECRET=hidden\n');
  fs.writeFileSync(path.join(tmp, '.env.example'), 'ROOT_VAR=example\n');
  const out = g.envBlock({ root: tmp, appDir: 'app' });
  assert.match(out, /APP_SECRET=\*\*\*/);
  assert.ok(!out.includes('ROOT_VAR'));
});
