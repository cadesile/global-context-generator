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

test('default flags without AI CLI on PATH: second run still skips via ledger', () => {
  const os = require('node:os');
  const { spawnSync } = require('node:child_process');
  const root = copyFixture('expo-app');
  const SCRIPT = path.join(__dirname, '..', 'generate_project_context.js');
  const env = { ...process.env, PATH: '/usr/bin:/bin' };
  delete env.CLAUDECODE;
  let r = spawnSync(process.execPath, [SCRIPT], { cwd: root, encoding: 'utf8', env });
  assert.strictEqual(r.status, 0, r.stderr);
  const manifestPath = path.join(root, '.context/_config/manifest.json');
  const m1 = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.strictEqual(m1.parsed_markdown['README.md'].ai_summarized, false);
  r = spawnSync(process.execPath, [SCRIPT], { cwd: root, encoding: 'utf8', env });
  assert.strictEqual(r.status, 0, r.stderr);
  const m2 = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.strictEqual(m2.parsed_markdown['README.md'].parsed_at, m1.parsed_markdown['README.md'].parsed_at,
    'second default-flag run without AI CLI must skip unchanged files');
  assert.match(r.stderr, /0 parsed/);
});

test('laravel fixture full run', () => {
  const root = copyFixture('laravel-app');
  const r = runGenerator(root, ['--no-ai']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(fs.readFileSync(path.join(root, '.context/stages/03_data/output/schema.md'), 'utf8'), /create_users_table/);
  assert.match(fs.readFileSync(path.join(root, '.context/stages/03_data/output/entities.md'), 'utf8'), /\$fillable/);
  assert.ok(!fs.existsSync(path.join(root, '.context/stages/03_data/output/state.md')), 'state.md omitted for PHP stack');
});

test('--debug-detection prints JSON and writes nothing', () => {
  const root = copyFixture('expo-app');
  const r = runGenerator(root, ['--no-ai', '--debug-detection']);
  assert.strictEqual(r.status, 0, r.stderr);
  const parsed = JSON.parse(r.stdout);
  assert.strictEqual(parsed.detection.primaryLang, 'node');
  assert.ok(!fs.existsSync(path.join(root, '.context/CONTEXT.md')));
  assert.ok(!fs.existsSync(path.join(root, '.context')));
});

test('nested --context-dir produces correct index link depth', () => {
  const root = copyFixture('expo-app');
  const r = runGenerator(root, ['--no-ai', '--context-dir', 'docs/ctx']);
  assert.strictEqual(r.status, 0, r.stderr);
  const index = fs.readFileSync(path.join(root, 'docs/ctx/stages/05_documentation/output/index.md'), 'utf8');
  assert.match(index, /\]\(\.\.\/\.\.\/\.\.\/\.\.\/\.\.\/README\.md\)/, 'root README needs five ../ from a two-segment context dir');
});

test('--dir targets another project from a different cwd', () => {
  const os = require('node:os');
  const target = copyFixture('expo-app');
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'icm-elsewhere-'));
  const r = runGenerator(elsewhere, ['--no-ai', '--dir', target]);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(path.join(target, '.context/CONTEXT.md')), '.context created in target');
  assert.ok(!fs.existsSync(path.join(elsewhere, '.context')), 'nothing written to cwd');
});

test('--dir with missing path exits 1 without writes', () => {
  const os = require('node:os');
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'icm-elsewhere2-'));
  const r = runGenerator(elsewhere, ['--no-ai', '--dir', path.join(elsewhere, 'nope')]);
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /Directory not found/);
  assert.ok(!fs.existsSync(path.join(elsewhere, '.context')), 'no writes on failure');
});

function addMigration(root, name, sql) {
  fs.writeFileSync(path.join(root, 'migrations', `${name}.php`), `<?php\nnamespace DoctrineMigrations;\nfinal class ${name} {\n    public function up(): void {\n        $this->addSql('${sql}');\n    }\n}\n`);
}

