# v1 public contract

Agentic QA 1.0.0 freezes the audited product behavior as its v1 contract. The CLI and persisted JSON
artifacts below are public. TypeScript modules under `dist/` are implementation details: the npm
package intentionally declares a `bin` entry but no `main`, `exports`, or `types` API.

## Stable CLI surfaces

| Command    | Required input                          | Purpose                                                                                 |
| ---------- | --------------------------------------- | --------------------------------------------------------------------------------------- |
| `inspect`  | URL                                     | One-page Chromium inspection                                                            |
| `explore`  | URL                                     | Deterministic same-origin page exploration; `--interactive` opts into safe state clicks |
| `plan`     | `exploration.json`                      | Bounded provider-neutral QA planning                                                    |
| `run`      | `qa-plan.json`                          | LLM-free graph-backed execution                                                         |
| `verify`   | `execution.json`                        | Isolated deterministic reproduction and verdicts                                        |
| `generate` | `findings.json`                         | LLM-free Playwright regression rendering                                                |
| `export`   | `manifest.json`, `--target`             | Dry-run preview and explicitly approved target writes                                   |
| `pipeline` | URL                                     | `explore --interactive → plan → run → verify → generate → report`                       |
| `report`   | source-run directory or `pipeline.json` | Offline deterministic HTML rerender                                                     |

Global flags are `--help`, `--version`, and `--no-color`; `NO_COLOR` is also respected. The full
per-command flag list and defaults are authoritative in `agentic-qa <command> --help` and mirrored
in the README. `pipeline --json` and `export --json` reserve stdout for a single success document;
on command failure they keep stdout empty and emit one JSON error document to stderr.

## Stable environment configuration

Version 1 recognizes these names:

```text
AGENTIC_QA_NAVIGATION_TIMEOUT_MS
AGENTIC_QA_HEADLESS
AGENTIC_QA_VIEWPORT_WIDTH
AGENTIC_QA_VIEWPORT_HEIGHT
AGENTIC_QA_ARTIFACTS_DIR
AGENTIC_QA_MAX_PAGES
AGENTIC_QA_MAX_DEPTH
AGENTIC_QA_MAX_QUERY_VARIANTS_PER_PATH
AGENTIC_QA_MAX_STATES
AGENTIC_QA_MAX_ACTIONS_PER_STATE
AGENTIC_QA_MAX_STATE_DEPTH
AGENTIC_QA_LLM_BASE_URL
AGENTIC_QA_LLM_API_KEY
AGENTIC_QA_LLM_MODEL
AGENTIC_QA_LLM_TIMEOUT_MS
AGENTIC_QA_MAX_EXECUTION_SCENARIOS
AGENTIC_QA_MAX_STEPS_PER_SCENARIO
AGENTIC_QA_EXECUTION_TIMEOUT_MS
AGENTIC_QA_STEP_TIMEOUT_MS
AGENTIC_QA_VERIFY_ATTEMPTS
AGENTIC_QA_MAX_VERIFY_FINDINGS
AGENTIC_QA_VERIFY_TIMEOUT_MS
AGENTIC_QA_MAX_GENERATED_TESTS
AGENTIC_QA_MAX_GENERATED_STEPS_PER_TEST
AGENTIC_QA_MAX_GENERATED_ASSERTIONS_PER_TEST
AGENTIC_QA_EXPORT_VALIDATION_TIMEOUT_MS
AGENTIC_QA_DEBUG
```

CLI values override environment values; pipeline profile values are the final defaults. The API
key has deliberately no CLI flag.

## Artifact and failure contract

The schema matrix is maintained in [SCHEMA_COMPATIBILITY.md](SCHEMA_COMPATIBILITY.md). JSON is the
source of truth; Markdown and HTML are deterministic views. Relative artifact paths are scoped to
the source run.

Pipeline orchestration creates the source-run directory before Chromium startup. A startup failure
therefore produces schema 1.1 `pipeline.json` and `report.html` with a failed `explore` stage,
downstream stages `NOT_RUN`, and `artifacts.exploration: null`. If even the artifact root cannot be
created, no file can truthfully be persisted; `pipeline --json` instead emits a structured
`ARTIFACT_WRITE_FAILED` error to stderr.

## Exit codes

| Commands                     | `0`                                 | `1`                                              | `2`                                               |
| ---------------------------- | ----------------------------------- | ------------------------------------------------ | ------------------------------------------------- |
| `inspect`, `explore`, `plan` | Completed                           | Input/runtime failure (historical behavior)      | Not used                                          |
| `report`                     | Rendered                            | Not used                                         | Invalid source or infrastructure failure          |
| `run`                        | No mismatch/block/error             | Application mismatch or safety block             | Configuration/executor/infrastructure failure     |
| `verify`                     | No confirmed/probable/flaky finding | Defect finding exists                            | Configuration/verification/infrastructure failure |
| `generate`                   | Completed cleanly                   | Eligible review/unsupported item exists          | Source/integrity/generation failure               |
| `export`                     | Clean preview/apply                 | Conflict, warning, review, or validation failure | Source/target/configuration failure               |
| `pipeline`                   | Complete without defect signals     | Complete with findings/regressions               | Fatal pipeline stage failure                      |

Commander usage errors are nonzero and write usage diagnostics to stderr. Stack traces appear only
when `AGENTIC_QA_DEBUG=true`; API key values remain redacted from controlled provider diagnostics.

## Error categories

Stable machine-readable categories are configuration, artifact/browser/navigation, provider,
planning schema/grounding, execution source/integrity/plan, verification source/integrity,
regression source/integrity/generation, export source/target/conflict/write, pipeline, and report
source errors. Optional export validation is a structured receipt outcome with exit code `1`, not
an exception code. Exact human prose may improve in compatible patch releases; error codes and
safety meaning are the automation contract.

## Explicitly internal

- application/browser ports and TypeScript classes under `dist/`;
- regression intermediate representation;
- provider HTTP response parsing details;
- internal evidence ranking and bounded compilation heuristics;
- temporary filenames and in-process orchestration objects;
- Markdown/HTML layout and CSS.

No compatibility is promised for importing internal files by path. Generated Playwright specs are
portable artifacts and import only `@playwright/test`, not Agentic QA internals.
