# symfony-app

## Key Entities

| Entity | Purpose |
|---|---|
| `Foo` | Tracks a foo and its hall-of-fame point total. |

## Key Gotchas

- `hallOfFamePoints` is `max(current, incoming)` — never decreases. `reputation` floors at 0. `totalCareerEarnings` adds deltas.
- `hallOfFamePoints` is `max(current, incoming)` — never decreases.
- `reputation` floors at 0. `totalCareerEarnings` accumulates deltas.

## Key Services

| Service | Purpose |
|---|---|
| `FooController` | Handles inbound foo requests and validation. |
