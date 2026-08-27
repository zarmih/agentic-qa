# Agentic QA

Agentic QA is an open-source project for autonomous, evidence-based quality assurance of web
applications. The long-term goal is an agent that can explore an application, plan and execute
tests, identify likely defects, and produce reproducible reports and regression tests.

## Current status

Stage 3 provides single-page inspection, deterministic multi-page exploration, and an explicitly
enabled conservative UI-state explorer:

```sh
agentic-qa inspect https://example.com
agentic-qa explore https://example.com --max-pages 20 --max-depth 3
agentic-qa explore https://example.com --interactive
```

`inspect` captures metadata and a screenshot for one page. Plain `explore` preserves the Stage 2
behavior: deterministic BFS over safe same-origin links, a serializable application graph, and
bounded browser evidence, with no button clicks. `--interactive` additionally explores meaningful
same-page UI states through controls that a conservative classifier can prove safe.

HTTP 4xx/5xx responses are saved as valid inspection results with a warning. Invalid input,
network failures, timeouts, browser startup failures, and artifact write failures return a
human-readable CLI error and a non-zero exit code.

Agentic QA does **not** yet provide LLM reasoning, form filling, arbitrary button exploration,
authentication workflows, autonomous test generation, defect reasoning, regression generation,
or an HTML dashboard.

## Requirements and installation

- Node.js 24 LTS or newer
- npm

```sh
git clone https://github.com/zarmih/agentic-qa.git
cd agentic-qa
npm install
npx playwright install chromium
npm run build
npm link                 # optional: exposes the agentic-qa command locally
```

During development, run the command without linking:

```sh
npm run inspect -- https://example.com
npm run explore -- https://example.com --max-pages 20 --max-depth 3
npm run explore -- https://example.com --interactive --max-states 12
```

Artifacts are stored in `artifacts/<run-id>/` by default and are intentionally ignored by Git.

## Configuration

| Environment variable                     |     Default | Purpose                                          |
| ---------------------------------------- | ----------: | ------------------------------------------------ |
| `AGENTIC_QA_NAVIGATION_TIMEOUT_MS`       |     `30000` | Per-page navigation timeout                      |
| `AGENTIC_QA_HEADLESS`                    |      `true` | Run Chromium without a visible window            |
| `AGENTIC_QA_VIEWPORT_WIDTH`              |      `1440` | Browser viewport width                           |
| `AGENTIC_QA_VIEWPORT_HEIGHT`             |       `900` | Browser viewport height                          |
| `AGENTIC_QA_ARTIFACTS_DIR`               | `artifacts` | Artifact root, relative to the working directory |
| `AGENTIC_QA_MAX_PAGES`                   |        `25` | Maximum exploration navigation attempts          |
| `AGENTIC_QA_MAX_DEPTH`                   |         `3` | Maximum BFS depth; start page is depth 0         |
| `AGENTIC_QA_MAX_QUERY_VARIANTS_PER_PATH` |         `5` | Query variants allowed per origin and path       |
| `AGENTIC_QA_MAX_STATES`                  |        `12` | Unique UI states across an interactive run       |
| `AGENTIC_QA_MAX_ACTIONS_PER_STATE`       |         `4` | Safe actions attempted from one state            |
| `AGENTIC_QA_MAX_STATE_DEPTH`             |         `2` | Maximum replay action-path depth                 |
| `AGENTIC_QA_DEBUG`                       |     `false` | Print diagnostic stack traces for CLI failures   |

Both commands accept `--headed`, `--timeout <milliseconds>`, and `--artifacts-dir <path>`.
`explore` additionally accepts `--max-pages`, `--max-depth`, `--max-query-variants`,
`--max-states`, `--max-actions-per-state`, and `--max-state-depth`. Interactive exploration is
enabled only by `--interactive`; limit options override their corresponding environment values.

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

## Architecture

- `domain` — dependency-free page/state graphs, fingerprints, action classification, URL scope, and
  safety rules.
- `application` — inspect, page BFS, state BFS, replay orchestration, and browser/artifact ports.
- `browser` — Playwright adapters, semantic candidate capture, action execution, evidence, popup,
  dialog, download, lifecycle, and trace cleanup.
- `infrastructure` — centralized configuration, filesystem artifacts, and run IDs.
- `reporting` — concise terminal rendering that is separate from JSON persistence.
- `cli` — command parsing and composition root.

The domain and application layers do not import Playwright or an LLM SDK. Future model providers
can be introduced behind application ports without coupling the core to OpenAI, Anthropic, xAI,
OpenAI-compatible APIs, or local runtimes.

## Development

```sh
npm run build
npm run typecheck
npm run lint
npm run format:check
npm test
```

Integration tests host controlled local applications and exercise both real CLI commands with real
Chromium. They do not depend on the public internet.

## Roadmap

1. Provider-neutral observation and planning contracts for a later LLM reasoning stage.
2. Test plan and test case generation with reproducible execution.
3. Defect triage, Playwright regression generation, reruns, and HTML reporting.

## License

MIT
