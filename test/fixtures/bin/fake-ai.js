#!/usr/bin/env node
// Minimal stand-in for an AI CLI (`claude -p <prompt>`) used only in tests.
// Branches on the prompt text so different callAi() call sites (discovery,
// the 6 generation calls, 06_synthesis, the knowledge-gaps review) can be
// tested against distinct canned responses. Every response is deliberately
// contaminated with leaked routing/self-talk preamble so tests can assert
// the generator strips it before persisting any of these outputs.
//
// Discovery/generation responses branch further on which fixture's framework
// name (e.g. "expo", "laravel") appears in the prompt, so regression tests
// that assert on specific fixture content (e.g. expo's `users` table, or
// laravel's `create_users_table`/`$fillable`) get realistic canned answers
// instead of a single fixture's canned answer for every fixture.
const prompt = process.argv[3] || '';
const PREAMBLE = "This is a plain content-generation task (writing a doc summary), not creative feature work or a coding task — no skill applies here.\n\n";
const isExpo = /\bexpo\b/.test(prompt);
const isLaravel = /\blaravel\b/.test(prompt);

if (/DATA_MODEL:/.test(prompt)) {
  if (isExpo) {
    process.stdout.write(PREAMBLE +
      'DATA_MODEL: src/db/schema.sql\n' +
      'ROUTES: \n' +
      'BUSINESS_LOGIC: \n' +
      'STATE: src/stores/useTaskStore.ts\n'
    );
  } else if (isLaravel) {
    process.stdout.write(PREAMBLE +
      'DATA_MODEL: database/migrations, app/Models\n' +
      'ROUTES: routes\n' +
      'BUSINESS_LOGIC: \n' +
      'STATE: \n'
    );
  } else {
    process.stdout.write(PREAMBLE +
      'DATA_MODEL: src/Entity\n' +
      'ROUTES: src/Controller/FooController.php\n' +
      'BUSINESS_LOGIC: \n' +
      'STATE: \n'
    );
  }
} else if (/database\/storage schema/.test(prompt)) {
  if (isExpo) {
    process.stdout.write(PREAMBLE +
      '#### `users`\n```sql\nCREATE TABLE users (\n  id INTEGER PRIMARY KEY,\n  name TEXT NOT NULL\n);\n```\n'
    );
  } else if (isLaravel) {
    process.stdout.write(PREAMBLE +
      '#### `create_users_table`\n```sql\nname VARCHAR NOT NULL,\nemail VARCHAR NOT NULL\n```\n'
    );
  } else {
    process.stdout.write(PREAMBLE +
      '#### `Foo`\n```sql\nid INTEGER PRIMARY KEY,\nhall_of_fame_points INTEGER\n```\n'
    );
  }
} else if (/code-level entity\/model definitions/.test(prompt)) {
  if (isExpo) {
    process.stdout.write(PREAMBLE); // no server-side entities for a client-only expo app
  } else if (isLaravel) {
    process.stdout.write(PREAMBLE +
      '#### `User`\n```php\nprotected $fillable = [\'name\', \'email\'];\n```\n'
    );
  } else {
    process.stdout.write(PREAMBLE +
      '#### `Foo`\n```php\nprivate int $id;\nprivate int $hallOfFamePoints;\nprivate int $reputation;\nprivate int $totalCareerEarnings;\n```\n\n' +
      '#### `Bar`\n```php\nprivate int $id;\n```\n\n' +
      '#### `Baz`\n```php\nprivate int $id;\nprivate int $reputation;\n```\n\n' +
      '#### `Qux`\n```php\nprivate int $id;\nprivate array $traitMapping;\n```\n\n' +
      '#### `Widget`\n```php\nprivate int $id;\nprivate array $appearance;\n```\n'
    );
  }
} else if (/client-side state\/store shape/.test(prompt)) {
  if (isExpo) {
    process.stdout.write(PREAMBLE +
      '#### `TaskStore`\n```ts\ntasks: string[];\naddTask: (t: string) => void;\n```\n'
    );
  } else {
    process.stdout.write(PREAMBLE); // no store found for this fixture — empty content after preamble strip
  }
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
