# Review B — SPEC.md `ib config` CLI Command (§7.5)

**Reviewer:** agent-63c32069 (Reviewer B)
**Commit:** 7efd168
**Verdict:** APPROVE with minor issues

## Summary

The commit adds §7.5 documenting the `ib config` CLI command with five subcommands (list, get, set, add, remove), adds `fps` to the §7.2 config keys table, and updates §7.1 with a callout noting the bash/TS config file divergence. The spec was compared line-by-line against the bash reference implementation (`cmd_config()` at line 22986 of `~/Developer/bash/ittybitty/ib`).

Overall, the spec is thorough and accurately captures the bash reference behavior. The subcommand signatures, exit codes, idempotent semantics, error messages, array key restrictions, dot notation, type validation, and help behavior all match the reference implementation.

## Issues

### 1. Object literal values omitted from `set` value encoding (minor)

The bash `set` command handles `{...}` values as JSON object literals (lines 23145-23147):
```bash
elif [[ "$VALUE" == "{"* && "$VALUE" == *"}" ]]; then
    json_value=":$VALUE"
```
The spec's §7.5 "Value encoding" section (item 5) only lists integers, booleans, and strings. Object values should be mentioned for completeness, or explicitly noted as unsupported in the TS implementation.

### 2. `model` default value inconsistency between §7.2 and bash `get` (minor)

§7.2 lists `model`'s default as `"opus"`. However, the bash `get` command sets `default_value=""` for `model` (line 23031). This means `ib config get model` with no config file returns an empty string in bash, but following §7.2's default would return `"opus"`.

This is likely an intentional TS divergence (TS config.ts defaults model to "opus") but the §7.5 `get` subcommand says it falls back to "the built-in default" referencing §7.2, which creates an inconsistency when describing the bash behavior. A brief callout noting this difference would resolve the ambiguity.

### 3. Duplicate callout between §7.1 and §7.5 (minor)

The §7.1 callout and the §7.5 callout say nearly the same thing about bash vs TS config file locations. The §7.5 callout could be shortened to a back-reference: "See §7.1 callout for config file divergence. The TS implementation of `ib config` should read/write `~/.itsybitsy/config.json`; the two-tier layering does not apply."

### 4. Missing `-h` short flag for help (nitpick)

The spec says `ib config --help` and `ib config help` trigger help output. The bash reference also accepts `-h` (line 23393: `-h|--help|help|""`). Minor, but worth listing for completeness.

### 5. Missing boolean validation for `hooks.*` and `allowAgentQuestions` (observation, non-blocking)

The `set` type validation (item 4) validates `createPullRequests` as boolean but not `hooks.injectStatus`, `hooks.statusVisible`, or `allowAgentQuestions` — all of which are boolean keys per §7.2. The bash reference has the same gap (only `createPullRequests` is validated). This is correctly spec'd as-is (matches bash), but worth noting as a potential TS improvement.

### 6. `autoCompactThreshold` range not validated (observation, non-blocking)

§7.2 describes this as "0-100" but neither bash nor the spec's `set` validation enforces the range — only `^[0-9]+$` applies. Values like `999` would be accepted. Again, matches bash behavior, so correctly spec'd, but a candidate for TS-side improvement.

## Positives

- **Idempotent exit codes** are correctly documented: duplicate `add` and missing-value `remove` both exit 0. Matches bash lines 23209-23210 and 23269-23270.
- **Array key restrictions** are well-specified: `set` rejects both permission keys (by pattern) and array-looking values (by `[...]` syntax). Matches bash lines 23099-23112.
- **Config file creation semantics** are correct: `set` and `add` create files with `{}`, while `remove` requires the file to exist. Matches bash lines 23094-23096, 23203-23205, 23262-23265.
- **Dot notation** is mentioned (item 6 of `set`) and correctly describes the nested JSON path mapping.
- **Error messages** match the bash reference verbatim (e.g., `"Key '<key>' not found (no default value)"`, `"'<key>' must be a number, got '<value>'"`, `"Config file not found: <path>"`).
- **Callout annotations** in §7.1 follow the established `[^callout]` convention used throughout the spec.
- The `fps` addition to §7.2 is clean and the description accurately reflects its use in `ib watch`.
- The `ls` alias for `list` is documented (item 6), matching bash line 23282.

## Conclusion

The spec accurately captures all behavioral nuances of the bash `ib config` command. The issues found are minor (object literal omission, model default inconsistency, duplicate callout, missing `-h`). None are blocking. The section integrates well with the surrounding §7 structure and correctly uses the spec's callout convention to mark bash/TS divergences.
