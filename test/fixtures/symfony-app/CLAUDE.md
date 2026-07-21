# symfony-app

## Key Entities

| Entity | Purpose |
|---|---|
| `Foo` | Tracks a foo and its hall-of-fame point total. |

## Key Gotchas

- `hallOfFamePoints`: max(current, incoming) — never decreases.

## Key Services

| Service | Purpose |
|---|---|
| `FooController` | Handles inbound foo requests and validation. |
