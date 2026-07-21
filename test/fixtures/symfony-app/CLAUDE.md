# symfony-app

## Key Entities

| Entity | Purpose |
|---|---|
| `Foo` | Tracks a foo and its hall-of-fame point total. |

## Key Gotchas

- `hallOfFamePoints` is `max(current, incoming)` — never decreases. `reputation` floors at 0. `totalCareerEarnings` adds deltas.
- `hallOfFamePoints` is `max(current, incoming)` — never decreases.
- `reputation` floors at 0. `totalCareerEarnings` accumulates deltas.
- `appearance` is a `json`/array column that uses a custom EasyAdmin form type (`AppearanceType`).
- Pool dedup uses `spl_object_id()`, not `array_unique()`.

## Key Services

| Service | Purpose |
|---|---|
| `FooController` | Handles inbound foo requests and validation. |