test('schema.md reflects newly added migrations after a rerun, not stale ones', () => {
  const root = copyFixture('symfony-app');
  // Pad with enough "middle" migrations that the fixture's one stale migration
  // sits outside the latest-10 window once 3 new ones are added on rerun.
  for (let i = 0; i < 8; i++) {
    addMigration(root, `Version2026060${i}120000`, `CREATE TABLE mid${i} (id SERIAL NOT NULL)`);
  }
  const r1 = runGenerator(root, ['--no-ai']);
  assert.strictEqual(r1.status, 0, r1.stderr);
  const before = fs.readFileSync(path.join(root, '.context/stages/03_data/output/schema.md'), 'utf8');
  assert.match(before, /Version20260301120000/);

  for (const [i, name] of ['Version20260710120000', 'Version20260711120000', 'Version20260712120000'].entries()) {
    addMigration(root, name, `CREATE TABLE t${i} (id SERIAL NOT NULL)`);
  }
  const r2 = runGenerator(root, ['--no-ai']);
  assert.strictEqual(r2.status, 0, r2.stderr);
  const after = fs.readFileSync(path.join(root, '.context/stages/03_data/output/schema.md'), 'utf8');
  assert.match(after, /Version20260710120000/);
  assert.match(after, /Version20260711120000/);
  assert.match(after, /Version20260712120000/);
  assert.ok(!after.includes('AUTO_INCREMENT'), 'stale MySQL-era migration must not still be reported once newer ones exist within the latest-10 window');
});

test('latest-10 migration selection is not fooled by an archive/ subdirectory sorting after plain filenames', () => {
  // Regression: filesUnder/walkFiles sort by full relative path for stable tree
  // output. A subdirectory like "archive/" sorts AFTER sibling files named
  // "VersionYYYYMMDDHHMMSS.php" (lowercase 'a' > uppercase 'V'), so naively
  // slicing the last 10 of that path-sorted list surfaces old archived
  // migrations instead of the genuinely latest ones living flat in the dir.
  const root = copyFixture('symfony-app');
  fs.mkdirSync(path.join(root, 'migrations/archive'), { recursive: true });
  fs.renameSync(
    path.join(root, 'migrations/Version20260301120000.php'),
    path.join(root, 'migrations/archive/Version20260301120000.php'),
  );
  // Pad with enough plain (non-archived) migrations that a naive path-sorted
  // slice(-10) would land entirely inside "migrations/archive/..." territory
  // if the bug were present, proving the fix picks the true latest by name.
  for (let i = 0; i < 8; i++) {
    addMigration(root, `Version2026060${i}120000`, `CREATE TABLE mid${i} (id SERIAL NOT NULL)`);
  }
  for (const [i, name] of ['Version20260710120000', 'Version20260711120000', 'Version20260712120000'].entries()) {
    addMigration(root, name, `CREATE TABLE t${i} (id SERIAL NOT NULL)`);
  }
  const r = runGenerator(root, ['--no-ai']);
  assert.strictEqual(r.status, 0, r.stderr);
  const schema = fs.readFileSync(path.join(root, '.context/stages/03_data/output/schema.md'), 'utf8');
  assert.match(schema, /Version20260712120000/, 'newest migration must be reported');
  assert.ok(!schema.includes('AUTO_INCREMENT'), 'archived MySQL-era migration must not be reported as one of the latest');
});

