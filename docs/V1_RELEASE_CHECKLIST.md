# v1 release checklist

This checklist records the objective gates established by the Stage 9 audit and the separately
authorized v1 release step. Checked boxes require recorded evidence; external publication actions
remain separate from repository validation.

## Safety and correctness

- [x] LLM remains planning-only and has no browser/shell/filesystem tools.
- [x] Plans, executions, findings, manifests, and exploration inputs are strictly revalidated.
- [x] Destructive/caution/unknown/form/upload/arbitrary URL/selector actions remain blocked.
- [x] Canonical SHA-256 uses locale-independent serialization and is documented as integrity only.
- [x] Generated TypeScript and report HTML treat application text as untrusted data.
- [x] Export is dry-run by default; writes and overwrites require separate explicit approval.
- [x] Early Chromium startup failure retains a machine-readable pipeline failure record.

## Local quality and product proof

- [x] Clean `npm ci` final gate.
- [x] Build, typecheck, lint, and format check green from the clean install.
- [x] Full test suite green for five consecutive runs without retries.
- [x] Full controlled pipeline creates a confirmed finding, regression, and report.
- [x] Generated regression fails in bug mode and passes in healthy mode.
- [x] Destructive server counters remain zero through the complete pipeline.
- [x] Export dry-run/apply/identical/conflict/overwrite/validate boundaries pass with unchanged Git HEAD.
- [x] `npm audit` and `npm audit --omit=dev` have an acceptable result.
- [x] Tarball contents, hash, size, bin resolution, clean production install, help, version,
      inspect, explore, and interactive explore are verified.
- [x] Cleanup, determinism, resource bounds, and performance baseline are recorded.

## CI and release administration

- [x] Existing Ubuntu Node 24 / Chromium CI is green for the release-candidate SHA.
- [x] Release-validation Ubuntu job is green.
- [x] Release-validation macOS job is green.
- [x] Release-validation Windows job is green.
- [x] `main` is synchronized with `origin/main` and the working tree is clean.
- [x] No unresolved P0 or P1 finding remains.
- [x] Human explicitly authorizes the separate v1 release step.

## Explicitly outside this audit

- [x] Version changed to 1.0.0 under separate authorization.
- [ ] `v1.0.0` Git tag created — requires separate authorization.
- [ ] npm package published — requires separate authorization.
- [ ] GitHub Release created — requires separate authorization.
