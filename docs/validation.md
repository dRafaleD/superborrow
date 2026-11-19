# Validation evidence

## Resumed isolated editor check — 0.3.8 (2026-11-16)

The user approved a separate Antigravity test session while keeping Cursor
closed and the existing working application untouched. Before testing, all 64
extension files in the development directory matched the 0.3.8 VSIX byte for
byte, including its packaged core. The driver now uses that packaged core,
rather than a potentially older debug build. The VSIX SHA-256 and all five
raw attempts are in the [resumed-session report](evidence/antigravity-editor-validation-0.3.8-2026-11-16.json).

**No valid latency/quality sample was obtained.** One attempt accepted no
suggestion; two did not produce the expected edit through the public `type`
command; two lost window focus. The initial instrumented attempt was focused
but only recorded a cancelled cursor-zero request, not a measured completion
at the intended cursor. These are unavailable observations, not wrong model
answers or model timeouts. Inspection of the uniquely titled isolated test
window showed the editor and an agent onboarding panel; causation is unknown.
No onboarding privacy choices were acted on. The user stopped Computer Use
with physical Escape; no more UI input was issued. Owned test handles were
terminal, and a later exact-profile process query returned no matching process.

Harness-only changes now require focus throughout each measured edit, check
required public commands, reject fixture changes before timing, observe actual
document/selection events after typing, and classify missing input as readiness
failure. Window focus changes invalidate a sample even if focus returns before
the next poll. Optional `--focus-setup` provides an untimed 60-second setup
interval. Compilation passed. These edits do not change the released runtime
or prove the harness succeeds; another live run requires a suitable test session
and must respect the user's latest Computer Use stop. Cursor remains closed.

## Import reuse during typing — 0.3.8 (2026-11-16)

The 0.3.7 read-cache key contained the entire bounded source header. Ordinary
typing therefore changed the key and could reread identical dependencies on
every edit. The key now contains the direct import specifiers and resolution
inputs (active path, workspace and exclusions). Body edits reuse references;
changed imports and tracked file events still refresh them. Workspace-folder
changes also clear references and cancel old predictions. Status exposes only
read/cache counters, entry/path counts and conservative-invalidation state.

The [offline paired comparison](evidence/offline-import-cache-typing-2026-11-16.json)
loads the actual resolver from the preserved 0.3.7 VSIX (SHA-256 in the report)
and the candidate. It applies ten body edits with unchanged imports in a 15.7 KB
synthetic source; the dependency is a synthetic 48 KB source. Each round starts
with a new resolver, alternating order. It counts actual `fs.open` calls in the
benchmark process and checks every returned reference. No model/editor is used.

| Round | 0.3.7, ten resolves | 0.3.8, ten resolves | Dependency opens |
| --- | --- | --- | --- |
| 0 | 67.52 ms | 40.72 ms | 10 → 1 |
| 1 | 51.42 ms | 36.83 ms | 10 → 1 |
| 2 | 62.69 ms | 45.60 ms | 10 → 1 |

These totals measure resolver work across ten synthetic edits, not model or
end-to-end latency; three rounds do not establish production percentiles.
**64 Node tests passed**, including reuse across ten body edits, import changes,
and changed-file invalidation followed by fresh content. Reproduction script:
`extension/scripts/benchmark-import-cache.cjs`; it requires `imports.js` and
`completion.js` extracted from the 0.3.7 VSIX's `extension/dist/src/` into
`packages/import-cache-baseline-0.3.7/`. The new VSIX is locally built only.
Matched Cursor results and latest full editor acceptance are still missing.

## Closed local import context — 0.3.7 (2026-11-16)

Trusted file workspaces can now contribute up to four directly imported TS/JS
source files, 64 KB each, via capability-gated `relatedDocuments`. References
are request-scoped; synchronized open buffers win. The resolver reads only
canonical paths within the workspace, applies exclusions, rejects binary/invalid
UTF-8 and oversized input, and does not recursively resolve packages or open
editors. Disable supplementary reads with `superborrow.importContext:false`.
Imports are discovered from a bounded 32 KB header using a best-effort static
scanner; comments and template contents are ignored. Eight imports are probed,
including TS behind JS import specifiers and index files. Read results are cached
for two seconds/eight entries. Tracked source create/change/delete events cancel
stale predictions and clear completion/read caches. No local model is involved.

