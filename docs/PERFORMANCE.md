# Performance baseline

This is a release-candidate sanity baseline, not a throughput benchmark or service-level
objective. Values are representative wall-clock measurements from controlled localhost fixtures;
network latency to a real application or planning provider can dominate them.

## Environment

- macOS 26.6.2, arm64, 10 logical CPUs, 16 GiB memory;
- Node.js 26.7.0 and Chromium 151.0.7922.34;
- headless browser, local HTTP fixtures, no public network, no paid provider;
- project minimum and release CI runtime: Node.js 24.

No username, home directory, machine name, or absolute artifact path is part of this baseline.

## Measurements

| Operation               | Controlled fixture scale                                                   | Wall time |
| ----------------------- | -------------------------------------------------------------------------- | --------: |
| `inspect`               | one document                                                               |    1.25 s |
| `explore`               | two same-origin documents, depth 1                                         |    1.58 s |
| `explore --interactive` | two documents, at most four states and two actions/state                   |    4.17 s |
| planning                | local fake OpenAI-compatible provider, two scenarios                       |   0.023 s |
| execution               | two isolated scenarios / two executed steps                                |    2.91 s |
| verification            | one candidate / three isolated attempts                                    |    4.48 s |
| generation              | one compiled 17-line Playwright spec                                       |    0.34 s |
| `report` rerender       | one complete pipeline bundle                                               |    0.36 s |
| complete quick pipeline | 1 page, 3 states, 33 candidates, 2 actions, 2 scenarios, 3 verify attempts |   10.57 s |

The complete-pipeline timing is taken from its persisted stage timestamps. The individual browser
commands were measured as CLI processes with `/usr/bin/time`; their startup cost is included.

## Pipeline stage breakdown

The measured quick pipeline produced one structural PASS, one structural FAIL, one confirmed
finding, and one regression spec:

| Stage    | Duration | Stable structural result              |
| -------- | -------: | ------------------------------------- |
| Explore  |   2.82 s | 1 page, 3 states, 2 safe / 31 blocked |
| Plan     |   0.02 s | 2 automatable scenarios               |
| Run      |   2.91 s | PASS 1, FAIL 1                        |
| Verify   |   4.48 s | 3/3 valid attempts, confirmed 1       |
| Generate |   0.34 s | 1 spec, 17 lines                      |

## Repeatability sample

The final release-candidate suite was run five consecutive times with Vitest retries disabled.
Each run completed with the same structural result: 51 test files and 290 passing tests. Wall-clock
durations were 81.38 s, 81.36 s, 81.43 s, 80.29 s, and 80.15 s (median 81.36 s). No failure or
retry was observed.

## Bounds and known bottlenecks

Page, depth, query-variant, state, action, evidence, observation, scenario, step, attempt, finding,
assertion, generated-file, and stage-time limits are enforced before or during collection. The
verification stage is the main cost in this small fixture because every attempt creates isolated
browser state and replays the grounded scenario. Interactive exploration similarly grows with the
number and depth of safe state branches. Traces and screenshots dominate artifact bytes before
bounded JSON does.

These figures should be remeasured for a release when the Chromium version, isolation model, or
default limits change materially.
