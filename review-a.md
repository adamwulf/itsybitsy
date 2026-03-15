# Review A: SPEC.md — `ib config` CLI command (commit 7efd168)

## Verdict: **Approve** (with minor issues noted below)

The specification is well-structured, accurate against the bash reference implementation, and consistent with the existing SPEC.md style. The changes correctly document all five subcommands (`list`, `get`, `set`, `add`, `remove`), the `--global` flag, type validation, array key restrictions, exit codes, and help behavior.

---

## Accuracy vs Bash Reference

All five subcommands match the bash implementation behavior:

- **`list`/`ls`**: Correctly documents merged view vs `--global` view, source labels `(project)`/`(user)`/`(default)`, `(unset)` for keys with no value, and the legend line. The alias `ls` is documented.
- **`get`**: Correctly documents precedence, error on missing key argument, error on unknown keys with no default, and the available-keys hint in error output.
- **`set`**: Type validation rules match exactly (integer regex for `maxAgents`/`fps`, boolean check for `createPullRequests`, enum check for `model`). Array key rejection and array-looking value rejection both match.
- **`add`**: Duplicate prevention, array-key-only restriction, config file creation, and output messages all match.
- **`remove`**: Missing-file error, missing-value idempotency (exit 0), and output messages all match.
- **Help/errors**: The `""`, `help`, `--help`, `-h` triggers and the unknown subcommand error format match the bash implementation.
- **`--global` flag parsing**: Correctly notes the flag can appear anywhere in the argument list, matching the bash `while` loop that strips it before processing.

## Issues

### 1. `model` default value discrepancy (minor, pre-existing)

The SPEC §7.2 table lists `model` default as `"opus"`, but the bash `cmd_config get` implementation (line 23031) has `model) default_value=""; has_default=true` — meaning `ib config get model` returns an empty string when model is unset, not `"opus"`. The `list` subcommand also shows model as empty by default.

This is a pre-existing inconsistency in §7.2 (not introduced by this commit), but the new §7.5 inherits it by referencing §7.2. The resolution order in §7.2 (`--model` flag → config `model` → `"opus"`) is correct for agent *spawning*, but the `ib config get` command returns the raw config value (empty string), not the effective spawn-time value. This distinction could be confusing but is ultimately a documentation nuance, not a bug in this commit.

### 2. `autoCompactThreshold` not validated by `set` (accurate but worth noting)

The bash implementation does NOT validate `autoCompactThreshold` as a number in the `set` subcommand — only `maxAgents` and `fps` get the integer regex check (lines 23116-23121). The SPEC accurately reflects this by only listing `maxAgents` and `fps` under type validation. However, since `autoCompactThreshold` is documented as a number type in §7.2 (0-100 range), the lack of validation is a behavioral gap in the bash reference. Not a spec issue, but worth noting for the TS implementation.

### 3. Object value encoding undocumented

The bash `set` subcommand (lines 23145-23147) also handles object-looking values (`{...}`) as JSON literals. The SPEC's value encoding section (point 5 under `set`) only mentions integers and booleans as literals, with "all other values" as strings. Object encoding is undocumented. This is a minor edge case unlikely to be used in practice.

### 4. `-h` not listed as a help trigger

The bash implementation accepts `-h` as a help trigger (line 23393: `-h|--help|help|""`), but the SPEC's Help and Errors section only lists `ib config` (no subcommand), `ib config --help`, and `ib config help`. The `-h` short flag is omitted. Minor.

## Completeness

- All 5 subcommands fully documented
- `--global` flag fully covered
- Help triggers and unknown subcommand handling documented
- Exit codes table present and correct
- Error message formats match bash output
- The `[^callout]` annotations properly explain the bash↔TS config file divergence in both §7.1 and §7.5
- `fps` config key correctly added to §7.2 table
- §7.1 update accurately describes the divergence

## Style Consistency

- Section numbering follows existing pattern (§7.5 after §7.4)
- `[^callout]` usage matches prior sections
- Table formatting consistent with rest of document
- Subcommand documentation structure (numbered rules with bold labels) matches style used elsewhere in SPEC.md

## Summary

This is a thorough and accurate specification of `ib config`. The issues noted are all minor — the model default discrepancy is pre-existing, the validation gap is accurate to the bash reference, the object encoding edge case is unlikely to matter, and the missing `-h` trigger is cosmetic. No changes required for approval.