The [offline context check](evidence/offline-closed-import-context-2026-11-16.json)
used a closed synthetic Invoice interface with three required fields. Across
three paired rounds, all three fields appeared with imported references and zero
appeared without them. First read plus prompt preparation took 3.54 ms; the two
cached preparations took 0.39/0.34 ms. Prompt sizes were 1288 bytes enabled and
1114 disabled. Order alternated. No editor was launched and no model was called.
This establishes context availability and this fixture's preparation cost,
**not model correctness, production latency or Cursor superiority**.

**63 Node tests and 12 Rust tests passed**, together with strict Clippy,
TypeScript compilation and rustfmt. New coverage checks closed references,
non-persistence, open unsaved buffer precedence, RPC count/size limits, bounded
file count, exclusions, outside-workspace junctions, oversized/binary/invalid-UTF8
files, cancellation, missing-file tracking and ignored commented imports.
Repeat offline after packaging: `node extension/scripts/benchmark-imports.cjs`.
The 0.3.7 VSIX is built locally and has not been installed into the working IDE.
Latest full editor acceptance and matched Cursor results remain outstanding.

## Objective audit (2026-11-16)

The requested outcome is **faster and higher-quality Auto Tab than Cursor using
Antigravity account models, rather than local inference**. It is not achieved.

| Requirement | Current evidence | Verdict |
| --- | --- | --- |
| Antigravity account inference | IDE default in package.json; exported host `getModelResponse` path; real-account reports below | Demonstrated on measured fixtures |
| Faster document preparation | Offline 40-update burst: median 90.25 ms FIFO versus 2.84 ms coalesced; latest context checked | Demonstrated for that queued-burst workload |
| Low latency fresh suggestions | Fresh-prompt Hydrogen run: 1811.5 ms median across ten attempts | Still materially limited by model response time |
| Latest packaged editor acceptance | 0.3.4 full host suite accepted suggestions; newer isolated comparison harness did not accept ghost text | Not verified for 0.3.8 |
| Faster and higher quality than Cursor | No matched Cursor results exist | Unproven; required comparison missing |

Cursor must remain closed at the user's request, and the user's working
Antigravity session must remain untouched. Further completion claims require
actual comparable editor results, supplied independently or collected during a
suitable later test session. The experimental harness is not a substitute for
that evidence. The saved native capability probe exposed no native completion
RPC; the implemented exported model method returns a complete response. Local
queue/caching improvements do not establish a lower fresh-model latency.
No package has been installed into the working editor during this audit.

## Bounded document backlog — 0.3.6 (2026-11-16)

`DocumentSync` merges adjacent, still-queued snapshots for the same document into
the highest version. An in-flight payload cannot change. Prompt preparation,
close and updates to another document are ordering barriers, so a subsequent
edit cannot overtake preparation or change the context seen at that point.
Every merged caller observes the same transport failure; a failed snapshot can
retry. Intermediate micro-edits may be represented by one net history diff.

The [offline RPC benchmark](evidence/offline-sync-burst-2026-11-16.json) used a
synthetic 124.8 KB TypeScript document and 40 queued versions per burst. Each
strategy started with an initialized real Rust core and completed initial parse;
order alternated across three rounds. FIFO uses `withSnapshot` barriers with an
empty prepare callback, preserving one RPC per version on the same transport
path. The candidate uses ordinary updates. This intentionally measures a queued
burst, not normal spaced keystrokes, UI latency or model/server performance.
There were no inference calls and no editor was opened. The core in this
pre-release measurement was 0.3.5; the client carries the new coalescing change.

