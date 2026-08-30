# Agentic QA

Agentic QA is an open-source CLI for evidence-based web application QA. It explores a site with
real Chromium, asks a provider-neutral LLM only to propose a grounded test plan, executes that plan
through deterministic graph references, verifies reproducibility, generates reviewable
Playwright regressions, and exports them only after explicit human approval.

Current version: **0.9.0**. This is a v1 release-candidate audit build, not an npm-published
package and not a v1 release.

## What it can do

- inspect one page or deterministically explore same-origin pages and safe UI states;
- collect screenshots, Playwright traces, console/page/network/HTTP evidence, and page/state graphs;
- create a bounded structured QA plan through an OpenAI-compatible HTTP adapter;
- execute only grounded `AUTOMATABLE` `NAVIGATE`/`CLICK` scenarios without an LLM;
- distinguish confirmed, probable, flaky, not-reproduced, and inconclusive signals;
- generate portable Playwright TypeScript specs that fail on the verified regression and pass on
  the observed healthy state;
- produce a static local HTML report and safely preview/apply regression export into a TypeScript
  Playwright project.

It does **not** fill forms, handle authentication or credentials, infer root cause, analyze pixels,
fix application code, publish packages, create issues/PRs, or commit/push target repositories.

## Five-minute quick start

Requirements: Node.js 24 LTS or newer and npm.

```sh
git clone https://github.com/zarmih/agentic-qa.git
cd agentic-qa
npm install
npx playwright install chromium
npm run build
npm link # optional; exposes agentic-qa locally
```

Configure an OpenAI-compatible planning endpoint (the API key is optional for explicitly
unauthenticated local endpoints), then run the bounded product pipeline:

```sh
export AGENTIC_QA_LLM_BASE_URL=http://127.0.0.1:11434/v1
export AGENTIC_QA_LLM_MODEL=my-model
export AGENTIC_QA_LLM_API_KEY= # omit when authentication is not required

agentic-qa pipeline http://localhost:3000 \
  --provider openai-compatible \
  --model my-model
```

The pipeline stops after regression generation. Review the artifacts, preview export, then apply
only when the plan is correct:

```sh
agentic-qa export artifacts/<run-id>/regressions/<generation-id>/manifest.json \
  --target ../my-web-app

agentic-qa export artifacts/<run-id>/regressions/<generation-id>/manifest.json \
  --target ../my-web-app \
  --apply
```

The first command is a dry run and does not modify the target. Artifacts are stored in
`artifacts/<run-id>/` by default and are intentionally ignored by Git.

If Chromium is absent, browser commands fail with an installation hint instead of silently
downloading a browser. Run `npx playwright install chromium` explicitly.

## Safety model

```text
Browser observation (untrusted website data)
        ↓
LLM planning (no browser, shell, filesystem, or tools)
        ↓ schema + grounding + deterministic safety
Constrained LLM-free execution and verification
        ↓
Deterministic regression IR and escaped TypeScript
        ↓
Dry-run export preview
        ↓ explicit --apply
Human-approved target write
```

Website text, plans, execution files, findings, manifests, and generated source are all treated as
untrusted input at their boundaries. Destructive/caution/unknown actions, forms, arbitrary URLs,
arbitrary selectors, and model-provided code never execute. SHA-256 detects artifact changes but
is not a digital signature or proof of author identity.

## Manual pipeline

```sh
agentic-qa inspect https://example.com
agentic-qa explore https://example.com --interactive
agentic-qa plan artifacts/<run-id>/exploration.json --model <model>
agentic-qa run artifacts/<run-id>/planning/qa-plan.json
agentic-qa verify artifacts/<run-id>/executions/<execution-id>/execution.json --attempts 3
agentic-qa generate artifacts/<run-id>/verifications/<verification-id>/findings.json
agentic-qa export artifacts/<run-id>/regressions/<generation-id>/manifest.json --target ../app
```

During development, prefix commands with the corresponding npm script, for example
`npm run explore -- <url> --interactive` or `npm run pipeline -- <url> --model <model>`.

## Configuration

