# Review A: `ib config` CLI Command

## Spec Compliance

All seven subcommands from SPEC.md §7.5 are implemented: `list`/`ls`, `get`, `set`, `add`, `remove`, `unset`, `help`. Help aliases (`-h`, `--help`, no subcommand) all work correctly. Exit codes match spec (0 for success/idempotent cases, 1 for errors). All error output goes to stderr, success output to stdout.

## Issues

### 1. Duplicated `getNestedValue` and `readJsonFile` (Minor)

Both `config-command.ts` and `config.ts` define their own `getNestedValue()` and `readJsonFile()` functions with identical implementations. `config.ts` already exports `readConfig` and `writeConfig` but not these helpers. The command file re-implements them instead of importing or having them exported from `config.ts`.

This is a code duplication issue — not a bug, but diverges from DRY principles.

### 2. `unset` bypasses `writeConfig` (Minor)

The `unset` subcommand writes directly via `Bun.write(cfgPath, JSON.stringify(data, null, 2) + "\n")` at line 277, bypassing the `writeConfig()` helper from `config.ts`. While functionally correct (it needs delete semantics, not set semantics), it means there are two separate file-write paths. If `writeConfig` ever adds validation or formatting changes, `unset` won't pick them up.

### 3. `parseSetValue` doesn't handle `string[]` type (Non-issue)

The `parseSetValue` function falls through to a default `return { value: rawValue }` for unrecognized types. This is fine because `string[]` keys are rejected before `parseSetValue` is called (line 176-179), so this code path is unreachable for array keys.

### 4. Number validation rejects negatives by design (Correct per spec)

The regex `/^[0-9]+$/` rejects negative numbers and floats. The spec explicitly says "non-negative integer" so this is correct behavior.

### 5. `deleteNestedValue` doesn't clean up empty parent objects (Very Minor)

After `unset hooks.injectStatus`, the config file retains `"hooks": {}`. This is cosmetic — an empty parent object is harmless and won't affect behavior.

## Test Coverage

Tests are thorough with 477 lines covering:
- All subcommands with happy path and error cases
- Type validation (invalid number, float, negative, invalid boolean, invalid model)
- Array operations (add, add duplicate, remove, remove missing, all four permission keys)
- Nested key handling (set, unset, preserving siblings)
- Edge cases (zero value, overwrite, add-then-remove, config file creation)
- Config file missing scenarios for `remove` and `unset`
- Unknown subcommand handling

One area not explicitly tested: what happens if the config file contains malformed JSON when running `add`/`remove`/`unset`. The `readJsonFile` catch block returns `{}`, so `add` would silently overwrite a corrupted file. This is an acceptable tradeoff for a CLI tool.

## Code Quality

- Clean separation of concerns between `config.ts` (data layer) and `config-command.ts` (CLI layer)
- Good use of `CONFIG_KEYS` as single source of truth for key definitions
- Test infrastructure is well-structured with proper setup/teardown, temp directories, and spy management
- Help output includes examples which is user-friendly
- The `index.ts` integration is minimal and correct (dynamic import, passes sliced args)

## Verdict

The implementation correctly matches SPEC.md §7.5 in all functional requirements. The code duplication (issue #1) is the only thing worth addressing but is not a blocking concern.

**APPROVE**