| Round | FIFO drain | Coalesced drain | RPCs | Source bytes sent |
| --- | --- | --- | --- | --- |
| 0 | 92.19 ms | 3.02 ms | 40 → 1 | 4,991,152 → 124,779 |
| 1 | 87.79 ms | 2.65 ms | 40 → 1 | 4,991,152 → 124,779 |
| 2 | 90.25 ms | 2.84 ms | 40 → 1 | 4,991,152 → 124,779 |

All six prepared prompts had the expected latest version and latest marker.
New tests cover 100 updates behind a blocked transport, in-flight payload
immutability, cross-document/preparation ordering, close/reopen, stale versions,
and shared failure/retry. **56 Node tests passed.** Repeat without opening any
editor or contacting any model: `npm --prefix extension run compile`, then
`node extension/scripts/benchmark-sync.cjs` (requires a packaged core binary).
Cursor superiority remains unverified.

## Automatic model selection — 0.3.5 (2026-11-16)

Automatic selection now excludes image/orchestrator models even when no enabled
text model remains. A low-reasoning Flash variant precedes heavier Flash variants;
explicit model pins remain respected. The primary Hydrogen Low preference is
unchanged: these account measurements do not justify switching it.

The [fresh-prompt comparison](evidence/antigravity-flash-comparison-2026-11-15.json)
used five synthetic tasks, two rounds and reversed model order in round two.
Each round adds a different trial comment; SHA-256 prompt hashes match across
models for each task/round. No background Superborrow inference occurred.
Six numeric input pairs are checked using a restricted AST interpreter for
Python, with no execution of generated code. These are ten observations per
model, not production percentiles. All-attempt medians include timeout durations.

| Account model | Correct within deadline | Timeouts | Median, all attempts |
| --- | --- | --- | --- |
| Hydrogen Low | 10/10 | 0 | 1811.5 ms |
| Flash Low | 7/10 | 3 | 2923 ms |

An [earlier comparison](evidence/antigravity-sonnet-comparison-2026-11-15.json)
repeated prompts between rounds, so prompt-cache effects are possible. Hydrogen
scored 9/10 (one timeout, 2375.5 ms all-attempt median); Sonnet Low scored 7/10
(three timeouts, 2882.5 ms all-attempt median). Sonnet's 1700 ms successful-only
median excludes failures and is insufficient grounds to change the default.
Both reports used the 0.3.4 core. New unit checks cover fallback ordering,
specialized-only catalogs and preservation of explicit model selection.

The 0.3.5 checkout passed **53 Node tests, 12 Rust tests, strict Clippy,
rustfmt and TypeScript compilation**. The Windows x64 VSIX was built locally;
it has not been installed into the user's working editor.

`extension/scripts/benchmark-editor.cjs` prepares isolated editor profiles and
owned synthetic fixtures for a future comparison of edit-to-accept latency.
`--app cursor --describe` prints its plan without launching or writing anything.
The user requested that Cursor remain closed; no Cursor benchmark was run.
The user's working Antigravity window must also remain untouched. Any live test
uses its own profile, extensions directory and files under `packages/`.
This harness is experimental until actual acceptance succeeds; absence of
accepted ghost text is not reported as model latency or correctness. Polling
acceptance every 500 ms measures scripted edit-to-accept time with that sampling
limit, not first-visible ghost text or physical Tab key latency. Function names
and numeric results are checked for both editors using the same versioned corpus.
The [three experimental attempts](evidence/antigravity-editor-harness-unavailable-2026-11-16.json)
did not accept ghost text. The instrumented explicit-trigger attempt completed a
model request in 2012 ms but accepted nothing; the automatic-trigger attempt was
cancelled by the editor. This is a harness/readiness limitation requiring further
investigation, not evidence that the model timed out. No further live windows are
opened while the user works in Antigravity.

## In-flight typing reuse — 0.3.4 (2026-11-15)