| Environment variable                           |     Default | Purpose                                          |
| ---------------------------------------------- | ----------: | ------------------------------------------------ |
| `AGENTIC_QA_NAVIGATION_TIMEOUT_MS`             |     `30000` | Per-page navigation timeout                      |
| `AGENTIC_QA_HEADLESS`                          |      `true` | Run Chromium without a visible window            |
| `AGENTIC_QA_VIEWPORT_WIDTH`                    |      `1440` | Browser viewport width                           |
| `AGENTIC_QA_VIEWPORT_HEIGHT`                   |       `900` | Browser viewport height                          |
| `AGENTIC_QA_ARTIFACTS_DIR`                     | `artifacts` | Artifact root, relative to the working directory |
| `AGENTIC_QA_MAX_PAGES`                         |        `25` | Maximum exploration navigation attempts          |
| `AGENTIC_QA_MAX_DEPTH`                         |         `3` | Maximum BFS depth; start page is depth 0         |
| `AGENTIC_QA_MAX_QUERY_VARIANTS_PER_PATH`       |         `5` | Query variants allowed per origin and path       |
| `AGENTIC_QA_MAX_STATES`                        |        `12` | Unique UI states across an interactive run       |
| `AGENTIC_QA_MAX_ACTIONS_PER_STATE`             |         `4` | Safe actions attempted from one state            |
| `AGENTIC_QA_MAX_STATE_DEPTH`                   |         `2` | Maximum replay action-path depth                 |
| `AGENTIC_QA_LLM_BASE_URL`                      |  _required_ | OpenAI-compatible API base URL                   |
| `AGENTIC_QA_LLM_API_KEY`                       |       empty | Optional bearer key, read only from environment  |
| `AGENTIC_QA_LLM_MODEL`                         |  _required_ | Model name when `--model` is not supplied        |
| `AGENTIC_QA_LLM_TIMEOUT_MS`                    |     `30000` | Bounded planning request timeout                 |
| `AGENTIC_QA_MAX_EXECUTION_SCENARIOS`           |        `20` | AUTOMATABLE scenarios selected by priority       |
| `AGENTIC_QA_MAX_STEPS_PER_SCENARIO`            |        `10` | Hard step cap for one execution scenario         |
| `AGENTIC_QA_EXECUTION_TIMEOUT_MS`              |    `300000` | Bounded duration of an execution run             |
| `AGENTIC_QA_STEP_TIMEOUT_MS`                   |      `5000` | Bounded browser action timeout                   |
| `AGENTIC_QA_VERIFY_ATTEMPTS`                   |         `3` | Isolated attempts per rerunnable candidate       |
| `AGENTIC_QA_MAX_VERIFY_FINDINGS`               |        `10` | Maximum candidates selected for verification     |
| `AGENTIC_QA_VERIFY_TIMEOUT_MS`                 |    `900000` | Global bounded verification duration             |
| `AGENTIC_QA_MAX_GENERATED_TESTS`               |        `20` | Maximum generated regression specs               |
| `AGENTIC_QA_MAX_GENERATED_STEPS_PER_TEST`      |        `12` | Hard graph-action cap per generated spec         |
| `AGENTIC_QA_MAX_GENERATED_ASSERTIONS_PER_TEST` |         `5` | Hard assertion cap per generated spec            |
| `AGENTIC_QA_EXPORT_VALIDATION_TIMEOUT_MS`      |     `30000` | Bounded optional target Playwright list timeout  |
| `AGENTIC_QA_DEBUG`                             |     `false` | Print diagnostic stack traces for CLI failures   |

`inspect` and `explore` accept `--headed`, `--timeout <milliseconds>`, and
`--artifacts-dir <path>`.
`explore` additionally accepts `--max-pages`, `--max-depth`, `--max-query-variants`,
`--max-states`, `--max-actions-per-state`, and `--max-state-depth`. Interactive exploration is
enabled only by `--interactive`; limit options override their corresponding environment values.
`plan` accepts `--provider openai-compatible`, `--model`, and `--llm-timeout`. CLI model and timeout
values override environment values. API keys intentionally have no CLI option.
`run` accepts `--exploration`, `--headed`, `--max-scenarios`, `--step-timeout`, and
`--execution-timeout`. `--exploration` is required when a copied plan is not in the standard
`<run>/planning/qa-plan.json` layout. There is no unsafe, force-manual, or safety-disable option.
`verify` accepts `--attempts` (hard range 2–10), `--max-findings`, and `--headed`. It requires the
standard `<run>/executions/<execution-id>/execution.json` layout so source linkage is unambiguous.
`generate` accepts `--max-tests`, `--include-flaky`, and an optional HTTP(S) origin-only
`--base-url`. Origin substitution preserves graph-owned paths and queries; unsupported protocols,
credentials, paths, queries, and fragments in the override are rejected.
`pipeline` accepts the `quick`, `standard`, or `thorough` profile plus focused overrides for page
count, state count, verification attempts, and generated-test count. CLI values override
environment values, which override profile values. `export` accepts `--tests-dir`, `--apply`,
`--overwrite`, `--validate`, and `--json`; overwrite and validation are invalid without `--apply`.
`pipeline --json` and `export --json` reserve stdout for one JSON document. Use global
`--no-color` or `NO_COLOR` for plain CI logs.

