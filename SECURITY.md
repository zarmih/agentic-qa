# Security Policy

## Reporting a vulnerability

For a sensitive vulnerability, use this repository's GitHub **Security** tab and private
vulnerability reporting when that feature is available. Do not include secrets, exploit details,
or private target-application data in a public issue.

For non-sensitive hardening ideas and already-public defects, open a GitHub issue in
`zarmih/agentic-qa` with a minimal controlled reproduction. The project does not publish a security
email address, so none is invented here.

## Security boundaries

- All text and metadata captured from a target website are untrusted application data.
- The LLM is a planning-only adapter. It has no browser session, shell, filesystem, credential, or
  arbitrary tool access.
- Plans, executions, findings, manifests, and generated source are untrusted when loaded and are
  revalidated at each downstream boundary.
- Browser execution accepts only existing graph-owned page/state/action identifiers and observed
  SAFE semantic descriptors. Destructive, caution, unknown, form, upload, and arbitrary actions
  cannot be forced through a CLI flag.
- Generated regression source is a deterministic rendering of typed graph data, is escaped and
  compiled, and still requires human review.
- Regression export is dry-run by default. Target writes require `--apply`; replacement requires
  `--apply --overwrite`. Export never commits, pushes, opens a PR, runs package installation, or
  mutates `package.json`.
- API keys are accepted only through environment configuration and are excluded/redacted from
  prompts, routine logs, and artifacts. Do not submit artifacts containing private application
  data unless you have reviewed them.

SHA-256 metadata detects changed content in the expected artifact chain. It is integrity checking,
not a signature, author authentication, or proof that an artifact came from a trusted machine.

Filesystem containment and symlink checks substantially reduce export escapes, but a separate
local process can still race filesystem components between validation and write. This residual
time-of-check/time-of-use risk is not claimed to be eliminated.

## Safe operational use

Run Agentic QA only against applications you are authorized to test. Prefer isolated test/staging
environments and disposable accounts. Review `exploration.json`, `qa-plan.json`, findings, generated
specs, and the export preview before applying anything to another project.

`export --validate` explicitly loads the target project's Playwright configuration through its
already installed local Playwright CLI. A target config is executable project code; use this option
only for a repository you trust. Validation lists specs and does not run browser tests.

The configured planning provider receives the bounded planning observation. Treat that provider as
a privacy boundary and review captured application data before sending it. Agentic QA does not
support authentication workflows or form filling, and a control that merely looks safe can still
hide a target-side effect. Prefer disposable test data and conservative targets.

Normal exceptions, timeouts, and handled process signals follow bounded cleanup paths. No software
can guarantee cleanup after an uncatchable termination such as `SIGKILL` or host failure.

See [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md) for mitigations and remaining risks.