IDE mode can now prepare a prompt atomically against a synchronized snapshot,
then run the selected IDE model independently of subsequent core document
updates. The new read-only `prepareIdeCompletion` RPC does not infer or edit code.
The initialize capability gates this path; older cores and Local/Hybrid modes
keep the version-bound route. All inference still uses the selected account
model through the existing host API; no local model or private endpoint was added.

The client retains the oldest prediction across verified successive single
insertions at its cursor (at most 256 UTF-16 units), checking the entire snapshot
so the rest of the source must be unchanged. A fresh prediction for the latest
snapshot starts without waiting for the old one. Only an exact match between the
old output and the text actually typed can win; the already typed prefix is
removed. A mismatch leaves the fresh request running. At most two client-side
jobs are active: oldest and latest. Superseded jobs and losing competitors are
cancelled. No guarantee is made about how quickly a remote service releases
cancelled work. Model/context/diagnostic meaning changes, other relevant edits,
replacement/multiple edits, close and cursor changes invalidate the session.
Each caller cancels independently. Unclaimed jobs stop after 25 ms, or a bounded
750 ms handoff during confirmed typing, in addition to the end-to-end request
timeout (including debounce/preparation). Finished predictions remain bounded
by the usual short cache lifetime. No suggestion is automatically applied.

`superborrow.speculativeTyping` defaults to true in IDE mode. Disable it for the
single version-bound request route; concurrent predictions can consume additional
provider work/quota. The direct path applies the same fence/FIM-token/abstention
cleanup and UTF-8 output cap as the Rust route, with no second suffix trim.
Origin coordinates use the editor's line index; forwarded edits cannot change
the prefix before that origin.

Two unnecessary cancellation sources were fixed:

- Changes to excluded/nonparticipating virtual documents (including
  `vscode-userdata`) no longer invalidate code predictions or caches. A previously
  synchronized document becoming ineligible still cancels and is removed.
- An off-caret request cannot supersede an existing prediction at the actual
  editor caret. The live harness deliberately probes cursor zero to verify this.
  Factory fixtures now select the same caret as their requested position. An
  [initial mismatched fixture](evidence/antigravity-off-caret-fixture-0.3.4-2026-11-15.json)
  was rejected by this guard; its failure is retained rather than relabelled as a
  model response. Other original model, quality and acceptance assertions remain.

Validation:

- **49 Node and 12 Rust tests passed**, along with TypeScript, strict Clippy and
  rustfmt on Windows. Coverage includes both winner orders, mismatched old text,
  repeated typing with a two-job bound, late responses, emoji/CRLF, independent
  cancellation, deadlines for an uncooperative provider, atomic preparation,
  output normalization and prepared-context version checks.
- The [complete 0.3.4 real-account run](evidence/antigravity-full-0.3.4-2026-11-15.json)
  passed **18/18**, including code/comment fixtures, actual automatic acceptance,
  shared callers, continuation reuse and a second Antigravity model. Some language
  activation/diagnostic changes required one verified cancellation retry; model
  errors/timeouts were not retried. Warm continuation callbacks were 0.29, 0.39
  and 0.27 ms with no extra model calls.
- The [diagnostic/cache check on 0.3.4](evidence/antigravity-diagnostics-0.3.4-2026-11-15.json)
  passed through the prepared/native route: A was cached, changing only the
  diagnostic produced B at the same source version with one additional model
  request. The first fixture had one verified editor-cancellation retry.
- A [four-observation pre-release typing check](evidence/antigravity-speculative-2026-11-15.json)
  alternated enabled/disabled order using the same Antigravity model, a synthetic
  Python sum function, and one inserted space after 500 ms of inference. Each
  observation explicitly updated an excluded virtual log document and submitted
  an off-caret request. All four returned the correct remainder, with zero
  fixture retries and two model requests each. Enabled observations peaked at
  two client jobs; one old prediction won and one fresh prediction won.

| Round | Enabled: wait after edit | Disabled: wait after edit |
| --- | --- | --- |
| 0 | 1961.60 ms (fresh winner) | 3732.27 ms |
| 1 | 1418.41 ms (old prediction reused) | 3572.68 ms |