## Safe exploration behavior

Exploration uses a stable FIFO queue. Links are processed in DOM order, fragments are removed,
relative URLs are resolved against the final redirected URL, and query strings are preserved.
Non-root trailing slashes are deliberately preserved because a server may treat `/path` and
`/path/` as different resources.

Only URLs with the start URL's exact scheme, hostname, and port are eligible for navigation.
External and unsupported links are retained as graph edges but never visited. A conservative
read-only policy also blocks routes whose path or explicit action parameter indicates operations
such as logout, delete, purchase, or unsubscribe. There are no automatic retries, keeping ordering
and request counts reproducible.

Each exploration run writes:

```text
artifacts/<run-id>/
├── exploration.json
├── graph.json
├── trace.zip
└── pages/
    ├── 001-home.png
    └── 002-products.png
```

Evidence contains only `console.error`, `console.warn`, uncaught page errors, failed requests, and
HTTP responses with status 400 or higher. Bodies and ordinary console logs are not stored, and
per-page plus run-level caps keep output bounded. Navigation failures are page-level results, so a
timeout or unreachable route does not discard successful pages collected earlier.

## Interactive state exploration

Interactive exploration is intentionally conservative and deterministic. It discovers visible
controls in DOM order, classifies every candidate, and executes only `SAFE` clicks. Examples are
menus, dialogs, tabs, disclosures, accordions, and explicitly browsing-oriented controls. `CAUTION`
actions such as save/create/submit, `DESTRUCTIVE` actions such as delete/buy/logout/publish, and
all `UNKNOWN` controls are recorded but blocked. Hidden or disabled controls, form submissions,
file uploads, and mutable form controls are also never executed. Safety has no disable flag.

Each UI state has a bounded fingerprint derived from its canonical URL, title, visible headings,
dialogs, semantic control names/roles, and selected or expanded state. Raw HTML, generated IDs,
test IDs, analytics attributes, and fragments are not fingerprint inputs. This suppresses common
dynamic noise without merging query-based application states.

State traversal uses BFS. To explore two branches from the same source, the browser opens a fresh
Playwright page in the run's existing traced context, navigates to the base page, replays the saved
semantic action path, verifies the expected source fingerprint, and only then attempts the next
safe click. It does not rely on browser history. A visited `(state fingerprint + action identity)`
set terminates open/close cycles, while the three conservative limits bound replay complexity.

Dialogs are always dismissed, downloads are cancelled after metadata capture, and popups are
closed. Same-origin popup URLs may be registered for normal page exploration; external popups are
recorded but never explored. Click failures are action-level evidence and do not abort the run.

An interactive run adds state artifacts:

```text
artifacts/<run-id>/
├── exploration.json
├── graph.json
├── state-graph.json
├── trace.zip
├── pages/
│   └── 001-home.png
└── states/
    ├── state-001.png
    └── state-002.png
```

`state-graph.json` contains state nodes, reproducible semantic action edges, per-action browser
evidence, structured action failures, and a bounded safety audit entry for every discovered
candidate. `exploration.json` embeds the same graph plus interactive summary and limit status.

## QA planning

Configure an OpenAI-compatible HTTP endpoint, then plan from a completed interactive exploration:

```sh
export AGENTIC_QA_LLM_BASE_URL=http://127.0.0.1:11434/v1
export AGENTIC_QA_LLM_MODEL=<model>
# Set AGENTIC_QA_LLM_API_KEY only when the configured endpoint requires bearer authentication.

agentic-qa plan artifacts/<run-id>/exploration.json \
  --provider openai-compatible
```

The adapter uses the JSON chat-completions protocol. Compatibility with a particular hosted or
local service depends on that service implementing the expected protocol; automated adapter tests
use only a controlled local fake endpoint and never make paid or public API calls.

Planning follows a strict one-way boundary:

```text
exploration.json
  → bounded observation compiler
  → trusted prompt + untrusted application data
  → reasoning provider port
  → JSON schema validation
  → graph grounding validation
  → deterministic safety and executability policy
  → coverage analysis
  → planning artifacts
```

