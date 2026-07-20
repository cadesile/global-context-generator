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

// ── Ignore engine ────────────────────────────────────────────────────────────
// Supported syntax (v1): comments (#), blank lines, trailing-/ dir patterns,
// leading-/ root anchors, * and ? globs, ** deep globs. Negation (!) is
// unsupported; skipped.
const DEFAULT_IGNORES = [
  'node_modules', 'vendor', '.git', 'dist', 'build', 'out', 'coverage',
  '.next', '.nuxt', 'target', '__pycache__', '.venv', 'venv', 'tmp',
  '.cache', 'Pods', 'DerivedData', 'var',
];

function patternToRegex(pat) {
  const esc = pat
    .replace(/\*\*/g, '__GLOBSTAR__')
    .replace(/\*/g, '__STAR__')
    .replace(/\?/g, '__QUESTION__')
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/__GLOBSTAR__/g, '.*')
    .replace(/__STAR__/g, '[^/]*')
    .replace(/__QUESTION__/g, '[^/]');
  return esc;
}

function compileIgnorePatterns(lines) {
  const matchers = [];
  for (let raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('!')) continue;
    let pat = line.replace(/\/+$/, '');
    pat = pat.replace(/\/\*\*$/, '');
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

function main() {
  if (parseInt(process.versions.node, 10) < 18) { log.warn('Node >= 18 required.'); process.exit(1); }
  let args;
  try { args = parseArgs(process.argv.slice(2)); }
  catch (e) { console.error(e.message); process.exit(1); }
  log.info(`ICM context generator v${GENERATOR_VERSION} (wiring lands in later tasks)`);
  void args;
}

module.exports = { parseArgs, readText, readJson, sha256, exists, isDir, grepLines, extractBlocks, log, GENERATOR_VERSION, DEFAULT_IGNORES, compileIgnorePatterns, createIgnoreMatcher, walkFiles, detectStack, detectDevEnv, detectDatabases, extractVersions };
if (require.main === module) main();