test('symfony routes.md falls back to a static #[Route] scan when debug:router cannot be run', () => {
  const root = copyFixture('symfony-app');
  const r = runGenerator(root, ['--no-ai']);
  assert.strictEqual(r.status, 0, r.stderr);
  const routes = fs.readFileSync(path.join(root, '.context/stages/04_interfaces/output/routes.md'), 'utf8');
  assert.match(routes, /static scan/);
  assert.match(routes, /GET.*\/api\/foo\/\{id\}.*FooController::show/);
  assert.match(routes, /POST.*\/api\/foo.*FooController::create/);
  assert.ok(!/Run: `bin\/console/.test(routes), 'must not degrade to a bare "run this yourself" placeholder when routes were actually found');
});

test('laravel routes.md falls back to a static Route:: scan when artisan cannot be run', () => {
  const root = copyFixture('laravel-app');
  const r = runGenerator(root, ['--no-ai']);
  assert.strictEqual(r.status, 0, r.stderr);
  const routes = fs.readFileSync(path.join(root, '.context/stages/04_interfaces/output/routes.md'), 'utf8');
  assert.match(routes, /static scan/);
  assert.match(routes, /Route::get\('\/users'/);
  assert.match(routes, /Route::post\('\/users'/);
});

test('domain notes from a hand-maintained CLAUDE.md (table format) are merged uniformly into entities.md', () => {
  const root = copyFixture('symfony-app');
  const r = runGenerator(root, ['--no-ai']);
  assert.strictEqual(r.status, 0, r.stderr);
  const entities = fs.readFileSync(path.join(root, '.context/stages/03_data/output/entities.md'), 'utf8');
  // Foo is named in the CLAUDE.md "Key Entities" table -> gets its purpose.
  assert.match(entities, /#### `Foo`\n\n> \*\*Purpose:\*\* Tracks a foo and its hall-of-fame point total\./);
  // Bar is NOT named anywhere in the docs -> must get an explicit absence
  // marker, not silence, so an agent can tell "checked, nothing found" apart
  // from "the merge pass never looked at this one."
  assert.match(entities, /#### `Bar`\n\n> _No hand-written notes found/);
  // hallOfFamePoints' business rule lives in "Key Gotchas", disconnected from
  // the entity table — it must still land next to the specific field it
  // governs (inside Foo's dump), not just be dropped or bolted onto the class.
  assert.match(entities, /private int \$totalCareerEarnings;\n```\n\n> \*\*Field note:\*\* `hallOfFamePoints` is `max\(current, incoming\)` — never decreases\. `reputation` floors at 0\. `totalCareerEarnings` adds deltas\./);
});

