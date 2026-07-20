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
  const candidates = [
    [path.join(ctx.root, ctx.appDir, '.env.example'), plain],
    [path.join(ctx.root, ctx.appDir, '.env'), mask],
    [path.join(ctx.root, '.env.example'), plain],
    [path.join(ctx.root, '.env'), mask],
  ];
  for (const [p, fn] of candidates) {
    const c = readText(p);
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

function main() {
  if (parseInt(process.versions.node, 10) < 18) { log.warn('Node >= 18 required.'); process.exit(1); }
  let args;
  try { args = parseArgs(process.argv.slice(2)); }
  catch (e) { console.error(e.message); process.exit(1); }
  log.info(`ICM context generator v${GENERATOR_VERSION} (wiring lands in later tasks)`);
  void args;
}

module.exports = {
  parseArgs, readText, readJson, sha256, exists, isDir, grepLines, extractBlocks, log, GENERATOR_VERSION,
  DEFAULT_IGNORES, compileIgnorePatterns, createIgnoreMatcher, walkFiles, detectStack, detectDevEnv,
  detectDatabases, extractVersions,
  schemaBlock, entitiesBlock, stateBlock, modelsBlock, controllersBlock, servicesBlock, routesBlock,
  migrationsBlock, envBlock, depsBlock, metricsBlock, treeBlock, gitActivityBlock, findOpenApiFile, sectionLabels,
};
if (require.main === module) main();