Website titles, headings, control names, URLs, errors, and other captured text are always enclosed
as `UNTRUSTED_APPLICATION_DATA`; they are never placed in the trusted system instructions. The
planner prompt explicitly rejects instructions found in that data and exposes no browser, shell,
filesystem, or tool capability. Model output is also untrusted until it passes strict Zod schema
validation and semantic checks for every page, state, action, candidate, and evidence identifier.

The observation compiler deterministically prioritizes HTTP 5xx responses, page and console
errors, action failures, failed requests, error-bearing states, navigation, forms, dialogs, and
blocked controls. Defaults cap input at 30 pages, 40 states, 100 evidence entries, 150 blocked
candidate summaries, 100 transitions, and 50,000 serialized characters. Truncation is reported in
the observation and final plan metadata rather than being silent.

Only observed `SAFE` action edges can support an automatable click. Plans involving destructive or
caution semantics, or a blocked candidate such as delete, checkout, publish, logout, save, or
submit, are deterministically changed to `MANUAL_ONLY`; the model cannot override that decision.
Malformed JSON or schema output receives at most one bounded repair request. Grounding failures are
not repaired into acceptance.

A successful planning run adds:

```text
artifacts/<run-id>/
├── exploration.json
├── graph.json
├── state-graph.json
├── trace.zip
├── pages/
├── states/
└── planning/
    ├── observation.json
    ├── qa-plan.json
    └── qa-plan.md
```

`qa-plan.json` is the source of truth. It includes provider/model metadata, request duration,
optional token usage, repair count, truncation data, deterministic executability, coverage, and
quality warnings. Version 1.1 also binds the plan to the exact exploration, bounded observation,
page graph, and state graph with canonical SHA-256 digests. `qa-plan.md` is rendered locally from
the validated plan; the provider is not asked to generate a separate report. API keys are never
added to prompts, output, errors, or artifacts, and exact configured secret values are defensively
redacted before persistence.

## Executing QA plans

Run a completed plan from its standard artifact layout:

```sh
agentic-qa run artifacts/<run-id>/planning/qa-plan.json
```

For a copied/portable source-run bundle whose plan location no longer permits unambiguous
inference, provide its `exploration.json` explicitly (the bound `observation.json`, `graph.json`,
and `state-graph.json` must travel with the bundle):

```sh
agentic-qa run ./qa-plan.json --exploration ./exploration.json
```

Execution is a separate, provider-free pipeline:

```text
qa-plan.json (untrusted)
  → strict schema + source SHA-256 validation
  → fresh grounding, executability, safety, and graph validation
  → deterministic scenario compiler
  → isolated Playwright replay from the source graph
  → runtime semantic safety validation
  → URL/state-fingerprint assertions
  → execution evidence and reports
```

Only `AUTOMATABLE` scenarios are eligible. `MANUAL_ONLY` and `UNSUPPORTED` scenarios remain in the
report as `SKIPPED`. Execution supports only `NAVIGATE` to an existing `pageId` and `CLICK` through an
existing observed SAFE `actionId`; any unsupported step skips the whole scenario. Plan-provided
URLs, CSS, XPath, text selectors, JavaScript, and natural-language instructions never become
browser commands. Free-text objectives and expected outcomes are retained only as human context.

Before every click, the runtime restores the source state from a clean page through the recorded
semantic replay path, verifies fingerprints, requires one unique locator match, compares role,
accessible name, type, href, relevant ARIA state, and form association, and re-runs the conservative
risk classifier. Missing, ambiguous, stale, out-of-scope, form-associated, or semantically changed
actions are `BLOCKED` before clicking. Destructive, caution, and unknown controls can never be
forced. Cookies and permissions are cleared between scenarios, local/session storage is cleared by
a fixed internal init script, service workers are blocked, and browser pages are closed after each
step. Authentication and form-data workflows remain unsupported.

Deterministic result meanings are:

- `PASS` — every required graph-backed step ran and its URL/fingerprint assertion matched.
- `FAIL` — the application reached a different observable URL or UI state than the source graph.
- `BLOCKED` — runtime safety, drift, scope, uniqueness, or stale-source validation prevented an
  action.
- `ERROR` — a browser/executor infrastructure failure or bounded timeout prevented evaluation.
- `SKIPPED` — a manual, unsupported, over-limit, or dependent step/scenario was not executed.