test('overlapping "Key Gotchas" lines collapse into one Field note per entity, not one per field-name match', () => {
  // CLAUDE.md's Key Gotchas section (see test/fixtures/symfony-app/CLAUDE.md)
  // deliberately has three lines about Foo's fields: one complete sentence
  // covering hallOfFamePoints+reputation+totalCareerEarnings, plus two older/
  // partial lines each covering a subset of those same fields. All three
  // independently match Foo's dumped fields, so without dedup this would
  // produce three overlapping Field note blocks (the regression this guards
  // against) instead of the one complete one.
  const root = copyFixture('symfony-app');
  const r = runGenerator(root, ['--no-ai']);
  assert.strictEqual(r.status, 0, r.stderr);
  const entities = fs.readFileSync(path.join(root, '.context/stages/03_data/output/entities.md'), 'utf8');

  for (const entitySection of entities.split(/(?=^#### )/m)) {
    const nameMatch = entitySection.match(/^#### `([^`]+)`/);
    if (!nameMatch) continue;
    const notes = [...entitySection.matchAll(/^> \*\*Field note:\*\* (.+)$/gm)].map((m) => m[1]);
    if (nameMatch[1] === 'Foo') assert.strictEqual(notes.length, 1, 'Foo must end up with exactly one Field note block, not one per overlapping gotcha line');
    for (let i = 0; i < notes.length; i++) {
      for (let j = 0; j < notes.length; j++) {
        if (i === j) continue;
        assert.ok(!notes[j].includes(notes[i]), `Field note ${i} ("${notes[i]}") on ${nameMatch[1]} is a subset/duplicate of note ${j} ("${notes[j]}") — overlapping notes must be deduped to the most complete one`);
      }
    }
  }
});

test('Field notes only attach to entities that actually declare every field the note names (no keyword-overlap misattribution)', () => {
  // Regression for a misattribution bug: the old matcher attached a gotcha to
  // any entity sharing ANY one backtick-quoted token with the gotcha's
  // source line — including generic type keywords ("json") and fields two
  // unrelated entities merely happen to share a name with. Baz shares only
  // `reputation` with Foo's 3-field gotcha (not hallOfFamePoints or
  // totalCareerEarnings) and must get nothing. Qux shares the generic word
  // "json" with the `appearance` gotcha but has no `appearance` field
  // itself (only an unrelated `traitMapping` json column) and must get
  // nothing. Widget genuinely declares `appearance` and must get the note.
  // The spl_object_id()/array_unique() gotcha names no real entity field at
  // all and must attach to nobody.
  const root = copyFixture('symfony-app');
  const r = runGenerator(root, ['--no-ai']);
  assert.strictEqual(r.status, 0, r.stderr);
  const entities = fs.readFileSync(path.join(root, '.context/stages/03_data/output/entities.md'), 'utf8');

  const sections = new Map();
  for (const section of entities.split(/(?=^#### )/m)) {
    const nameMatch = section.match(/^#### `([^`]+)`/);
    if (nameMatch) sections.set(nameMatch[1], section);
  }

  assert.strictEqual([...(sections.get('Baz').matchAll(/^> \*\*Field note:\*\*/gm))].length, 0,
    'Baz shares only `reputation` with Foo\'s gotcha and must not get the whole 3-field note');
  assert.strictEqual([...(sections.get('Qux').matchAll(/^> \*\*Field note:\*\*/gm))].length, 0,
    'Qux shares only the generic word "json" with the appearance gotcha, not the `appearance` field itself, and must get nothing');
  assert.match(sections.get('Widget'), /> \*\*Field note:\*\* `appearance` is a `json`\/array column/,
    'Widget genuinely declares `appearance` and must get the note');
  for (const [, section] of sections) {
    assert.ok(!/spl_object_id/.test(section), 'a gotcha naming no real entity field must attach to no entity');
  }

  // General regression check: for every Field note anywhere in entities.md,
  // every backtick-quoted name it mentions must be a field this entity's own
  // code block actually declares — a stray quoted name proves misattribution.
  for (const [name, section] of sections) {
    const declaredFields = new Set([...section.matchAll(/\$(\w+)/g)].map((m) => m[1]));
    for (const noteMatch of section.matchAll(/^> \*\*Field note:\*\* (.+)$/gm)) {
      const quotedNames = [...noteMatch[1].matchAll(/`([A-Za-z_]\w*)`/g)].map((m) => m[1]);
      // Not every quoted name in a note is necessarily a field (e.g. a form
      // type class like AppearanceType) — but at least one must be, and none
      // of the quoted names that ARE known fields elsewhere may be a field
      // this entity itself lacks entirely (id is present on every fixture
      // entity here, so it's excluded as an uninformative universal field).
      const quotedFieldsThisEntityLacks = quotedNames.filter((n) => n !== 'id' && !declaredFields.has(n) && fieldIsDeclaredSomewhere(sections, n));
      assert.deepStrictEqual(quotedFieldsThisEntityLacks, [],
        `${name}'s Field note quotes field name(s) ${quotedFieldsThisEntityLacks.join(', ')} that ${name} does not declare — misattribution`);
    }
  }
});

function fieldIsDeclaredSomewhere(sections, fieldName) {
  for (const [, section] of sections) {
    if (new RegExp(`\\$${fieldName}\\b`).test(section)) return true;
  }
  return false;
}

test('the same CLAUDE.md merge covers 04_interfaces (services.md, controllers.md), not just 03_data', () => {
  const root = copyFixture('symfony-app');
  const r = runGenerator(root, ['--no-ai']);
  assert.strictEqual(r.status, 0, r.stderr);
  // FooController is named in CLAUDE.md's "Key Services" table (also used for
  // controllers) — stage 04 must annotate it exactly like stage 03 annotated
  // Foo, from the same source and the same attach-by-name logic. These two
  // stages must not drift independently.
  const controllers = fs.readFileSync(path.join(root, '.context/stages/04_interfaces/output/controllers.md'), 'utf8');
  assert.match(controllers, /#### `FooController`\n\n> \*\*Purpose:\*\* Handles inbound foo requests and validation\./);
});

test('router and manifest stamp generator commit and per-output extraction provenance', () => {
  const root = copyFixture('symfony-app');
  const r = runGenerator(root, ['--no-ai']);
  assert.strictEqual(r.status, 0, r.stderr);
  const router = fs.readFileSync(path.join(root, '.context/CONTEXT.md'), 'utf8');
  assert.match(router, /Generator: v[\d.]+ \([0-9a-f]{7,}|unknown\)/);
  assert.match(router, /## Extraction provenance/);
  assert.match(router, /`04_interfaces\/routes\.md` \| static-regex-fallback/);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, '.context/_config/manifest.json'), 'utf8'));
  assert.match(manifest.generator_commit, /^[0-9a-f]{7,}$|^unknown$/);
  assert.strictEqual(manifest.stages['03_data'].extraction['schema.md'], 'static-regex-scan');
  assert.match(manifest.stages['04_interfaces'].extraction['routes.md'], /static-regex-fallback/);
});

test('knowledge-gap review writes KNOWLEDGE_GAPS.md and a router pointer when AI is available', () => {
  const root = copyFixture('symfony-app');
  const fakeAi = path.join(__dirname, 'fixtures/bin/fake-ai.js');
  const r = runGenerator(root, ['--ai', fakeAi]);
  assert.strictEqual(r.status, 0, r.stderr);

  const gapsPath = path.join(root, '.context/KNOWLEDGE_GAPS.md');
  assert.ok(fs.existsSync(gapsPath));
  const gaps = fs.readFileSync(gapsPath, 'utf8');
  assert.match(gaps, /^# Knowledge Gaps/);
  assert.match(gaps, /## hallOfFamePoints refund handling/);
  assert.match(gaps, /\*\*Question:\*\*/);
  assert.match(gaps, /\*\*Why it matters:\*\*/);
  assert.ok(!/no skill applies/i.test(gaps), 'leaked preamble must be stripped from KNOWLEDGE_GAPS.md too');

  const router = fs.readFileSync(path.join(root, '.context/CONTEXT.md'), 'utf8');
  assert.match(router, /Unresolved: see `KNOWLEDGE_GAPS\.md`/);
});

test('knowledge-gap review is skipped entirely under --no-ai: no file, no router pointer', () => {
  const root = copyFixture('symfony-app');
  const r = runGenerator(root, ['--no-ai']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(!fs.existsSync(path.join(root, '.context/KNOWLEDGE_GAPS.md')));
  const router = fs.readFileSync(path.join(root, '.context/CONTEXT.md'), 'utf8');
  assert.ok(!router.includes('KNOWLEDGE_GAPS.md'));
});

test('06_synthesis strips leaked model self-talk/routing preamble before writing output files', () => {
  const root = copyFixture('symfony-app');
  const fakeAi = path.join(__dirname, 'fixtures/bin/fake-ai.js');
  const r = runGenerator(root, ['--ai', fakeAi]);
  assert.strictEqual(r.status, 0, r.stderr);
  const synthDir = path.join(root, '.context/stages/06_synthesis/output');
  for (const file of ['overview.md', 'architecture-notes.md', 'current-focus.md']) {
    const content = fs.readFileSync(path.join(synthDir, file), 'utf8');
    assert.ok(!/no skill applies/i.test(content), `${file} leaked "no skill applies" preamble`);
    assert.ok(!/this is a[n]? .*\btask\b/i.test(content), `${file} leaked "this is a ... task" preamble`);
    assert.match(content, /FooController handles inbound foo requests/, `${file} should still contain the real content`);
  }
});
