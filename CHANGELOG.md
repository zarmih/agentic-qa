# Changelog

Agentic QA follows semantic versioning for user-visible releases. GitHub releases and npm registry
publication are separate; version 1.0.0 is not published to npm.

## 1.0.0 — 2026-08-30

- Released deterministic web and safe interactive state exploration with bounded same-origin
  navigation.
- Released provider-neutral grounded QA planning, constrained LLM-free execution, defect
  reproduction, and deterministic verdicts.
- Released reviewable Playwright regression generation, human-approved dry-run export, the unified
  pipeline, and static local HTML reports.
- Added strict artifact validation, locale-independent SHA-256 integrity, safety boundaries, and
  release validation on Linux, macOS, and Windows.
- Documented that forms, authentication, root-cause analysis, automatic fixes, arbitrary LLM browser
  control, and automatic pull requests are outside the v1 scope.

## 0.8.0

- Productized the end-to-end pipeline, static CSP-protected HTML reporting, and consistent CLI UX.
- Added dry-run-by-default, human-approved regression export with traversal, symlink, conflict,
  overwrite, digest, validation, and Git non-mutation boundaries.
- Added production tarball and clean-install validation plus the security threat model.

## 0.7.0

- Added deterministic, LLM-free Playwright regression generation from verified findings.
- Added typed regression IR, safe graph-owned locators, discriminating assertions, hostile-string
  escaping, compilation, per-file digests, and bug/fixed-mode proof.

## 0.6.0

- Added LLM-free defect verification with isolated attempts, stable signatures, reproducibility,
  conservative verdict/severity/confidence, and deterministic findings reports.

## 0.5.0

- Added constrained execution of `AUTOMATABLE` QA scenarios through graph references only.
- Added source integrity, runtime semantic drift/safety checks, deterministic assertions, evidence,
  traces, screenshots, and PASS/FAIL/BLOCKED/ERROR/SKIPPED semantics.

## 0.4.0

- Added provider-neutral, planning-only LLM integration and an OpenAI-compatible HTTP adapter.
- Added bounded untrusted observations, structured output, repair-once, grounding, safety,
  executability, coverage, secret handling, and deterministic plan rendering.

## 0.3.0

- Added opt-in safe interactive UI-state exploration, deterministic fingerprints, replay,
  candidate audit, risk classification, state graphs, and per-interaction evidence.

## 0.2.0

- Added deterministic same-origin BFS exploration, URL/query limits, page graphs, browser evidence,
  per-page screenshots, Playwright traces, resilience, and CI.

## 0.1.0

- Established the TypeScript/Node/Playwright foundation and `inspect` CLI vertical slice with
  configuration, screenshots, JSON artifacts, tests, linting, formatting, and documentation.