Console errors and other evidence do not automatically turn a structurally correct transition
into `FAIL`. They are retained as runtime evidence, attributed to scenario/step, and compared with
cited source evidence using deterministic signatures. A later explicit `verify` invocation—not
the executor—decides whether a signal is repeatable enough to become a defect finding.

Each invocation creates a new execution directory, so one source run can be executed repeatedly:

```text
artifacts/<run-id>/
├── exploration.json
├── graph.json
├── state-graph.json
├── planning/
│   ├── observation.json
│   ├── qa-plan.json
│   └── qa-plan.md
└── executions/
    └── <execution-id>/
        ├── execution.json
        ├── execution.md
        ├── trace.zip
        └── screenshots/
            └── scenario-001/
                ├── 000-start.png
                └── 001.png
```

`execution.json` schema 1.1 is the source of truth and includes a canonical SHA-256 result payload
digest; Markdown is rendered deterministically without an LLM.
Exit code `0` means no FAIL/BLOCKED/ERROR, `1` means an application mismatch or safety block was
reported, and `2` means an execution/configuration error. Legacy plan schema 1.0 artifacts have
no integrity metadata and are rejected with an explicit instruction to run `plan` again. Legacy
execution schema 1.0 lacks result integrity and must be regenerated with `run` before verification.

## Verifying defects

Verify an execution result from its standard source-run layout:

```sh
agentic-qa verify \
  artifacts/<run-id>/executions/<execution-id>/execution.json \
  --attempts 3
```

The command performs no planning call and needs no API key. Its one-way flow is:

```text
execution.json (untrusted)
  → strict schema and payload-integrity validation
  → plan/exploration/observation/graph linkage validation
  → deterministic candidate extraction
  → isolated constrained scenario reruns
  → failure/evidence signature analysis
  → reproducibility, severity, and confidence policy
  → findings and reports
```

Structural `FAIL` scenarios are primary candidates. A structurally passing scenario is selected
only when it reproduced a step-attributed, same-origin page error, HTTP 5xx, relevant failed
document/script/XHR/fetch request, or console error. Asset 404s, external analytics failures,
console warnings, unattributed evidence, `BLOCKED`, and `ERROR` are not promoted to confirmed
application defects. `BLOCKED` and source execution errors are retained as inconclusive context
without automatic reruns.

For the default three attempts, the deterministic policy is:

- `CONFIRMED_DEFECT`: 3/3 valid attempts reproduce one identical signature.
- `PROBABLE_DEFECT`: at least two valid attempts all reproduce one signature, but another requested
  attempt was invalid.
- `FLAKY_DEFECT`: the same signature appears in only part of at least two valid attempts.
- `NOT_REPRODUCED`: no valid attempt repeats the source signal.
- `INCONCLUSIVE`: fewer than two valid attempts, a safety/drift block, an infrastructure problem,
  or multiple incompatible failure signatures prevent a defensible verdict.

The source execution is shown separately and is never counted as one of the requested verification
attempts. Every attempt calls the existing constrained executor for exactly one grounded scenario.
It starts a fresh Playwright browser and BrowserContext, so cookies, local/session storage,
IndexedDB, cache, permissions, pages, and service-worker state do not cross attempt boundaries.
The same runtime semantic drift, form, scope, action-risk, locator-uniqueness, and graph assertion
checks apply; verification has no mechanism to weaken execution safety.

Signatures retain both raw and normalized forms. Normalization is deliberately narrow: obvious
UUIDs, ISO timestamps, long request/run identifiers, localhost ports, fragments, and query order
are normalized, while paths, query values, HTTP statuses, methods, failure codes, expected targets,
and actual state fingerprints remain meaningful. Multiple incompatible signatures are not merged
into a confirmed defect. Finding IDs are stable short hashes of the logical source signature.

Severity is conservative and deterministic. Confirmed/probable HTTP 5xx findings are `HIGH` only
for a `CRITICAL`/`HIGH` source scenario and otherwise `MEDIUM`;
page errors and relevant failed requests are `MEDIUM`; structural mismatches are normally `MEDIUM`
and reach `HIGH` only for a stable `CRITICAL` source scenario; console-only errors are capped at
`LOW`; not-reproduced and inconclusive signals are `INFO`. Plan priority is only one input and
never establishes business impact by itself. Confidence is `VERY_HIGH` for confirmed, `HIGH` for
probable, `MEDIUM` for flaky, `HIGH`/`MEDIUM` for not-reproduced depending on valid sample count,
and `LOW` for inconclusive findings.

