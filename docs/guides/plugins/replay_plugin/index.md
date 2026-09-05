# ReplayPlugin

`ReplayPlugin` replays a recorded conformance case and verifies the run against
the recording. It substitutes each recorded tool response and fails the run when
the agent calls a different tool, calls it with different arguments, or calls
more times than the case recorded. Reach for it when you want a conformance run
to prove the agent still behaves the way it behaved when the case was recorded.

## Introduction

A conformance case is a recorded conversation: the user messages, the tool calls
the agent made, and the responses those tools returned. Replaying such a case
without checking it only proves that the agent produced _some_ run. If the agent
starts calling `flip_coin` where the recording says `roll_die`, an unverified
replay hands back the `roll_die` response anyway, and the failure surfaces much
later as a session diff that does not say what went wrong.

The plugin closes that gap. Each agent replays its own recordings for the
configured user message, in recorded order. A divergence raises
`ReplayVerificationError` naming the agent, the index, the recorded value and
the actual one. A misconfigured replay — a missing fixture file, a fixture that
violates the schema — raises `ReplayConfigError` naming the file.

The underlying tool still runs. Only its response is substituted, so replay
exercises the tool's own code path and its side effects. An `AgentTool` is the
exception: it is verified and replayed but not run, because replaying a
sub-agent's own requests and responses is unimplemented.

This mirrors `ReplayPlugin` in adk-python, which the `adk conformance` command
group there uses.

## Get started

The plugin is internal to `@google/adk-devtools` and is not exported from the
package entry point. The runnable way to use it is the conformance command,
which builds the runner and registers the plugin for you:

```bash
adk integration conformance --agents_dir ./agents --tests_dir ./tests
```

`TestRunner` drives that command through the injected mode, where the caller
hands over the recordings and the index of the user message being replayed:

```ts
import {InMemorySessionService, Runner} from '@google/adk';
import {ReplayPlugin} from './replay_plugin.js';

const context = {userMessageIndex: 0};
const runner = new Runner({
  agent,
  sessionService: new InMemorySessionService(),
  plugins: [new ReplayPlugin(recordings, context)],
  appName: 'conformance',
});
```

A host that builds its own runner can use the session-state mode instead.
Register `new ReplayPlugin()` with no arguments, then write `_adk_replay_config`
into the state delta of each request and the plugin loads the fixtures itself:

```ts
const iterator = runner.runAsync({
  userId,
  sessionId,
  newMessage: {role: 'user', parts: [{text: 'roll a die'}]},
  stateDelta: {
    _adk_replay_config: {
      dir: caseDirectory,
      user_message_index: 0,
      streaming_mode: 'none',
    },
  },
});
```

With neither the config nor injected recordings, the plugin is inert: it returns
`undefined` from `beforeToolCallback`, which tells the runtime to run the tool
itself.

## The `_adk_replay_config` keys

| Key                  | Meaning                                            |
| -------------------- | -------------------------------------------------- |
| `dir`                | The case directory holding the recordings file.    |
| `user_message_index` | Which user message of the case to replay, 0-based. |
| `streaming_mode`     | `none` or `sse`. Selects the fixture file.         |

The keys are snake_case because nothing camelCases a state delta on the way in,
and adk-python's conformance client writes them that way. A config naming no
directory or no user message index leaves the plugin inert rather than
half-enabling replay.

`streaming_mode` picks the file: `none` reads `generated-recordings.yaml` and
`sse` reads `generated-recordings-sse.yaml`. Any other value throws
`Unsupported streaming mode: <mode>`.

## Failure modes

| What happened                                                     | What you get                                                  |
| ----------------------------------------------------------------- | ------------------------------------------------------------- |
| The agent called a tool the recording does not name at this index | `ReplayVerificationError`, `Tool name mismatch`               |
| The agent called the recorded tool with other arguments           | `ReplayVerificationError`, `Tool args mismatch`               |
| The agent called more times than the case recorded                | `ReplayVerificationError`, `more tool requests than expected` |
| The fixture file is absent                                        | `ReplayConfigError`, `Recordings file not found`              |
| The fixture is unparsable or violates the schema                  | `ReplayConfigError`, `Failed to load recordings`              |
| A tool ran without `beforeRunCallback` loading the fixtures       | `ReplayConfigError`, `Replay state not initialized`           |

Use `isReplayVerificationError` and `isReplayConfigError` to tell the two apart.

The runtime turns a failing plugin callback into an error event rather than
rejecting the run, so a verification failure arrives on the event stream as an
event whose `errorMessage` carries the message above.

## Lifecycle and isolation

`beforeRunCallback` loads the fixtures once per invocation and stores a cursor
keyed by invocation id, so concurrent runs never share a replay position.
`afterRunCallback` discards that entry. A tool call arriving after the discard
raises `ReplayConfigError`.

Arguments are compared with `isDeepStrictEqual`, so key order does not matter.
The keys inside a recorded `args` or `response` payload are read verbatim: an
argument that adk-python recorded as `user_name` stays `user_name`.