The reused model response took 1962 ms overall but the final caller waited
1418.41 ms, preserving roughly half a second of work already underway. These
are **two observations per mode**, not percentiles or a reliable general speedup;
service variance is material. Earlier unguarded observations also included a
round where enabled was slower. This does not establish sub-100-ms fresh
inference, or superiority to Cursor. The report's version is the pre-release
0.3.3 core carrying the new capability; the final 0.3.4 full/diagnostic checks
exercise the release implementation.

Repeat with `node extension/scripts/test-host.cjs --speculative-test` after
compilation, or `npm --prefix extension run test:host` for the complete suite.
The bounded lifecycle trace contains counts, versions and offsets, not source
text, model prompts or paths. Prepared predictions still require the initial
cloud round trip; overall Cursor speed/quality superiority remains unverified.

## Relevant context and diagnostics — 0.3.3 (2026-11-15)

The core builds a bounded in-memory symbol index when a document snapshot
changes, instead of traversing every open AST for each completion. Export
wrappers, interface/struct field shapes, class methods and default-import aliases
are included. Query-time selection ranks referenced names, owners, imported
module filenames and active-file declarations. Up to 12 candidates fit within
the context budget; unrelated open files no longer fill the prompt by URI order.
The index is deliberately bounded (128 symbols/document, 4096 visited nodes,
256 non-comment children/node); it is not a complete repository index.
Function bodies are not traversed. Long-file imports have a separate bounded
reference section. Languages without a grammar retain bounded import/package
lines but do not get AST symbol extraction.

The extension sends at most eight nearby errors/warnings, each at most 512 UTF-8
bytes, within 32 lines of the cursor. These are advisory editor messages, not
proof of code correctness; public editor diagnostics have no document-version
guarantee. The core ignores invalid/stale positions. Relevant diagnostic changes
invalidate cached and in-flight suggestions. When inline suggestions are enabled
and the same editor/version/cursor is still active, a coalesced 120 ms retry
prevents an asynchronous diagnostic update from leaving completion cancelled
until the next keystroke. The real editor's Position getters are explicitly
serialized as protocol coordinates (covered by a regression test).

`maxContextBytes` now includes chat instructions and framing. Minimum/default/
maximum budgets, UTF-8, and maximum-size Next Edit selections/instructions are
covered offline. The shorter prompt keeps the comment-implementation and
abstention requirements. Both FIM and chat prompts stay within the byte cap.

Validation:

- **38 Node tests and 12 Rust tests passed**; strict Clippy, rustfmt and TypeScript
  compilation passed on Windows. No new CI-run claim is made.
- The [complete real-account suite](evidence/antigravity-full-0.3.3-2026-11-15.json)
  passed **18/18**: Python, TS, Go, Rust, Java, SQL, HTML, CSS, Turkish implementation
  comments, abstention, continuation reuse, independent cancellation, actual
  automatic ghost-text acceptance and a second Antigravity account model.
  Language activation/diagnostic changes required 0–3 verified cancellation
  retries on some direct fixtures. Model failures/timeouts were not retried.
  Reused continuations returned in **0.25, 0.26, 0.31 ms** with no extra model
  requests. Three overlapping callers shared one successful model request.
- A [before/after check](evidence/antigravity-context-ab-2026-11-15.json) used the
  same Antigravity model for three source-specific field-name tasks twice,
  alternating variant order. The prior 0.3.2 release core scored **0/6**, and the
  pre-release candidate scored **6/6**. The tasks require an exported type's
  actual field, an active-file declaration beyond the cursor window, and a
  diagnostic's property hint. The report identifies both core binaries by SHA-256.
  This compares this project's versions, **not Cursor**. It is a small targeted
  quality check, not general coding accuracy; debug vs release builds and model
  variance make it unsuitable for a speed-superiority claim. Candidate successful
  requests took 1474–2060 ms (median 1651 ms).