Runtime evidence and screenshots are associated with findings, but association is explicitly not
presented as causation. Verification performs no root-cause analysis and makes no visual/pixel verdict.
Canonical SHA-256 digests detect changed source artifacts and bind plan, observation, graphs,
exploration, and execution payloads together. They provide integrity, not cryptographic author
authenticity or provenance; there is no signing key.

Each invocation creates a new verification tree and preserves per-attempt execution reports:

```text
artifacts/<run-id>/
├── exploration.json
├── planning/
│   └── qa-plan.json
├── executions/
│   └── <execution-id>/
│       └── execution.json
└── verifications/
    └── <verification-id>/
        ├── verification.json
        ├── findings.json
        ├── verification.md
        └── attempts/
            └── <candidate-id>/
                └── attempt-001/
                    ├── execution.json
                    ├── execution.md
                    ├── trace.zip
                    └── screenshots/
```

`verification.json` schema 1.1 contains candidates, attempts, signature distributions, variance, timings,
warnings, findings, and source digests. `findings.json` is the standalone defect-finding source of
truth. Both verification result artifacts carry canonical payload integrity and a verification-to-
findings digest binding; legacy schema 1.0 artifacts must be regenerated with `verify` before
regression generation accepts them. `verification.md` is rendered locally without an LLM. Exit code `0` means no
confirmed/probable/flaky finding, `1` means at least one such finding exists, and `2` means a
verification/configuration/infrastructure failure or global verification timeout occurred.

## Generating regression tests

Generate reviewable Playwright specs from a completed verification:

```sh
agentic-qa generate \
  artifacts/<run-id>/verifications/<verification-id>/findings.json
```

Generation is a deterministic, provider-free pipeline:

```text
findings.json (untrusted)
  → schema, payload, verdict, and full source-linkage validation
  → confirmed-finding eligibility policy
  → graph-backed scenario compiler
  → typed regression IR
  → unique semantic locator + state assertion compiler
  → escaped TypeScript renderer
  → TypeScript/@playwright-test validation
  → reviewable artifacts
```

Only `CONFIRMED_DEFECT` findings with a safe positive assertion generate active tests.
`PROBABLE_DEFECT` is recorded as `REVIEW_ONLY`; `FLAKY_DEFECT` is omitted by default and becomes a
disabled `test.fixme` spec only with `--include-flaky`. `NOT_REPRODUCED`, `INCONCLUSIVE`, and
`NON_DEFECT_SIGNAL` never become executable regressions. Console/page-error/failed-request-only
findings are review-only unless a future stage defines an equally strong positive contract.

Generated actions are limited to source-graph `NAVIGATE` and observed SAFE `CLICK` edges. The
compiler reuses execution sequence and replay validation, re-applies action-risk/form/scope policy,
and requires a unique semantic locator. Supported locator output is `getByTestId`, `getByRole`,
`getByLabel`, stable ID, or exact `getByText`; indexed matches, XPath, broad CSS, selectors supplied
by findings, and arbitrary URLs are rejected. Form interaction, credentials, authentication,
uploads, keyboard input, and JavaScript evaluation remain unsupported.

UI assertions describe the expected healthy graph state—not the presence of the defect. The
compiler selects one minimal positive discriminator: a newly visible dialog/heading, selected tab,
expanded disclosure, or expected canonical URL. A step-attributed, same-origin, consistently
verified document/XHR/fetch HTTP 5xx may produce a technical `status < 500` assertion. It does not
generate active tests for third-party, asset, or console-only noise.

All application text is rendered only through escaped JavaScript string literals. Quotes,
backticks, interpolation syntax, line breaks, control characters, and Unicode separators cannot
become source code. Generated specs import only `@playwright/test` and never import Agentic QA
internals. Each file is syntax/type checked during generation and receives a SHA-256 byte digest in
the manifest. The command writes files only—it never visits the target, modifies another project,
commits, pushes, or opens a pull request.

```text
artifacts/<run-id>/
└── regressions/
    └── <generation-id>/
        ├── manifest.json
        ├── README.md
        └── tests/
            ├── DEF-760D270E.spec.ts
            └── DEF-705553CE.spec.ts
```

