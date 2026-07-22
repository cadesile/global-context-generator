#!/usr/bin/env node
// Minimal stand-in for an AI CLI (`claude -p <prompt>`) used only in tests.
// Branches on the prompt text so different callAi() call sites (discovery,
// the 6 generation calls, 06_synthesis, the knowledge-gaps review) can be
// tested against distinct canned responses. Every response is deliberately
// contaminated with leaked routing/self-talk preamble so tests can assert
// the generator strips it before persisting any of these outputs.
const prompt = process.argv[3] || '';
const PREAMBLE = "This is a plain content-generation task (writing a doc summary), not creative feature work or a coding task — no skill applies here.\n\n";

if (/DATA_MODEL:/.test(prompt)) {
  process.stdout.write(PREAMBLE +
    'DATA_MODEL: src/Entity/Foo.php, src/Entity/Bar.php\n' +
    'ROUTES: src/Controller/FooController.php\n' +
    'BUSINESS_LOGIC: \n' +
    'STATE: \n'
  );
} else if (/database\/storage schema/.test(prompt)) {
  process.stdout.write(PREAMBLE +
    '#### `Foo`\n```sql\nid INTEGER PRIMARY KEY,\nhall_of_fame_points INTEGER\n```\n'
  );
} else if (/code-level entity\/model definitions/.test(prompt)) {
  process.stdout.write(PREAMBLE +
    '#### `Foo`\n```php\nprivate int $hallOfFamePoints;\n```\n\n' +
    '#### `Bar`\n```php\nprivate int $id;\n```\n'
  );
} else if (/client-side state\/store shape/.test(prompt)) {
  process.stdout.write(PREAMBLE); // no store found for this fixture — empty content after preamble strip
} else if (/API routes for this/.test(prompt)) {
  process.stdout.write(PREAMBLE +
    '| Method | Path | Handler |\n|---|---|---|\n| GET | /api/foo | FooController::show |\n'
  );
} else if (/controller\/handler signatures/.test(prompt)) {
  process.stdout.write(PREAMBLE +
    '#### `FooController`\n```php\npublic function show(int $id): Response\n```\n'
  );
} else if (/service\/business-logic signatures/.test(prompt)) {
  process.stdout.write(PREAMBLE); // no business-logic paths discovered for this fixture
} else if (/knowledge gap/i.test(prompt)) {
  process.stdout.write(PREAMBLE +
    "## hallOfFamePoints refund handling\n" +
    "**Question:** What happens to Foo's hallOfFamePoints if a refund is issued after points were already awarded?\n" +
    "**Why it matters:** FooController::create persists new Foo records but no code here shows points being reversed.\n"
  );
} else {
  process.stdout.write(PREAMBLE +
    "The FooController handles inbound foo requests. Foo tracks a hall-of-fame point total.\n"
  );
}