- The [real extension diagnostic test](evidence/antigravity-diagnostics-2026-11-15.json)
  verified that a synthetic diagnostic reached the model, unchanged context
  reused the suggestion without inference, and replacing only that diagnostic
  produced a different model suggestion at the same document version. Its initial
  request had two verified editor-cancellation retries; the subsequent diagnostic
  change used exactly one extra model call. This test used the pre-release core.

Repeat with `npm --prefix extension run test:host` or, after compilation,
`node extension/scripts/test-host.cjs --diagnostics-test`. The A/B harness is
`node extension/scripts/test-host.cjs --context-benchmark`; it requires the saved
prior release binary at `packages/baseline-core-0.3.2.exe` (hash in the report),
plus the current debug binary. Do not replace that baseline with a new build.
All live fixtures are synthetic and use the signed-in account's quota.

Fresh inference still takes seconds in these samples. Faster first suggestions,
a same-corpus Cursor comparison, automatic edit-location prediction and arbitrary
cross-file edits remain unproven/unimplemented. The overall Cursor speed/quality
objective is **not complete**.

## Antigravity Tab optimization — 0.3.2 (2026-11-15)

New configurations and **Use Superborrow for Tab** use IDE-only routing. Explicit
existing Hybrid/Local preferences are preserved until the command is run. IDE
failure cannot trigger loopback inference in IDE mode (verified by a controlled
HTTP server receiving zero requests). Local transport remains an optional mode.

A single bounded continuation survives only successive insertions matching its
remaining text at the same UTF-16 cursor. Any divergent/replacement/multiple edit,
other document edit, model/configuration change or 15-second expiry invalidates
it. Partial acceptance, emoji and CRLF are covered offline. Identical empty
responses are cached for two seconds. Acceptance metadata stays with the
suggestion. Cancelled editor requests and invalid IntelliSense ranges stop before
inference. Initial model discovery retries after 1.5 seconds with exponential
backoff capped at 30 seconds, rather than always waiting 30 seconds.

The completion prompt now puts stable instructions before dynamic context,
requests minimal useful code matching indentation/names and joining the suffix,
and uses an explicit `<NO_COMPLETION>` response for abstention. The core strips
that exact marker; it never becomes ghost text. This is guidance, not a semantic
correctness guarantee or a measured provider prompt-cache improvement.

Validation:

- 34 Node tests, 7 Rust tests, strict Clippy, rustfmt and TypeScript passed.
- Windows x64 VSIX packaging passed (`packages/superborrow-0.3.2-win32-x64.vsix`).
- A [focused real-account test](evidence/antigravity-continuation-2026-11-15.json)
  passed using `antigravity:gemini-4-hydrogen-low`: three successive character
  insertions returned the exact remaining suggestion in **0.22, 0.14, 0.28 ms**,
  with **zero additional IDE model calls**. These are extension callback timings,
  not screen-rendering measurements or latency percentiles. Its initial fixture
  required one retry after a verified editor cancellation.
- The full live suite did **not** pass in this session. One run timed out on the
  unspecified-function fixture before the explicit abstention marker was added;
  another failed initial model discovery. The final full attempt passed Python,
  TypeScript, Go and Rust, then [timed out on Java](evidence/antigravity-optimization-full-timeout-2026-11-15.json)
  at the unchanged 10-second request limit. It did not reach the remaining cases.
  An initial focused attempt was cancelled by an overlapping editor invocation;
  the focused test now follows the full suite's policy of retrying only verified
  editor cancellations (not provider failures or timeouts).

Identical in-flight requests now share one inference. Each caller cancels
independently; an abandoned job has a 25 ms token-handoff window, while document
or configuration changes cancel immediately. A late response is checked again
against the caller's document version and context epoch before caching. A
[real-account check](evidence/antigravity-inflight-2026-11-15.json) verified three
concurrent callers, one cancelled caller, one model request and two shared joins.
The successful group returned in 2912 ms; one earlier editor cancellation was
retried. The combined [0.3.2 pipeline run](evidence/antigravity-pipeline-0.3.2-2026-11-15.json)
passed continuation reuse (0.62, 0.31, 0.31 ms) but its subsequent shared-call
case timed out at 10 seconds, so that combined run is recorded as failed. This is request deduplication, not faster remote inference. A flaky
older correlation test was also corrected: it now identifies snapshots from
unique content instead of assuming Tokio dispatch order.