`manifest.json` schema 1.1 records generated, fixme, review-only, unsupported, over-limit, and duplicate
outcomes, source-chain digests, spec digests, assertions, limits, and a canonical payload digest.
Legacy manifest schema 1.0 remains exportable only after the entire source chain, deterministic
compilation, source bytes, assertions, and per-file digests are revalidated; legacy input is never
silently trusted. Generation exit code `0`
means generation completed without eligible review/unsupported items, `1` means artifacts were
created but a probable or supported-verdict candidate still requires review, and `2` means source,
integrity, configuration, or generation validation failed. As elsewhere in the project, SHA-256
detects content changes; it is not author authentication or a digital signature.

## Unified pipeline

`pipeline` composes the existing application services in process; it does not shell out to its own
CLI or introduce another exploration/execution engine:

```sh
agentic-qa pipeline http://localhost:3000 \
  --profile standard \
  --provider openai-compatible \
  --model my-model
```

| Profile    | Pages | Page depth | States | Actions/state | State depth | Verify attempts | Findings | Specs |
| ---------- | ----: | ---------: | -----: | ------------: | ----------: | --------------: | -------: | ----: |
| `quick`    |     5 |          1 |      8 |             3 |           1 |               2 |        5 |     5 |
| `standard` |    25 |          3 |     12 |             4 |           2 |               3 |       10 |    20 |
| `thorough` |    50 |          4 |     25 |             6 |           3 |               5 |       20 |    40 |

The command always uses interactive safe exploration and then runs `plan → run → verify →
generate`. Application mismatches (`run` exit 1) and defect findings (`verify` exit 1) are useful
pipeline outcomes and do not stop later stages. Configuration, provider, integrity, browser, or
artifact infrastructure failures do stop the flow. `pipeline.json` records every stage as `PASS`,
`COMPLETED_WITH_FINDINGS`, `FAILED`, or `NOT_RUN`, along with timings, summaries, errors, and
relative artifact references. Final status is `COMPLETE_NO_DEFECTS`, `COMPLETE_WITH_FINDINGS`,
`COMPLETE_WITH_REGRESSIONS`, or `FAILED`.

The orchestration record is created with the exploration run directory before Chromium starts.
When browser startup fails, schema 1.1 `pipeline.json` and a failure `report.html` still record the
error and mark later stages `NOT_RUN`. If that directory itself cannot be created, the CLI reports
`ARTIFACT_WRITE_FAILED`; there is deliberately no pretend artifact location.

Pipeline never exports into another repository. Generation remains the terminal automatic stage;
export is always a separate human decision.

## Human-approved regression export

Preview an export plan without changing the target:

```sh
agentic-qa export artifacts/<run-id>/regressions/<generation-id>/manifest.json \
  --target ../my-playwright-app
```

Apply only the new, non-conflicting files after review:

```sh
agentic-qa export <manifest-json> --target ../my-playwright-app --apply
```

An existing different file is never replaced unless both approval flags are present:

```sh
agentic-qa export <manifest-json> --target ../my-playwright-app --apply --overwrite
```

Target inspection is static and bounded. It reads `package.json`, lockfiles, `tsconfig.json`, the
supported `playwright.config.{ts,js,mts,mjs}` filename/content, common test directories, and
read-only Git metadata. It never imports or evaluates the Playwright config during preview. The
destination priority is `--tests-dir`, a statically readable config `testDir`, an existing common
directory, then `tests`; specs always go into a dedicated `agentic-qa/` child directory.

TypeScript Playwright projects are fully supported. A missing `@playwright/test` declaration is
`REVIEW_REQUIRED`; JavaScript-only targets are `UNSUPPORTED` for automatic apply because generated
specs are TypeScript. Package manager detection is informational—no dependency is installed and
`package.json` is never modified.

Each destination is classified as `NEW`, `IDENTICAL`, `MODIFIED_GENERATED`, or `CONFLICT` with a
bounded unified diff. Absolute/traversal/tilde/backslash/NUL paths and any symlink in the export
ancestry are rejected. Writes use exclusive creation or explicit atomic replacement, followed by
SHA-256 verification. Export never runs Git mutation, package scripts, hooks, installs, commits,
pushes, remote calls, or pull-request creation.

`--validate` is allowed only with `--apply`. It invokes the target's already installed local
Playwright CLI with a fixed executable/argument array, `shell: false`, a bounded timeout, and
`test <exported-files> --list`. This lists/loads specs and target config but does not launch a
browser or run the regressions. Because loading a Playwright config is target code execution,
validation is an explicit opt-in and should be used only with a trusted target repository.

Export planning and receipts remain beside the generation:

```text
regressions/<generation-id>/
├── manifest.json
├── tests/
└── exports/
    └── <export-id>/
        ├── export-plan.json
        └── export-receipt.json  # only after --apply
```

