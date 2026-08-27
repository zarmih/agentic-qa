# Agentic QA

Agentic QA is an open-source project for autonomous, evidence-based quality assurance of web
applications. The long-term goal is an agent that can explore an application, plan and execute
tests, identify likely defects, and produce reproducible reports and regression tests.

## Current status

Stage 2 provides two working commands:

```sh
agentic-qa inspect https://example.com
agentic-qa explore https://example.com --max-pages 20 --max-depth 3
```

`inspect` captures metadata and a screenshot for one page. `explore` performs deterministic BFS
navigation over safe same-origin links, builds a serializable application graph, and collects
bounded browser evidence. Exploration never submits forms, fills fields, or clicks buttons.

HTTP 4xx/5xx responses are saved as valid inspection results with a warning. Invalid input,
network failures, timeouts, browser startup failures, and artifact write failures return a
human-readable CLI error and a non-zero exit code.

Agentic QA does **not** yet provide LLM reasoning, interactive state exploration, autonomous test
generation, defect reasoning, regression generation, or an HTML dashboard.

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
| `AGENTIC_QA_DEBUG`                       |     `false` | Print diagnostic stack traces for CLI failures   |

Both commands accept `--headed`, `--timeout <milliseconds>`, and `--artifacts-dir <path>`.
`explore` additionally accepts `--max-pages`, `--max-depth`, and `--max-query-variants`. Command
options override environment values.

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

## Architecture

- `domain` — dependency-free inspection/exploration models, graph, URL, scope, and safety rules.
- `application` — inspect and BFS explore use cases plus browser/artifact ports.
- `browser` — Playwright adapters and shared page capture; lifecycle and trace cleanup live here.
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

1. Interactive state discovery behind explicit allowlists and action risk classification.
2. Provider-neutral LLM planning ports and adapters.
3. Test plan and test case generation with reproducible execution.
4. Defect triage, Playwright regression generation, reruns, and HTML reporting.

## License

MIT
