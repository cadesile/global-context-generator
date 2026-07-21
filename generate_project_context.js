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
// Commit hash of the generator script itself (not the target project) —
// lets a consuming agent tell exactly which version of the generator's
// extraction logic produced a given .context/ folder.
function generatorCommit() {
  const r = spawnSync('git', ['-C', __dirname, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : 'unknown';
}
const GENERATOR_COMMIT = generatorCommit();

// ── Logging ──────────────────────────────────────────────────────────────────
const log = {
  info:    (m) => process.stderr.write(`\x1b[0;34m▸ ${m}\x1b[0m\n`),
  success: (m) => process.stderr.write(`\x1b[0;32m✓ ${m}\x1b[0m\n`),
  warn:    (m) => process.stderr.write(`\x1b[1;33m⚠ ${m}\x1b[0m\n`),
};

// ── CLI ──────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = { useAi: true, aiCli: 'claude', contextDir: '.context', treeDepth: 3, debugDetection: false, dir: '.' };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--no-ai': args.useAi = false; break;
      case '--ai': args.aiCli = argv[++i]; break;
      case '--context-dir': args.contextDir = argv[++i]; break;
      case '--depth': args.treeDepth = parseInt(argv[++i], 10); if (Number.isNaN(args.treeDepth)) args.treeDepth = 3; break;
      case '--debug-detection': args.debugDetection = true; break;
      case '--dir': args.dir = argv[++i]; break;
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
    // Only promote node to primary if no other language was detected first
    if (d.primaryLang === 'unknown') {
      d.primaryLang = 'node';
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

// ── AI-assisted stack determination ─────────────────────────────────────────
// Scan common backend subdirectory names for framework manifests.
function findCandidateSubDirs(root) {
  const out = [];
  for (const sub of ['backend', 'api', 'server', 'app', 'web', 'application']) {
    if (!isDir(path.join(root, sub))) continue;
    const d = detectStack(root, sub);
    if (d.primaryLang !== 'unknown') out.push({ sub, detection: d });
  }
  return out;
}

// Collect key project files to help AI (or human) decide the primary stack.
function collectStackContext(root, candidates) {
  let out = '';
  const seen = new Set();
  const addFile = (rel) => {
    if (seen.has(rel)) return;
    seen.add(rel);
    const content = readText(path.join(root, rel));
    if (!content) return;
    out += `### ${rel}\n\`\`\`\n${content.slice(0, 2000)}\n\`\`\`\n\n`;
  };
  for (const f of ['CLAUDE.md', 'AGENTS.md', '.claude/CLAUDE.md', 'README.md']) addFile(f);
  for (const f of ['composer.json', 'package.json']) addFile(f);
  for (const { sub } of candidates) {
    for (const f of ['composer.json', 'package.json']) addFile(path.posix.join(sub, f));
  }
  return out || '(no key context files found at root)';
}

// Ask AI to resolve which stack is primary when multiple are detected.
function aiDetermineStack(root, rootDetection, candidates, aiCli) {
  const context = collectStackContext(root, candidates);
  const rootInfo = rootDetection.primaryLang !== 'unknown'
    ? `Root: ${rootDetection.primaryFramework} (${rootDetection.primaryLang})`
    : 'Root: no framework detected';
  const subInfo = candidates.length
    ? `Subdirectories with detected frameworks:\n${candidates.map((c) => `- ${c.sub}/ → ${c.detection.primaryFramework} (${c.detection.primaryLang})`).join('\n')}`
    : 'No framework found in common subdirectories.';

  const result = callAi(aiCli, `You are configuring a code context generator. Determine the PRIMARY backend/application stack for this project.

Detection results:
${rootInfo}
${subInfo}

Key project files (truncated):
${context}

Identify the primary application stack (not build tools or frontend-only packages).
Respond in exactly this format — no other text:
STACK: <framework-name>
APPDIR: <relative-path-or-dot>`);

  if (!result) return null;
  const stackMatch = result.match(/^STACK:\s*(.+)$/m);
  const appdirMatch = result.match(/^APPDIR:\s*(.+)$/m);
  if (!stackMatch || !appdirMatch) return null;
  return { framework: stackMatch[1].trim().toLowerCase(), appDir: appdirMatch[1].trim() };
}

// Orchestrate full stack determination: auto-detect → AI → TTY prompt.
async function determineAppStack(root, ai, args) {
  const rootDetection = detectStack(root);
  const candidates = findCandidateSubDirs(root);

  // Unambiguous: root has a stack, no competing backend subdirs
  if (rootDetection.primaryLang !== 'unknown' && candidates.length === 0) {
    return { detection: rootDetection, appDir: '.' };
  }

  // Unambiguous: root has nothing, exactly one backend subdir detected
  if (rootDetection.primaryLang === 'unknown' && candidates.length === 1) {
    return { detection: candidates[0].detection, appDir: candidates[0].sub };
  }

  // Ambiguous (root + subdir both have stacks, or multiple subdirs, or nothing found):
  // use AI to read CLAUDE.md + manifests and decide.
  if (ai.useAi) {
    log.info(`Calling ${args.aiCli} — determining primary tech stack...`);
    const aiResult = aiDetermineStack(root, rootDetection, candidates, args.aiCli);
    if (aiResult) {
      const sub = aiResult.appDir === '.' ? '' : aiResult.appDir;
      const d = (sub && isDir(path.join(root, sub))) ? detectStack(root, sub) : detectStack(root);
      if (d.primaryLang !== 'unknown') return { detection: d, appDir: sub || '.' };
    }
  }

  // TTY fallback: ask the user
  if (process.stdin.isTTY) {
    const readline = require('node:readline/promises');
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    const sub = (await rl.question('  App code in a subdirectory? Enter path (or press Enter to skip): ')).trim();
    rl.close();
    if (sub && isDir(path.join(root, sub))) {
      const d = detectStack(root, sub);
      if (d.primaryLang !== 'unknown') return { detection: d, appDir: sub };
    }
  }

  // Last resort: best candidate or root
  if (candidates.length > 0) return { detection: candidates[0].detection, appDir: candidates[0].sub };
  return { detection: rootDetection, appDir: '.' };
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
    // Strip comment lines to avoid false positives from commented-out examples (e.g. Symfony's default .env)
    const lc = content.split('\n').filter((l) => !l.trimStart().startsWith('#')).join('\n').toLowerCase();
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

// Select the N most recent files by filename, not by full relative path.
// Migration filenames encode a sortable timestamp/sequence (e.g. Doctrine's
// VersionYYYYMMDDHHMMSS, Laravel's YYYY_MM_DD_HHMMSS_name); the directory
// they live in does not. Sorting by full path (as walkFiles/filesUnder do,
// for stable tree-order output elsewhere) means an archived/legacy
// subdirectory whose name sorts after the siblings (e.g. "archive/",
// "old/") pushes stale files to the end of the list, displacing genuinely
// recent ones. Sorting by basename avoids that.
function latestByBasename(files, n) {
  return [...files].sort((a, b) => path.basename(a).localeCompare(path.basename(b))).slice(-n);
}

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
  const migs = latestByBasename(filesUnder(ctx, path.posix.join(ctx.appDir === '.' ? '' : ctx.appDir, 'migrations'), '.php'), 10);
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
  const migs = latestByBasename(filesUnder(ctx, path.posix.join(ctx.appDir === '.' ? '' : ctx.appDir, 'database/migrations'), '.php'), 10);
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
  if (s.symfony) return _schemaDoctrine(ctx);
  if (s.laravel) return _schemaLaravel(ctx);
  if (s.django) return _schemaDjango(ctx);
  if (s.rails) return _schemaRails(ctx);
  if (s.go) return _schemaGo(ctx);
  if (s.node) return _schemaSqlite(ctx);
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
  if (s.symfony) return _entitiesDoctrine(ctx);
  if (s.laravel) return _entitiesEloquent(ctx);
  if (s.django) return _entitiesDjango(ctx);
  if (s.rails) return _entitiesRails(ctx);
  if (s.go) return _schemaGo(ctx);
  if (s.node) return _entitiesTypescript(ctx);
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

// ── Routes (bash lines 457–471) ──────────────────────────────────────────────
// Symfony/Laravel routes are best extracted live (`bin/console debug:router`,
// `php artisan route:list`) since that reflects the resolved route table
// exactly. But that requires a booted app/container, which isn't available
// at generation time in CI or when the dev container isn't running. Rather
// than degrade to a "go run this yourself" placeholder — useless to an agent
// that can't necessarily start the container — fall back to a static regex
// scan over controller/route-definition files so routes.md always has
// *something* extracted.
function _routesSymfonyStatic(ctx) {
  const files = filesUnder(ctx, ctx.detection.controllersDir, '.php');
  const rows = [];
  for (const f of files) {
    const content = readText(path.join(ctx.root, f)) || '';
    const classMatch = content.match(/#\[Route\(([^)]*)\)\]\s*\n(?:\s*#\[[^\]]*\]\s*\n)*\s*(?:final\s+|abstract\s+)*class\s+(\w+)/);
    const classAttrs = classMatch ? classMatch[1] : '';
    const classPath = (classAttrs.match(/^\s*['"]([^'"]*)['"]/) || classAttrs.match(/path:\s*['"]([^'"]*)['"]/) || [])[1] || '';
    const re = /#\[Route\(([^)]*)\)\]\s*\n(?:\s*#\[[^\]]*\]\s*\n)*\s*public function (\w+)/g;
    let m;
    while ((m = re.exec(content))) {
      const attrs = m[1];
      const routePath = (attrs.match(/^\s*['"]([^'"]*)['"]/) || attrs.match(/path:\s*['"]([^'"]*)['"]/) || [])[1] || '';
      const methods = ((attrs.match(/methods:\s*\[([^\]]*)\]/) || [])[1] || '').replace(/['"]/g, '').trim() || 'ANY';
      rows.push({ methods, path: (classPath + routePath) || '/', target: `${path.basename(f, '.php')}::${m[2]}` });
    }
  }
  if (!rows.length) return '';
  return '_Extracted via static scan of `#[Route(...)]` attributes — run `bin/console debug:router` for the live, resolved route table._\n\n'
    + '| Method | Path | Controller#action |\n|---|---|---|\n'
    + rows.map((r) => `| ${r.methods} | \`${r.path}\` | \`${r.target}\` |`).join('\n') + '\n';
}
function _routesLaravelStatic(ctx) {
  const routesDir = path.posix.join(ctx.appDir === '.' ? '' : ctx.appDir, 'routes');
  const files = filesUnder(ctx, routesDir, '.php');
  const lines = files.flatMap((f) => grepLines(readText(path.join(ctx.root, f)) || '',
    /Route::(get|post|put|delete|patch|match|resource|apiResource|group)\(/, 200));
  if (!lines.length) return '';
  return '_Extracted via static scan of `Route::` calls in `routes/` — run `php artisan route:list` for the live, resolved route table._\n\n'
    + codeFence('php', lines.slice(0, 60).join('\n'));
}
function routesBlock(ctx) {
  const d = ctx.detection;
  if (d.primaryFramework === 'symfony') {
    return _routesSymfonyStatic(ctx) || 'No `#[Route(...)]` attributes found via static scan (and `bin/console debug:router` was not run).\n';
  }
  if (d.primaryFramework === 'laravel') {
    return _routesLaravelStatic(ctx) || 'No `Route::` definitions found via static scan of `routes/` (and `php artisan route:list` was not run).\n';
  }
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
  for (const f of latestByBasename(files, 10)) {
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
// ── AI instruction file updater ───────────────────────────────────────────────
const CONTEXT_SENTINEL_START = '<!-- context-generator: start -->';
const CONTEXT_SENTINEL_END = '<!-- context-generator: end -->';
// Known AI agent instruction files, checked in priority order.
const AI_INSTRUCTION_FILES = ['CLAUDE.md', '.claude/CLAUDE.md', 'AGENTS.md', 'GEMINI.md'];

function buildContextBlock(contextDir) {
  return [
    CONTEXT_SENTINEL_START,
    '## Project Context',
    '',
    `This project has a structured \`${contextDir}/\` folder for AI agent context (ICM format).`,
    `**Read \`${contextDir}/CONTEXT.md\` first** — it is the stage router that tells you which output`,
    'files are relevant to your task. Do not load the entire folder; use the router to scope what you read.',
    '',
    `Regenerate with: \`node generate_project_context.js\``,
    CONTEXT_SENTINEL_END,
  ].join('\n');
}

function injectContextReference(filePath, contextDir) {
  const block = buildContextBlock(contextDir);
  const existing = readText(filePath);

  if (existing === null) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, block + '\n');
    return 'created';
  }

  // Replace existing sentinel block in-place
  if (existing.includes(CONTEXT_SENTINEL_START)) {
    const updated = existing.replace(
      new RegExp(`${CONTEXT_SENTINEL_START}[\\s\\S]*?${CONTEXT_SENTINEL_END}`),
      block,
    );
    if (updated === existing) return 'unchanged';
    fs.writeFileSync(filePath, updated);
    return 'updated';
  }

  // Insert after the first H1 heading (and any blank lines that follow it),
  // or prepend to the file if there is no H1.
  const lines = existing.split('\n');
  const h1Idx = lines.findIndex((l) => /^# /.test(l));
  let insertAt = 0;
  if (h1Idx !== -1) {
    insertAt = h1Idx + 1;
    while (insertAt < lines.length && lines[insertAt].trim() === '') insertAt++;
  }
  lines.splice(insertAt, 0, '', block, '');
  fs.writeFileSync(filePath, lines.join('\n'));
  return 'injected';
}

function updateAiInstructionFiles(root, contextDir) {
  const results = [];
  for (const rel of AI_INSTRUCTION_FILES) {
    const abs = path.join(root, rel);
    if (!exists(abs)) continue;
    const result = injectContextReference(abs, contextDir);
    results.push({ rel, result });
  }
  // No AI instruction file found — create CLAUDE.md so agents always have the pointer
  if (results.length === 0) {
    const abs = path.join(root, 'CLAUDE.md');
    const result = injectContextReference(abs, contextDir);
    results.push({ rel: 'CLAUDE.md', result });
  }
  return results;
}

// ── AI integration (port of bash lines 58–69, 71–84, 311–339, 368–437) ──────
function checkAiAvailable(args) {
  if (!args.useAi) return { useAi: false, reason: '--no-ai' };
  if (process.env.CLAUDECODE && args.aiCli === 'claude') {
    return { useAi: false, reason: 'Running inside a Claude Code session — AI summaries skipped (nested sessions not supported).' };
  }
  const which = spawnSync('which', [args.aiCli], { encoding: 'utf8' });
  if (which.status !== 0 || !which.stdout || !which.stdout.trim()) {
    return { useAi: false, reason: `${args.aiCli} CLI not found — AI summaries skipped. Install ${args.aiCli} to enable.` };
  }
  return { useAi: true, reason: `${args.aiCli} CLI detected — AI summaries enabled.` };
}

// Every AI-generated stage goes through callAi(), and none of them asked the
// model to emit anything but the requested output shape — so a line of
// self-referential/routing scratch talk ("This is a plain content-generation
// task ... no skill applies here.") leaking in front of the real content is a
// systemic risk at this one chokepoint, not a one-off prompt hiccup. Strip it
// here so every call site (overview, architecture notes, focus, stack
// determination, OpenAPI summary, per-doc summaries) is covered uniformly,
// rather than patching each prompt individually.
const MODEL_PREAMBLE_RES = [
  /^this is (?:a|an|not)\b[^.!?\n]*\b(?:task|skill)\b[^.!?\n]*[.!?]+\s*/i,
  /^no skill applies[^.!?\n]*[.!?]+\s*/i,
  /^(?:i(?:'ll| will| am going to| need to)|let me)\b[^.!?\n]*[.!?]+\s*/i,
  /^as an ai\b[^.!?\n]*[.!?]+\s*/i,
];
function stripModelPreamble(text) {
  if (!text) return text;
  let out = text;
  let changed = true;
  while (changed) {
    changed = false;
    for (const re of MODEL_PREAMBLE_RES) {
      const m = out.match(re);
      if (m) { out = out.slice(m[0].length); changed = true; }
    }
  }
  return out.replace(/^\s+/, '');
}

function callAi(aiCli, prompt) {
  try {
    const r = spawnSync(aiCli, ['-p', prompt], { encoding: 'utf8', timeout: 120000 });
    const out = (r.stdout || '').trim();
    if (r.error || r.status !== 0 || !out) {
      log.warn(`${aiCli} returned empty for: ${prompt.slice(0, 60)}...`);
      return '';
    }
    return stripModelPreamble(out);
  } catch (e) {
    log.warn(`${aiCli} failed: ${e.message}`);
    return '';
  }
}

// Priority order for the knowledge-gaps review input: domain/interface
// stages first (schema, entities, routes, services — the densest source of
// real business-logic gaps), then the rest, filling whatever budget remains.
const REVIEW_STAGE_PRIORITY = ['03_data', '04_interfaces', '01_overview', '02_architecture', '05_documentation', '06_synthesis'];

function collectReviewContext(root, contextDir, stageIndex, budget = 12000) {
  const byStage = new Map(stageIndex.map((s) => [s.stage, s]));
  let out = '';
  for (const stageName of REVIEW_STAGE_PRIORITY) {
    const entry = byStage.get(stageName);
    if (!entry) continue;
    for (const f of entry.files || []) {
      if (out.length >= budget) break;
      const abs = path.join(root, contextDir, 'stages', stageName, f.rel);
      const content = readText(abs);
      if (!content) continue;
      const remaining = budget - out.length;
      out += `### ${stageName}/${f.rel}\n${content.slice(0, remaining)}\n\n`;
    }
  }
  const extractionRows = buildExtractionRows(stageIndex);
  if (extractionRows.length) {
    out += `### Extraction provenance\n\n| Output | Method |\n|---|---|\n${extractionRows.join('\n')}\n`;
  }
  return out;
}

// Port of bash lines 311–339: sample key project files into a char-budgeted block.
function collectAiContextFiles(ctx) {
  let out = '';
  let charsUsed = 0;
  const budget = 6000;
  const appPrefix = (f) => path.posix.join(ctx.appDir === '.' ? '' : ctx.appDir, f);
  const addFile = (rel) => {
    if (charsUsed >= budget) return;
    const abs = path.join(ctx.root, rel);
    if (!exists(abs) || isDir(abs)) return;
    let content;
    try { content = fs.readFileSync(abs, 'utf8').slice(0, 800); } catch { return; }
    out += `### ${rel}\n\`\`\`\n${content}\n\`\`\`\n\n`;
    charsUsed += content.length;
  };
  for (const f of ['composer.json', 'package.json', 'go.mod', 'Cargo.toml', 'Gemfile', 'requirements.txt', 'pyproject.toml']) {
    addFile(appPrefix(f));
  }
  addFile(appPrefix('config/packages/security.yaml'));
  // Always include root-level context docs (README, CLAUDE.md, AGENTS.md) regardless of appDir
  for (const f of ['README.md', 'CLAUDE.md', 'AGENTS.md', '.claude/CLAUDE.md']) addFile(f);
  const envRel = appPrefix('.env');
  const envContent = readText(path.join(ctx.root, envRel));
  if (envContent !== null) {
    const masked = envContent.split('\n').filter((l) => l && !l.startsWith('#')).map((l) => l.replace(/=.*/, '=***')).join('\n');
    out += `### ${envRel} (masked)\n\`\`\`\n${masked}\n\`\`\`\n\n`;
  }
  if (ctx.detection.modelsDir) {
    for (const f of filesUnder(ctx, ctx.detection.modelsDir, '.' + ctx.detection.primaryExt).slice(0, 6)) addFile(f);
  }
  if (ctx.detection.controllersDir) {
    for (const f of filesUnder(ctx, ctx.detection.controllersDir, '.' + ctx.detection.primaryExt).filter((f) => !f.includes('/Admin/')).slice(0, 4)) addFile(f);
  }
  return out;
}

function makeAiSummarizer(ctx) {
  return (rel, content) => callAi(ctx.aiCli, `Summarize this project documentation file for an AI coding agent. File: ${rel}. Content (truncated to 6000 chars): ${content.slice(0, 6000)}. Write 2-4 sentences covering what the doc describes and when an agent should read it. Output only the summary.`);
}

// basename lists for the architecture-notes prompt (bash lines 385–390).
function _basenameList(ctx, dir) {
  if (!dir) return 'none';
  const files = filesUnder(ctx, dir, '.' + ctx.detection.primaryExt);
  if (!files.length) return 'none';
  return files.map((f) => path.basename(f, '.' + ctx.detection.primaryExt)).sort().join(', ');
}
function _sourceDirList(ctx) {
  const sourceDir = ctx.detection.sourceDir || '.';
  const base = path.join(ctx.root, sourceDir);
  if (!isDir(base)) return '';
  const dirs = [sourceDir];
  (function recur(relFromSource) {
    const abs = relFromSource ? path.join(base, relFromSource) : base;
    let entries;
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const e of entries.filter((x) => x.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
      const childRel = relFromSource ? `${relFromSource}/${e.name}` : e.name;
      const fullRel = path.posix.join(sourceDir, childRel);
      if (ctx.ignoreFn(fullRel)) continue;
      dirs.push(fullRel);
      recur(childRel);
    }
  })('');
  return dirs.sort().slice(0, 30).join('\n');
}

// ── Domain notes: merge hand-written docs into raw extraction (03/04) ───────
// Static extraction gives field lists and method signatures but nothing about
// *why* they exist — a business rule like "hallOfFamePoints never decreases,
// uses max(current, incoming)" isn't derivable from the field's declaration.
// If the repo has a hand-maintained CLAUDE.md/AGENTS.md/README with a "Key
// Entities" / "Key Services" / "Key Controllers" section (common in real
// projects — usually as a markdown table, sometimes a bullet list) and/or a
// "Key Gotchas" section with per-field business rules, parse both and attach
// them next to the matching dumped entity/service/field instead of leaving
// 03/04 mute about intent. Parsed directly and deterministically (not via the
// AI summarizer) so it works even with --no-ai and doesn't depend on stage
// 05's AI step having run first.
//
// This runs uniformly, not best-effort: every name the static extractors
// dump gets checked against the parsed notes and gets *some* line — either
// the note found, or an explicit "no hand-written notes found" — so an agent
// can tell a confirmed absence from an artifact of a partial merge pass.
const DOMAIN_NOTE_HEADING_RE = /^key (entities|models|services|controllers)\b/i;
const DOMAIN_GOTCHA_HEADING_RE = /^key (gotchas|notes|business rules)\b/i;
const DOMAIN_NOTE_BULLET_RE = /^[-*]\s*(?:`([^`]+)`|\*\*([^*]+)\*\*|([A-Z]\w*))\s*[:—-]\s*(.+)$/;
const DOMAIN_NOTE_TABLE_SEP_RE = /^\|?[\s:|-]+\|?$/;

// Parse a buffered run of consecutive `| ... |` table lines into {name, desc}
// pairs, skipping the header row (the row immediately before the `|---|---|`
// separator) when a separator is present.
function parseDomainNoteTable(lines) {
  const sepIdx = lines.findIndex((l) => DOMAIN_NOTE_TABLE_SEP_RE.test(l.trim()) && l.includes('-'));
  const dataLines = sepIdx === -1 ? lines : lines.slice(sepIdx + 1);
  const out = [];
  for (const line of dataLines) {
    const cells = line.split('|').map((c) => c.trim()).filter((c) => c !== '');
    if (cells.length < 2) continue;
    const name = cells[0].replace(/`/g, '').trim();
    const desc = cells[cells.length - 1].trim();
    if (/^[A-Za-z_]\w*$/.test(name) && desc) out.push({ name, desc });
  }
  return out;
}

function extractDomainNotes(ctx) {
  const notes = { entities: {}, services: {} };
  const gotchas = []; // { names: string[], text }
  for (const rel of [...AI_INSTRUCTION_FILES, 'README.md']) {
    const content = readText(path.join(ctx.root, rel));
    if (!content) continue;
    let section = null; // 'entities' | 'services' | 'gotchas' | null
    let tableBuf = [];
    const flushTable = () => {
      if (!tableBuf.length || section === 'gotchas' || !section) { tableBuf = []; return; }
      for (const { name, desc } of parseDomainNoteTable(tableBuf)) {
        if (!notes[section][name]) notes[section][name] = desc;
      }
      tableBuf = [];
    };
    for (const line of content.split('\n')) {
      const isTableRow = /^\s*\|.*\|\s*$/.test(line);
      if (!isTableRow) flushTable();

      const h = line.match(/^(#{1,6})\s*(.+)$/);
      if (h) {
        const title = h[2].toLowerCase();
        const kind = (title.match(DOMAIN_NOTE_HEADING_RE) || [])[1];
        if (kind) { section = (kind === 'services' || kind === 'controllers') ? 'services' : 'entities'; }
        else if (DOMAIN_GOTCHA_HEADING_RE.test(title)) { section = 'gotchas'; }
        else { section = null; } // any other heading ends whatever section we were in — avoids
                                  // mis-attributing content across sections based on heading depth
        continue;
      }
      if (!section) continue;

      if (isTableRow) { tableBuf.push(line); continue; }

      if (section === 'gotchas') {
        const names = [...line.matchAll(/`([A-Za-z_]\w*)`/g)].map((m) => m[1]);
        const text = line.replace(/^[-*]\s*/, '').trim();
        if (names.length && text) gotchas.push({ names, text });
        continue;
      }

      const m = line.match(DOMAIN_NOTE_BULLET_RE);
      if (!m) continue;
      const name = m[1] || m[2] || m[3];
      const desc = m[4].trim();
      if (name && desc && !notes[section][name]) notes[section][name] = desc;
    }
    flushTable();
  }
  return { ...notes, gotchas };
}

// Insert a note right after each `#### \`Name\`` heading the raw extractors
// emit (see fileSection()), for *every* such heading — either the matching
// domain note, or an explicit "none found" so absence reads as confirmed.
// Also scans each entity's dumped field/property lines for gotchas whose
// name matches a field declared in that same block, and attaches those
// immediately after the code fence — closer to the specific field they
// govern, not just the class as a whole.
function annotateWithDomainNotes(md, notes, gotchas = []) {
  if (!md) return md;
  const lines = md.split('\n');
  const out = [];
  let currentName = null;
  let inFence = false;
  let fenceBuf = [];
  const flushFence = () => {
    if (!currentName || !fenceBuf.length) return;
    const fenceText = fenceBuf.join('\n');
    const hits = gotchas.filter((g) => g.names.some((n) => new RegExp(`[$]?\\b${n}\\b`).test(fenceText)));
    for (const hit of hits) out.push('', `> **Field note:** ${hit.text}`);
    fenceBuf = [];
  };
  for (const line of lines) {
    const headingMatch = line.match(/^#### `([^`]+)`$/);
    if (headingMatch) {
      flushFence();
      currentName = headingMatch[1];
      out.push(line, '');
      out.push(notes && notes[currentName]
        ? `> **Purpose:** ${notes[currentName]}`
        : '> _No hand-written notes found in CLAUDE.md/AGENTS.md/README.md for this name._');
      continue;
    }
    if (/^```/.test(line.trim())) {
      inFence = !inFence;
      out.push(line);
      if (!inFence) flushFence();
      continue;
    }
    if (inFence) fenceBuf.push(line);
    out.push(line);
  }
  flushFence();
  return out.join('\n');
}

function sectionLabels(detection, dbHints) {
  const s = detection.stacks; const db = dbHints || 'SQL';
  if (s.symfony) return { schema: `Database Schema (Doctrine / ${db})`, entities: 'Doctrine Entity Definitions', state: '' };
  if (s.laravel) return { schema: `Database Schema (Eloquent / ${db})`, entities: 'Eloquent Model Definitions', state: '' };
  if (s.django) return { schema: `Database Schema (Django ORM / ${db})`, entities: 'Django Model Definitions', state: '' };
  if (s.rails) return { schema: `Database Schema (ActiveRecord / ${db})`, entities: 'ActiveRecord Model Definitions', state: '' };
  if (s.go) return { schema: 'Database Schema (Go structs)', entities: 'Go Type Definitions', state: '' };
  if (s.node) return { schema: `Database Schema (${db || 'SQLite'})`, entities: 'TypeScript Entity Definitions', state: 'Store Shapes (State)' };
  return { schema: 'Database Schema', entities: 'Entity Definitions', state: '' };
}

// ── ICM stage writers ────────────────────────────────────────────────────────
function writeStage(root, contextDir, stageName, contract, outputs) {
  const stageDir = path.join(root, contextDir, 'stages', stageName);
  const outDir = path.join(stageDir, 'output');
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  const written = [];
  for (const [file, content] of Object.entries(outputs)) {
    if (!content || !content.trim()) continue;
    const outPath = path.join(outDir, file);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, content.trimEnd() + '\n');
    written.push(file);
  }
  const contractMd = [
    `# Stage ${stageName}`, '',
    '## Inputs', ...contract.inputs.map((i) => `- ${i}`), '',
    '## Process', contract.process, '',
    '## Outputs',
    ...contract.outputs.filter((o) => written.includes(o.file) || (o.file.endsWith('/') && written.some((w) => w.startsWith(o.file)))).map((o) => `- output/${o.file} — ${o.desc}`),
    ...(written.length === 0 ? ['- _No outputs produced (see Process notes)._'] : []),
  ].join('\n') + '\n';
  fs.writeFileSync(path.join(stageDir, 'CONTEXT.md'), contractMd);
  return written;
}

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
  return { version: 1, generated_at: '', generator_version: GENERATOR_VERSION, generator_commit: GENERATOR_COMMIT, project: { name: repoName, stack: '' }, parsed_markdown: {}, stages: {} };
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

  const upLevels = ctx.contextDir.split('/').filter(Boolean).length + 3;
  const linkPrefix = '../'.repeat(upLevels);

  let indexMd = '# Documentation Index\n';
  let prevDir = null;
  for (const rel of mdFiles) {
    const dir = path.posix.dirname(rel);
    if (dir !== prevDir) { indexMd += `\n**${dir === '.' ? '(root)' : dir + '/'}**\n`; prevDir = dir; }
    const entry = parsedMarkdown[rel];
    const slugFile = path.posix.basename(entry.summary);
    indexMd += `- [${rel}](${linkPrefix}${rel}) — [digest](summaries/${slugFile})\n`;
  }
  return { indexMd, summaries, parsedMarkdown, stats };
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
  const domainNotes = extractDomainNotes(ctx);
  const openApiFile = findOpenApiFile(ctx);
  const openApiRaw = ctx.aiOpenApi
    ? ctx.aiOpenApi
    : openApiFile ? `> Source: \`${openApiFile}\`\n\n` + codeFence('', (readText(path.join(ctx.root, openApiFile)) || '').slice(0, 4000)) : '';
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
    (() => {
      const schemaContent = schemaBlock(ctx);
      const entitiesContent = entitiesBlock(ctx);
      const migrationsContent = migrationsBlock(ctx);
      return { name: '03_data',
        contract: { inputs: [`source: ${ctx.detection.modelsDir || 'model files'}`, 'source: migrations / schema files'],
          process: `Extracted the data layer for ${ctx.detection.primaryFramework}: schema, entity definitions${labels.state ? ', store shapes' : ''}, and migrations.`,
          outputs: [{ file: 'schema.md', desc: labels.schema }, { file: 'entities.md', desc: labels.entities }, { file: 'state.md', desc: labels.state || 'store shapes' }, { file: 'migrations.md', desc: 'latest migrations' }] },
        outputs: {
          'schema.md': `# ${labels.schema}\n\n${schemaContent}`,
          'entities.md': `# ${labels.entities}\n\n${annotateWithDomainNotes(entitiesContent, domainNotes.entities, domainNotes.gotchas)}`,
          'state.md': labels.state ? `# ${labels.state}\n\n${stateBlock(ctx)}` : '',
          'migrations.md': `# Migrations\n\n${migrationsContent}`,
        },
        extraction: {
          'schema.md': staticScanMethod(schemaContent),
          'entities.md': staticScanMethod(entitiesContent),
          'migrations.md': staticScanMethod(migrationsContent),
        } };
    })(),
    (() => {
      const routesContent = routesBlock(ctx);
      const controllersContent = controllersBlock(ctx);
      const servicesContent = servicesBlock(ctx);
      return { name: '04_interfaces',
        contract: { inputs: [`source: ${ctx.detection.controllersDir || 'controller files'}`, `source: ${ctx.detection.servicesDir || 'service files'}`, openApiFile ? `source: ${openApiFile}` : 'source: (no OpenAPI spec found)'],
          process: 'Extracted API routes, controller and service signatures, and the OpenAPI spec if present.',
          outputs: [{ file: 'routes.md', desc: 'API routes' }, { file: 'controllers.md', desc: 'controller signatures' }, { file: 'services.md', desc: 'service signatures' }, { file: 'api-spec.md', desc: 'OpenAPI/Swagger spec' }] },
        outputs: {
          'routes.md': routesContent ? `# API Routes\n\n${routesContent}` : '',
          'controllers.md': controllersContent ? `# Controllers\n\n${annotateWithDomainNotes(controllersContent, domainNotes.services)}` : '',
          'services.md': servicesContent ? `# Services\n\n${annotateWithDomainNotes(servicesContent, domainNotes.services)}` : '',
          'api-spec.md': openApiRaw ? `# API Specification\n\n${openApiRaw}` : '',
        },
        extraction: {
          'routes.md': routesMethod(ctx, routesContent),
          'controllers.md': staticScanMethod(controllersContent),
          'services.md': staticScanMethod(servicesContent),
          'api-spec.md': openApiRaw ? (ctx.aiOpenApi ? 'ai-summarized-openapi-spec' : 'raw-openapi-spec-excerpt') : 'unavailable',
        } };
    })(),
  ];
}
// Provenance labels for CONTEXT.md/manifest.json (see extraction map above):
// lets a consuming agent tell how much to trust a section without guessing.
function staticScanMethod(content) { return content && content.trim() ? 'static-regex-scan' : 'unavailable (no scanner for this stack, or nothing matched)'; }
function routesMethod(ctx, content) {
  const d = ctx.detection;
  if (d.primaryFramework === 'symfony' || d.primaryFramework === 'laravel') {
    return content && content.includes('static scan')
      ? 'static-regex-fallback (live debug:router/route:list not attempted by this generator)'
      : 'unavailable (static scan found nothing; live debug:router/route:list not attempted)';
  }
  return staticScanMethod(content);
}

// Shared by writeRouter() and collectReviewContext() (Task 2) — one row per
// stage output whose extraction method was recorded (see buildStages01to04()).
function buildExtractionRows(stageIndex) {
  return stageIndex
    .filter((s) => s.extraction && Object.keys(s.extraction).length)
    .flatMap((s) => Object.entries(s.extraction).map(([file, method]) => `| \`${s.stage}/${file}\` | ${method} |`));
}

function writeRouter(root, contextDir, { repoName, label, stageIndex, hasKnowledgeGaps }) {
  const rows = stageIndex.map(({ stage, purpose, files }) =>
    `| \`stages/${stage}/\` | ${purpose} | ${files.map((f) => `\`${f.rel}\` (${f.bytes}b)`).join(', ') || '—'} |`).join('\n');
  const extractionRows = buildExtractionRows(stageIndex).join('\n');
  const gapsNote = hasKnowledgeGaps
    ? "\nUnresolved: see `KNOWLEDGE_GAPS.md` for open questions this generation run couldn't answer from the code alone.\n"
    : '';
  const md = `# ${repoName} — Project Context (.context)

> Generated: ${new Date().toISOString()} · Stack: ${label} · Generator: v${GENERATOR_VERSION} (${GENERATOR_COMMIT})

This folder is an **ICM (Interpretable Context Methodology)** context structure
(https://arxiv.org/html/2603.16021v2): numbered stages, each with a CONTEXT.md
contract (Inputs / Process / Outputs) and an output/ folder of focused markdown.

## How to use this folder (for agents)

1. Read this router.
2. Pick the stages relevant to your task from the index below (numbering = recommended reading order).
3. Read each chosen stage's CONTEXT.md, then load only the output files you need.
4. Do not load every file — the structure exists so you can scope your context.
5. Check the extraction provenance table below before trusting a section — some
   outputs come from a static best-effort scan rather than a live, resolved
   source, and that changes how much weight to give them.
${gapsNote}
Regenerate with: \`node generate_project_context.js\`. Ignore rules live in
\`_config/ignore\`; the parse ledger and per-stage extraction provenance in
\`_config/manifest.json\`.

## Stage index

| Stage | Purpose | Output files |
|---|---|---|
${rows}
${extractionRows ? `\n## Extraction provenance\n\n| Output | Method |\n|---|---|\n${extractionRows}\n` : ''}`;
  fs.writeFileSync(path.join(root, contextDir, 'CONTEXT.md'), md);
}

async function main() {
  if (parseInt(process.versions.node, 10) < 18) { log.warn('Node >= 18 required.'); process.exit(1); }
  let args;
  try { args = parseArgs(process.argv.slice(2)); }
  catch (e) { console.error(e.message); process.exit(1); }
  const root = path.resolve(args.dir ?? '.');
  if (!isDir(root)) { console.error(`Directory not found: ${args.dir}`); process.exit(1); }
  const repoName = path.basename(root);
  // Phase 1: AI availability — needed for stack determination below.
  const ai = checkAiAvailable(args);
  if (!ai.useAi && args.useAi) log.info(ai.reason);
  // Phase 2: Determine tech stack (AI-assisted when ambiguous, then TTY, then heuristics).
  const { detection, appDir } = await determineAppStack(root, ai, args);
  // Phase 3: Environment, DB hints, versions — all depend on the resolved stack + appDir.
  const devEnv = detectDevEnv(root, detection);
  const dbHints = detectDatabases(root, appDir);
  const versions = extractVersions(root, appDir, detection);
  if (args.debugDetection) { console.log(JSON.stringify({ repoName, detection, devEnv, dbHints, versions, useAi: ai.useAi }, null, 2)); return; }
  // All filesystem writes happen after the debug-detection early-return above,
  // so --debug-detection stays strictly read-only.
  // Phase 4: Ignore rules — set up after stack is known.
  seedIgnoreFile(root, args.contextDir);
  const ignoreFn = createIgnoreMatcher({ root, contextDir: args.contextDir });
  const ctx = { root, appDir, detection, devEnv, dbHints, versions, ignoreFn, treeDepth: args.treeDepth, contextDir: args.contextDir, useAi: ai.useAi, aiCli: args.aiCli, repoName };

  // OpenAPI AI summary must be computed before buildStages01to04() so stage 04's
  // api-spec.md can use it (bash lines 412–437).
  if (ai.useAi) {
    const openApiFile = findOpenApiFile(ctx);
    if (openApiFile) {
      log.info(`Calling ${args.aiCli} — analysing OpenAPI spec (${openApiFile})...`);
      const specContent = (readText(path.join(root, openApiFile)) || '').slice(0, 8000);
      const result = callAi(args.aiCli, `You are documenting a REST API from its OpenAPI/Swagger specification.

Spec file: ${openApiFile}
Contents (truncated to 8000 chars):
${specContent}

Produce a concise API reference in this exact format:

### Overview
One paragraph summarising the API's purpose, version, and base URL if present.

### Authentication
How the API is secured (bearer token, API key, OAuth, etc.), or 'None specified' if absent.

### Endpoints
A markdown table with columns: Method | Path | Summary
List every endpoint found. Group by tag/resource if tags are present.

### Key Schemas
Bullet list of the most important request/response schemas with their key fields.

Output only the above sections — no preamble, no trailing commentary.`);
      if (result) ctx.aiOpenApi = `> Source: \`${openApiFile}\`\n\n${result}`;
    }
  }

  const stageIndex = [];
  const purposes = { '01_overview': 'Stack, environment, metrics', '02_architecture': 'Structure and git activity', '03_data': 'Schema, entities, state, migrations', '04_interfaces': 'Routes, controllers, services, API spec' };
  for (const stage of buildStages01to04(ctx)) {
    log.info(`Stage ${stage.name}...`);
    const written = writeStage(root, args.contextDir, stage.name, stage.contract, stage.outputs);
    stageIndex.push({ stage: stage.name, purpose: purposes[stage.name], extraction: stage.extraction, files: written.map((f) => ({ rel: `output/${f}`, bytes: fs.statSync(path.join(root, args.contextDir, 'stages', stage.name, 'output', f)).size })) });
  }
  const manifest = loadManifest(root, args.contextDir, repoName);
  log.info('Stage 05_documentation...');
  const summarizer = ai.useAi ? makeAiSummarizer(ctx) : () => '';
  const docResult = runDocumentationStage(ctx, manifest, summarizer);
  const doc05Outputs = { 'index.md': docResult.indexMd };
  for (const [f, c] of Object.entries(docResult.summaries)) doc05Outputs[`summaries/${f}`] = c;
  const written05 = writeStage(root, args.contextDir, '05_documentation', {
    inputs: ['source: **/*.md (ignore rules from _config/ignore applied)', 'reference: _config/manifest.json (parse ledger)'],
    process: `Indexed ${Object.keys(docResult.parsedMarkdown).length} markdown files; parsed ${docResult.stats.parsed}, skipped ${docResult.stats.skipped} unchanged (ledger), removed ${docResult.stats.removed} stale.`,
    outputs: [{ file: 'index.md', desc: 'all project markdown files, grouped by directory' }, { file: 'summaries/', desc: 'one digest per markdown file' }],
  }, doc05Outputs);
  log.info(`Docs: ${docResult.stats.parsed} parsed, ${docResult.stats.skipped} skipped (unchanged), ${docResult.stats.removed} removed`);
  stageIndex.push({ stage: '05_documentation', purpose: 'Markdown docs index and digests', files: written05.map((f) => ({ rel: `output/${f}`, bytes: fs.statSync(path.join(root, args.contextDir, 'stages/05_documentation/output', f)).size })) });

  log.info('Stage 06_synthesis...');
  let stage06Outputs = {};
  let stage06Process;
  if (ai.useAi) {
    const keyFiles = collectAiContextFiles(ctx);
    const gitLog = git(root, ['log', '--oneline', '-10']) || 'No git history';
    const gitRecent = git(root, ['diff', '--name-only', 'HEAD~5', 'HEAD']).split('\n').slice(0, 20).join('\n');

    log.info(`Calling ${args.aiCli} — project overview...`);
    const overview = callAi(args.aiCli, `You are generating documentation for a software project.

Project name: ${repoName}
Detected framework: ${detection.primaryFramework} (${detection.primaryLang})
Dev environment: ${devEnv.devEnv}
Database: ${dbHints}
Recent commits:
${gitLog}

Key project files (truncated):
${keyFiles.slice(0, 3000)}

Write a concise 2-3 sentence project overview describing what it does, its purpose, and primary architectural approach. Output only the overview text — no preamble, no heading.`);

    log.info(`Calling ${args.aiCli} — architecture notes...`);
    const entityList = _basenameList(ctx, detection.modelsDir);
    const serviceList = _basenameList(ctx, detection.servicesDir);
    const dirList = _sourceDirList(ctx);
    const architecture = callAi(args.aiCli, `Analyse this ${detection.primaryFramework} (${detection.primaryLang}) codebase.

Entities/models: ${entityList}
Services: ${serviceList}
Source directories:
${dirList}

Identify up to 5 architectural patterns actually evidenced by the entity/service/directory names above — not patterns that are merely typical of ${detection.primaryFramework} apps in general. For each bullet: name the pattern, then cite the specific class name(s) or directory path(s) from the lists above that show it (e.g. "Service layer — UserService, OrderService in ${detection.servicesDir || 'the services directory'} separate business logic from controllers"). Every claim must be checkable against a name given above; if you cannot cite a specific name for a pattern, omit it. Do not use speculative language ("suggests", "likely", "appears to", "probably"). If fewer than 3 patterns are actually evidenced, return fewer bullets — do not pad with generic filler. Return a markdown bullet list only — no preamble, no heading.`);

    log.info(`Calling ${args.aiCli} — development focus areas...`);
    const focus = callAi(args.aiCli, `Analyse recent development activity on a ${detection.primaryFramework} project.

Recent commits:
${gitLog}

Recently modified files:
${gitRecent}

Based solely on the above, identify up to 5 areas of active development. For each bullet, cite the specific commit message or file path from the lists above that it's based on. State plainly what changed and where — do not use marketing or speculative phrasing (e.g. "AI can help reasoning about...", "this suggests...", "may benefit from"). Every claim must reduce to a checkable fact about a commit or file listed above; if the evidence doesn't support 3 distinct areas, return fewer bullets rather than padding. Return a markdown bullet list only — no preamble, no heading.`);

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
  stageIndex.push({ stage: '06_synthesis', purpose: 'AI overview, architecture notes, focus', files: written06.map((f) => ({ rel: `output/${f}`, bytes: fs.statSync(path.join(root, args.contextDir, 'stages/06_synthesis/output', f)).size })) });

  log.info('Reviewing .context for knowledge gaps...');
  let hasKnowledgeGaps = false;
  if (ai.useAi) {
    const reviewContext = collectReviewContext(root, args.contextDir, stageIndex);
    const gaps = callAi(args.aiCli, `You are reviewing a generated project-context folder for a ${detection.primaryFramework} (${detection.primaryLang}) codebase to find open questions a human should resolve — not to describe what's already documented.

Generated context (schema, entities, routes, services, docs, synthesis — truncated, most relevant stages first):
${reviewContext}

Identify up to 8 knowledge gaps: business rules, edge cases, or intent that isn't derivable from the content above, or sections whose extraction method is a static fallback or unavailable (see the provenance table) and so unverified. Every gap must cite a specific file, class, or section from the content above. Do not invent generic gaps that could apply to any ${detection.primaryFramework} project. Return fewer than 8 if fewer are genuinely evidenced — do not pad.

Format each gap exactly as:

## <short topic>
**Question:** <specific open question a human/agent needs to answer>
**Why it matters:** <concrete consequence, tied to the cited file/class>

Output only the gaps in that format — no preamble, no trailing commentary.`);
    if (gaps) {
      fs.writeFileSync(path.join(root, args.contextDir, 'KNOWLEDGE_GAPS.md'), `# Knowledge Gaps\n\n${gaps.trimEnd()}\n`);
      hasKnowledgeGaps = true;
    }
  }

  writeRouter(root, args.contextDir, { repoName, label: stackLabel(detection, versions, devEnv, dbHints), stageIndex, hasKnowledgeGaps });
  log.success(`${args.contextDir}/ generated`);
  const aiFileResults = updateAiInstructionFiles(root, args.contextDir);
  for (const { rel, result } of aiFileResults) {
    if (result !== 'unchanged') log.success(`${result}: ${rel} → context pointer`);
  }

  const finalManifest = emptyManifest(repoName);
  finalManifest.generated_at = new Date().toISOString();
  finalManifest.project.stack = stackLabel(detection, versions, devEnv, dbHints);
  finalManifest.parsed_markdown = docResult.parsedMarkdown;
  for (const s of stageIndex) finalManifest.stages[s.stage] = { last_run: finalManifest.generated_at, ...(s.extraction ? { extraction: s.extraction } : {}) };
  saveManifest(root, args.contextDir, finalManifest);
}

module.exports = {
  parseArgs, readText, readJson, sha256, exists, isDir, grepLines, extractBlocks, log, GENERATOR_VERSION,
  DEFAULT_IGNORES, compileIgnorePatterns, createIgnoreMatcher, walkFiles, latestByBasename, detectStack, detectDevEnv,
  detectDatabases, extractVersions, findCandidateSubDirs, collectStackContext, aiDetermineStack, determineAppStack,
  buildContextBlock, injectContextReference, updateAiInstructionFiles,
  schemaBlock, entitiesBlock, stateBlock, modelsBlock, controllersBlock, servicesBlock, routesBlock,
  extractDomainNotes, annotateWithDomainNotes,
  migrationsBlock, envBlock, depsBlock, metricsBlock, treeBlock, gitActivityBlock, findOpenApiFile, sectionLabels,
  writeStage, seedIgnoreFile, stackLabel, devSetupBlock, buildStages01to04, writeRouter, buildExtractionRows,
  slugForPath, mdDigest, loadManifest, saveManifest, runDocumentationStage, emptyManifest,
  checkAiAvailable, callAi, stripModelPreamble, collectAiContextFiles, collectReviewContext, makeAiSummarizer,
};
if (require.main === module) main();