A [three-model comparison](evidence/antigravity-model-comparison-2026-11-15.json)
used the same three synthetic tasks twice, in round-robin order, with a 6-second
per-request budget. Python outputs were scored by an allowlisted AST interpreter
on six numeric input pairs (no generated source is executed); the TypeScript
middle-gap fixture checks the missing operand. The initial regex wrongly
rejected valid conditional/if implementations. Those saved responses were
rescored without new model calls or changes to timing data.

| Model | Passed probes | Median successful request |
| --- | --- | --- |
| Gemini 4 Hydrogen (Low) | 4/6 | 2640.5 ms |
| Gemini 3.5 Flash Lite | 2/6 | 2413 ms |
| Gemini 3.8 Flash (Medium) | 3/6 | 5298 ms |

These tiny samples and successful-request medians are not latency percentiles;
failed/time-out requests remain in the report and quality denominators. No model
passed every probe. Flash Lite emitted `b</int>` in one middle-gap result. Auto
selection therefore remains unchanged rather than switching based on one fast
response. The opt-in comparison is `npm --prefix extension run benchmark:host`
and requires Python 3 in addition to the signed-in host.

Static inspection of the installed host's schema confirmed `GetModelResponse`
accepts only `prompt` and `model` and is unary. A separate generated
`GetCompletionsRequest` schema has `requested_model_id`, but a
[live capability probe](evidence/antigravity-native-capability-2026-11-15.json)
confirmed that the exported RPC client has **no `getCompletions` method**. No
private transport, credential extraction, or unsupported native-call fallback
was added. The probe can be repeated with
`node extension/scripts/test-host.cjs --native-probe` after compilation.

Run both pipeline checks with PowerShell:

```powershell
$env:SUPERBORROW_LIVE_FOCUS = 'pipeline'
npm --prefix extension run test:host
Remove-Item Env:SUPERBORROW_LIVE_FOCUS
```

The host RPC returns a complete string; this adapter cannot expose incremental
ghost text from that API. Fresh model responses still depend on service/network
latency. Cursor was installed and its IDE opened, but Computer Use was stopped by the
user with physical Escape before any synthetic Cursor test. No further UI input
was issued. No same-corpus Cursor baseline exists, so this establishes faster
continuation reuse and less duplicate inference, not superiority to Cursor.
Cursor also documents coordinated edits and next-location/cross-file predictions
([official feature reference](https://cursor.com/help/ai-features/tab)); those
remain beyond this release's insertion and explicit-selection Next Edit flow.
The diagnostics command prints IDE model-call count, continuation hits and the
last inline callback/provider times without source code or prompts.

## Comment implementation regression — 0.3.1

The earlier comment smoke assertion checked for `def`/`function`, so a body
containing only `pass` could pass it. The suite now requires an addition return
expression, one function declaration, and no placeholder for an addition request.
It also covers Python requests using `//`, older unrelated `pass` functions in
the active file, suppression of the unspecified `//create function` request,
and automatic comment-newline triggering with Superborrow's own acceptance
callback. The host profile uses default context/debounce/timeout and IntelliSense
settings instead of shortened context and disabled quick suggestions.

The final 0.3.1 core passed 16 real-account checks; see the
[synthetic report](evidence/antigravity-comment-regression-2026-11-15.json).
Direct factory checks keep automatic inline rendering off to avoid competing
invocations, then re-enable it for the two real editor acceptance checks.
Every run uses a separate test profile; factory fixtures remain unopened.
This is prompt guidance backed by regression
examples, not a guarantee of model correctness or a general semantic validator.
An unspecified function request cannot establish the desired implementation;
the user must state its behavior.

## Original 0.3.0 evidence

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
