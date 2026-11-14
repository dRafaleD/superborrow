# Validation evidence — 0.3.0

## Local Windows checks — 2026-11-15

- 7 Rust unit tests passed; strict Clippy and rustfmt passed.
- 24 Node unit/integration tests passed against a real Rust process and
  controlled HTTP servers. Coverage includes provider fallback/isolation,
  IDE-first routing across 11 non-AST/custom language IDs, cancellation,
  idempotent reconfiguration, streaming formats, Unicode, synchronization,
  model discovery/pinning and single-row native Tab preference updates.
- TypeScript strict compilation passed.

## Real Antigravity host and account

Host: Antigravity IDE 1.107.0, built-in `google.google-antigravity` 1.11.0.
The exported model catalog and pure model-response API were exercised through
the extension API without extracting authentication values. The live suite ran
in a separate editor profile, using only synthetic source snippets.

All 12 cases in the recorded run passed:

| Case | Actual provider / observed behavior |
| --- | --- |
| Python, TypeScript, Go, Rust, Java | Gemini 4 Hydrogen (Low), addition expressions |
| SQL | Gemini 4 Hydrogen (Low), requested integer selection |
| HTML | Gemini 4 Hydrogen (Low), button markup |
| Turkish JavaScript comment | Complete `function topla(a, b)` declaration |
| Turkish Python comment | Complete `def add(...)` declaration |
| Turkish CSS comment | Black background and white text rules |
| Automatic edit trigger + acceptance | Actual Superborrow ghost text committed in the editor |
| Second account model | Claude Sonnet 5.5 (Low) returned the addition expression |

The acceptance test checked Superborrow's own acceptance command and model ID.
It cannot pass merely by accepting the host's competing native suggestion.
The native `tabEnabled` setting was saved, temporarily switched off, and restored
in the live test's finally block. No other host preference was modified.

The full synthetic report is [recorded here](evidence/antigravity-live-2026-11-15.json).
Model-backed fixture calls in this run took roughly 0.8–3.5 seconds, including
editor/test orchestration; some Go/Java language activation events cancelled
obsolete requests, which were retried only after a verified cancellation.
These are smoke checks, not latency percentiles or a guarantee of correct output
for arbitrary code. The suite is opt-in (`npm --prefix extension run test:host`)
and uses the signed-in account's model quota. It is not run in offline CI.

## Language scope

File, untitled and notebook-cell selectors have no language allowlist. Supported
AST grammars add syntax context; all other IDs use the text path. The Rust
integration matrix also covers C#, C++, shell, JSON, plain text and an arbitrary
custom language ID. This establishes routing without grammar gating; it is not
a semantic-quality test of every language. Notebook selectors are registered,
but live notebook rendering was not exercised in this run.

## Earlier actual local inference (0.2.0)

Existing Ollama / `qwen2.5-coder:7b`, no download. A small Python `return ` gap
produced `a + b` twice: 5744 ms on first use including model load, 82 ms for the
identical warmed prompt. Those times exclude editor rendering and are not a
general sub-100-ms guarantee. Local transport/fallback is covered by the current
offline suite; the 0.3 live suite used the Antigravity account models.

## Remaining limits

Actual llama.cpp and OpenAI-compatible servers were not run locally; their
formats are covered by HTTP fixtures. Arbitrary Next Edit semantic correctness,
multi-file edits and automatic edit-location prediction are not established.
The native adapter depends on an exported host API whose future compatibility
is guarded at runtime, not guaranteed. Previous unsaved README conflict tabs
were left untouched.

CI runs independent Windows/Ubuntu builds, checks and offline tests. Inspect the
run for the relevant commit; local success is not treated as proof of CI success.
