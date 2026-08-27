# Agentic QA

Agentic QA is an open-source project for autonomous, evidence-based quality assurance of web
applications. The long-term goal is an agent that can explore an application, plan and execute
tests, identify likely defects, and produce reproducible reports and regression tests.

## Current status

Stage 1 provides a working foundation and one real vertical slice:

```sh
agentic-qa inspect https://example.com
```

The command validates the URL, opens it in Chromium, records basic page metadata and element
counts, and writes `result.json` plus a full-page `page.png` under a unique run directory. It
inspects a single page only; autonomous exploration and LLM reasoning are not implemented yet.

HTTP 4xx/5xx responses are saved as valid inspection results with a warning. Invalid input,
network failures, timeouts, browser startup failures, and artifact write failures return a
human-readable CLI error and a non-zero exit code.

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
```

Artifacts are stored in `artifacts/<run-id>/` by default and are intentionally ignored by Git.

## Configuration

| Environment variable               |     Default | Purpose                                          |
| ---------------------------------- | ----------: | ------------------------------------------------ |
| `AGENTIC_QA_NAVIGATION_TIMEOUT_MS` |     `30000` | Main navigation timeout                          |
| `AGENTIC_QA_HEADLESS`              |      `true` | Run Chromium without a visible window            |
| `AGENTIC_QA_VIEWPORT_WIDTH`        |      `1440` | Browser viewport width                           |
| `AGENTIC_QA_VIEWPORT_HEIGHT`       |       `900` | Browser viewport height                          |
| `AGENTIC_QA_ARTIFACTS_DIR`         | `artifacts` | Artifact root, relative to the working directory |
| `AGENTIC_QA_DEBUG`                 |     `false` | Print diagnostic stack traces for CLI failures   |

`inspect` also accepts `--headed`, `--timeout <milliseconds>`, and
`--artifacts-dir <path>`. Command options override environment values.

## Architecture

- `domain` — dependency-free inspection result and URL rules.
- `application` — the inspect use case and ports for browser capture, artifacts, time, and IDs.
- `browser` — the Playwright adapter; browser and context cleanup is owned here.
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

The integration smoke test hosts a controlled local page and exercises the real CLI with real
Chromium; it does not depend on an external website.

## Roadmap

1. Multi-page exploration with explicit scope and safety policies.
2. Page/state graph and durable browser evidence (traces, console, and network logs).
3. Provider-neutral LLM planning ports and adapters.
4. Test plan and test case generation with reproducible execution.
5. Defect triage, Playwright regression generation, reruns, and HTML reporting.

## License

MIT
