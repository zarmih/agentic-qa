# Artifact schema compatibility

This document is the v1 compatibility policy. JSON schemas are versioned
independently from the npm package. A schema version is accepted only by the consumers listed
below; a matching-looking object with a missing, unknown, or future version is not treated as the
current schema.

| Artifact                                               | Current           | Accepted legacy                                                                  | Rejected                                                                   | Regeneration or migration                            | Downstream consumers                                                      |
| ------------------------------------------------------ | ----------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------- |
| Inspection result (`result.json`)                      | `1.0`             | None                                                                             | All other versions                                                         | Run `inspect` again                                  | Human/tooling output only in 0.9; no command consumes it as trusted input |
| Exploration result (`exploration.json`)                | `3.0`             | None                                                                             | `1.x`, `2.x`, unknown, future                                              | Run `explore` again                                  | `plan`, `run`, `report`                                                   |
| Page graph (`graph.json` and embedded graph)           | `1.0`             | None                                                                             | Unknown/future or any standalone/embedded mismatch                         | Run `explore` again                                  | `run`, `verify`, `generate`, `report` through the source chain            |
| UI state graph (`state-graph.json` and embedded graph) | `1.0`             | None                                                                             | Unknown/future, missing interactive graph, or standalone/embedded mismatch | Run `explore --interactive` again                    | `run`, `verify`, `generate`, `report` through the source chain            |
| Planning observation (`observation.json`)              | `1.0`             | None                                                                             | Any value not byte-semantically equal to deterministic recompilation       | Run `plan` again                                     | `run`, then every later source-chain validator                            |
| Provider plan proposal                                 | `1.0`             | None                                                                             | Missing/unknown/future or invalid structured response                      | Provider receives at most one bounded repair request | Planning only; never persisted as the trusted QA plan                     |
| QA plan (`qa-plan.json`)                               | `1.1`             | None                                                                             | `1.0`, unknown, future                                                     | Run `plan` again                                     | `run`, `verify`, `generate`, `report`                                     |
| Execution (`execution.json`)                           | `1.1`             | None                                                                             | `1.0`, unknown, future                                                     | Run the QA plan again                                | `verify`, `generate`, `report`                                            |
| Verification (`verification.json`)                     | `1.1`             | None                                                                             | `1.0`, unknown, future                                                     | Run `verify` again                                   | `generate`, `report`                                                      |
| Findings (`findings.json`)                             | `1.1`             | None                                                                             | `1.0`, unknown, future                                                     | Run `verify` again                                   | `generate`, `export`, `report` through linkage                            |
| Regression manifest (`manifest.json`)                  | `1.1`             | `1.0` for `export` only, after full source-chain and generated-byte revalidation | Unknown/future; `1.0` for report rendering                                 | Prefer running `generate` again                      | `export`, `report` (`report` requires `1.1`)                              |
| Regression IR                                          | `1.0`             | None                                                                             | Not a public input format                                                  | Run `generate` again                                 | Internal deterministic renderer only                                      |
| Export plan (`export-plan.json`)                       | `1.0`             | None                                                                             | Not accepted as authority for a later write                                | Re-run `export` from the manifest                    | Human/machine preview output only                                         |
| Export receipt (`export-receipt.json`)                 | `1.0`             | None                                                                             | Not accepted as authority for a later write                                | Re-run an explicitly approved export                 | Audit output only                                                         |
| Pipeline (`pipeline.json`)                             | `1.1`             | `1.0` from Agentic QA 0.8                                                        | Unknown/future; invalid stage/artifact combinations                        | Re-run `pipeline`                                    | `report`                                                                  |
| HTML report                                            | Not a JSON schema | Not applicable                                                                   | Never a source of truth                                                    | Run `report` from a valid pipeline artifact          | Human viewing only                                                        |

## Validation and linkage rules

- `exploration.json` is parsed by a complete strict schema. Nested page, evidence, candidate,
  locator, action, graph, summary, limit, and artifact objects reject unknown fields. Cross-field
  checks verify identifiers, references, counters, graph availability, and embedded summaries.
- Saved plan, execution, verification, findings, regression manifest, and pipeline inputs use
  strict Zod schemas with bounded collections and strings. Future schema `999.0` rejection is a
  regression-tested invariant.
- The standalone page/state graphs must equal their embedded forms under canonical JSON. Planning
  observations must equal a fresh deterministic compilation from the exploration artifact.
- Canonical JSON recursively sorts object keys using locale-independent Unicode code-unit order,
  preserves array order, omits `undefined`, and then hashes UTF-8 JSON with SHA-256.
- Execution, verification, findings, and manifest payload digests are recomputed at every
  downstream boundary. Changing a status, reference, selector-like field, URL, verdict, filename,
  source byte, or digest causes rejection.
- SHA-256 provides content integrity within this artifact chain. It is not a signature,
  provenance proof, author identity, or protection against an attacker who can replace the whole
  trusted installation and rebuild a self-consistent chain.

## Compatibility promise

For the v1 contract, a consumer will either accept a documented schema exactly under the rules
above or fail with a bounded source/integrity error. It will not silently coerce a future artifact
into a current model. New schema versions require an explicit parser branch and a compatibility
entry in this document.
