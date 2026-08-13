# adk-python conformance suite

109 fixtures recorded from adk-python's own test suite at the `Runner`
boundary, with no changes to those tests. 71 are replayed against adk-js; 38
are held, each with a stated reason.

    npx vitest run --config conformance/vitest.conformance.ts

## What this checks

Each replayable fixture builds an `LlmAgent` whose model is scripted with the
responses Python's runtime reacted to and whose tools replay the results
Python's tools returned, runs it through `Runner`, and compares the event
stream. So what is under test is not the model. It is what the runtime _does
with_ a model response: which events it emits, their authors and order, and the
tools it dispatches. That is the behaviour two SDKs must agree on to be at
parity.

The comparison is on the turn envelope -- author, role, kinds of part -- and on
tool dispatch order, not deep equality. Deep equality would flag every fixture
over optional metadata the two SDKs disagree about harmlessly, and a suite that
red on day one is a suite switched off by day two.

## Evidence it can fail

A suite that only ever passes proves nothing. Three deliberate mutations of
adk-js were run against it:

| Mutation                                    | Fixtures failed |
| ------------------------------------------- | --------------- |
| Tool-response event role `user` -> `model`  | 11              |
| Tool-response event author suffixed         | 11              |
| `role` on the auth branch of `functions.ts` | 0               |

The third is the honest one: that path is never reached by these fixtures, so
the suite is blind to it. Coverage is 71 invocations of one agent shape, not
adk-js as a whole.

## Known divergence, deliberately not asserted

adk-python closes an invocation with a contentless bookkeeping event carrying
`end_of_agent`; adk-js emits no equivalent. Contentless events are therefore
dropped before comparison. It is a real difference, recorded here rather than
asserted 71 times, because left in it fails every multi-turn fixture for one
reason and buries everything worth reading.

## Why held fixtures are listed, not dropped

A suite that quietly keeps only the traces that replay easily reports a parity
number that means nothing. Held fixtures appear as skipped tests naming the
reason, and that list is the roadmap for widening coverage. The largest group
-- invocations whose stimulus is a tool result -- is blocked by the capture
recording what an invocation emitted but not the session it started from.
Closing that means capturing session state at entry, not changing adk-js.

## Why not port the 10k Python tests

52% of adk-python's test files are mock-based and assert on its internal call
graph. Porting them would force adk-js to adopt Python's internals, which is
the opposite of parity. This is the Bun approach instead: Bun rewrote Zig to
Rust without porting a single test, because their suite drove the runtime
through its public API and did not depend on the implementation language.
Capture creates that property rather than assuming it, so adk-go, adk-java and
adk-kotlin get the same suite for free.

## Regenerating

    pytest tests/... -p foundry.conformance.capture_plugin   # in adk-python
    foundry conformance                                      # in Foundry
