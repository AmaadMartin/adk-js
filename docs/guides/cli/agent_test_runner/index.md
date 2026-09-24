# Agent test runner

The agent test runner replays a recorded conversation against an agent and
compares the event stream it produces with the one that was recorded. Reach for
it when you want a sample or an agent pinned by a whole conversation, rather
than by hand-written assertions about single calls.

## Introduction

A recorded conversation is a **fixture**: a JSON file in a `tests/` directory
beside the agent, holding the events of one session. Replaying it drives the
agent with the recorded user turns, while the recorded model turns answer every
model call. No API key is spent and no request leaves the machine, so the same
fixture runs on every developer machine and in CI.

Two runs of one conversation are never byte-identical. Event ids, timestamps,
invocation ids and function call ids are generated fresh each time, and token
counts differ. The runner therefore compares **normalized** events: it drops the
volatile fields, renumbers the generated ids to `e-1`, `e-2`, `fc-1`, and sorts
both sides, so a fixture only breaks when the agent's behaviour changes.

Three other harnesses in this repository record or mock a model, and this one
does not replace them:

- `tests/integration/test_case_utils.ts` drives one hand-written case with
  inline expected events.
- `tests/integration/workflows/_harness/` matches a recorded response to a
  request by fingerprinting the request.
- `dev/src/integration/test_runner.ts` runs the YAML conformance suite.

This module is the only one that discovers fixtures on disk, canonicalizes the
generated ids, and can rewrite a fixture from a live run.

## Get started

Put an agent and a fixture side by side:

```
my_agent/
  agent.ts
  tests/
    basic.json
```

`tests/basic.json` records the conversation. `events[0]` is the user turn that
starts it; everything after it is what the agent is expected to produce:

```json
{
  "events": [
    {
      "author": "user",
      "content": {"role": "user", "parts": [{"text": "Roll a six sided die."}]}
    },
    {
      "author": "dice_agent",
      "content": {
        "role": "model",
        "parts": [
          {
            "functionCall": {
              "id": "fc-1",
              "name": "roll_dice",
              "args": {"sides": 6}
            }
          }
        ]
      }
    },
    {
      "author": "dice_agent",
      "content": {
        "role": "user",
        "parts": [
          {
            "functionResponse": {
              "id": "fc-1",
              "name": "roll_dice",
              "response": {"rolled": 6}
            }
          }
        ]
      }
    },
    {
      "author": "dice_agent",
      "content": {"role": "model", "parts": [{"text": "You rolled a 6."}]}
    }
  ]
}
```

Drive it from a test:

```ts
import {getTestFiles, runAgentReplay} from '@google/adk-devtools';
import {expect, it} from 'vitest';

for (const testCase of getTestFiles('./samples')) {
  const run = testCase.xfail ? it.fails : it;
  run(`replays ${testCase.id}`, async (ctx) => {
    const result = await runAgentReplay(testCase.agentDir, testCase.testFile);
    if (result.status === 'skipped') {
      ctx.skip();
      return;
    }
    expect(result.actual).toEqual(result.expected);
  });
}
```

`tests/integration/agent_test_runner/` holds a complete working example.

## Discovery

`getTestFiles(folder)` returns one `AgentTestCase` per `tests/*.json` file below
`folder` whose parent directory holds an agent — `agent.*`, `app.*` or
`root_agent.yaml`. With no argument it reads the folder from the
`ADK_TEST_FOLDER` environment variable, and it returns an empty list when
neither is set or the folder does not exist. It is synchronous, so a test runner
can build its case list while collecting.

Each case carries a reportable `id`: the agent directory's path below the
nearest `samples` directory, plus the file name. A fixture whose file stem ends
in `_xfail` is marked `xfail`, for a conversation that is known to be broken.

## What the comparison ignores

`EXCLUDED_EVENT_FIELDS` lists the volatile fields that are dropped from both
sides: `id`, `timestamp`, `invocationId`, `modelVersion`, `finishReason`,
`usageMetadata`, `avgLogprobs`, `cacheMetadata`, `logprobsResult`,
`citationMetadata`, `interactionId` and `turnComplete`.

Normalization also strips thought signatures, drops the role of a
human-in-the-loop request, sorts the long-running tool ids, prunes empty action
groups, and drops the `*_join_state` keys that parallel execution writes into
the state delta.

Everything else is compared, including every function call id. Those are
renumbered first: events become `e-1`, `e-2`, function calls become `fc-1`,
`fc-2`, and the new id follows into the branch, the node path, the isolation
scope, the function responses, the nested confirmation arguments and the
`requestedToolConfirmations` keys.

## Rebuilding a fixture

After an intentional behaviour change, rerun the conversation against the real
model instead of hand-editing the JSON:

```ts
import {rebuildTests} from '@google/adk-devtools';

for (const result of await rebuildTests('./samples/my_agent')) {
  if (result.status === 'error') {
    // One fixture failing does not stop the others.
  }
}
```

A directory rebuilds every fixture below it; a file path rebuilds only that
fixture. Each file is rewritten with sorted keys, two-space indentation and a
trailing newline, non-ASCII text is preserved verbatim, and `lastUpdateTime` is
dropped. Every other key of the recorded session survives.

A rebuild calls the model, so it needs credentials. A replay does not.

## Limits

- **A workflow that fans out is not replayable.** The recorded responses are
  served positionally, in recording order. adk-python pins `max_concurrency` to
  1 before a replay so that its workers ask one at a time; adk-js declares
  `Workflow.maxConcurrency` and `ParallelWorker.maxParallelWorkers` `readonly`,
  and the port does not cast them away, so several children can ask at once and
  a response can reach the wrong worker. The difference that reports is not
  reproducible. Record a conversation whose model calls happen one at a time.
- **A replay needs the agent's model to be constructible.** An agent that names
  a Gemini model resolves that name through `LLMRegistry` before any callback
  runs, and the Gemini constructor rejects a missing API key. Set any
  placeholder value in `GEMINI_API_KEY` for such an agent; the recording answers
  every model call, so nothing is sent.
- **One replay at a time per process.** `runAgentReplay` loads the agent from
  disk and drives one session; run the cases sequentially.
- **A fixture that pins a random number generator is skipped.** adk-python
  fixtures may carry a `mocks` block that seeds `random`; Node has no seedable
  global generator, so the replay reports the fixture as skipped instead of
  comparing against a run it cannot reproduce.
- **A `root_agent.yaml`-only directory is discovered but not replayed.** The
  loader behind the replay reads JavaScript and TypeScript entry files, so such
  a fixture is reported as skipped.