Receipts contain sanitized target identity/profile, previous/new hashes, written/skipped files,
validation output, and read-only Git review output. They do not store an absolute home path.

## Static HTML report

Every unified pipeline writes `pipeline.json` and `report.html` at the source-run root. The report
contains overview/timings, exploration, plan coverage/priorities, execution statuses, verification
verdicts, findings and associated evidence, relative screenshot links, and generated spec digests.
JSON artifacts remain the source of truth.

The renderer is deterministic, framework-free, has no JavaScript/CDN/network dependency, emits a
strict CSP, escapes `<`, `>`, `&`, quotes and apostrophes from all captured application/provider
text, and accepts only safe relative local links. Copying the whole source-run directory preserves
report links. Rerender without a browser or provider:

```sh
agentic-qa report artifacts/<run-id>
# or: agentic-qa report artifacts/<run-id>/pipeline.json
```

## CLI output and exit codes

`pipeline --json` and `export --json` emit one JSON document to stdout; failures go to stderr.
`--no-color` and `NO_COLOR` make terminal output stable for CI.

| Commands                     | `0`                                 | `1`                                                | `2`                                  |
| ---------------------------- | ----------------------------------- | -------------------------------------------------- | ------------------------------------ |
| `inspect`, `explore`, `plan` | completed                           | CLI/input/runtime failure for legacy commands      | —                                    |
| `report`                     | rendered                            | —                                                  | report source/infrastructure failure |
| `run`                        | no mismatch/block/error             | application mismatch or safety block               | executor/config/infrastructure error |
| `verify`                     | no confirmed/probable/flaky finding | defect finding exists                              | verification/infrastructure error    |
| `generate`                   | generation complete                 | review/unsupported eligible item                   | source/generation error              |
| `export`                     | clean preview/apply                 | conflicts, warnings, review, or validation failure | source/target/config failure         |
| `pipeline`                   | complete with no defect signal      | complete with findings/regressions                 | failed infrastructure stage          |

Commander usage errors return non-zero and print help. Existing commands retain their historical
exit behavior for compatibility.

## Architecture

- `domain` — dependency-free page/state graphs, planning/execution/verification models, typed
  regression/export/pipeline models, fingerprints, signatures, action classification, URL scope,
  and safety rules.
- `application` — inspect, page/state BFS, planning, integrity and grounding validation,
  deterministic execution compilation, constrained reproduction orchestration, signature/verdict
  policy, evidence matching, regression eligibility/compilation, target inspection, export
  planning, pipeline orchestration, report rerendering, and external ports.
- `browser` — Playwright adapters, semantic candidate capture, constrained graph action execution,
  runtime drift checks, evidence, isolation, popup/dialog/download handling, and trace cleanup.
- `infrastructure` — centralized configuration, filesystem artifacts, run IDs, secret redaction,
  generated TypeScript validation, static target probing/safe writes, pipeline artifact loading,
  and the OpenAI-compatible HTTP adapter.
- `reporting` — concise terminal output plus deterministic Markdown, TypeScript, and escaped static
  HTML rendering, separate from plan generation.
- `cli` — command parsing and composition root.

The domain and application layers import neither Playwright nor an LLM SDK. Additional model
providers can be introduced behind the reasoning port without coupling core planning to a vendor
or HTTP-client-specific types.

## Development

```sh
npm run build
npm run typecheck
npm run lint
npm run format:check
npm test
```

Integration tests host controlled local applications and a fake OpenAI-compatible provider. They
exercise all CLI modes, including a real Chromium
exploration-to-planning-to-execution-to-verification-to-generation pipeline and human-approved
target export. Generated UI, navigation, and HTTP specs are compiled and run against controlled
bug/healthy modes with real Chromium, without public internet or API credentials.

## Release-candidate documentation

- [v1 public contract and exit codes](docs/V1_CONTRACT.md)
- [artifact schema compatibility](docs/SCHEMA_COMPATIBILITY.md)
- [security policy](SECURITY.md) and [threat model](docs/THREAT_MODEL.md)
- [performance baseline](docs/PERFORMANCE.md)
- [v1 release checklist](docs/V1_RELEASE_CHECKLIST.md)
- [historical changelog](CHANGELOG.md)

The next step after this audit is an explicit human-authorized v1 release operation. It must not
publish npm, create a tag, or create a GitHub Release without that separate approval.

## License

MIT
