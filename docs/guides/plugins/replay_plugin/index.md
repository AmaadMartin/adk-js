# ReplayPlugin

`ReplayPlugin` answers an agent's tool calls from a recorded conformance run,
and fails the run when the agent asks for something the recording does not
contain. Reach for it when you replay a conformance fixture and need the replay
to prove the agent still behaves the way it did when the fixture was recorded.

## Introduction

The conformance harness runs an agent twice. A record pass captures every LLM
exchange and every tool call into `generated-recordings.yaml`. A replay pass
reads that file back and answers the agent from it, so the test needs no model
and no network.

A replay is only a regression test if it fails when the agent drifts. The plugin
therefore walks each agent's tool recordings in the order they were recorded. If
the agent calls a different tool, passes different arguments, or calls more
tools than were recorded, the plugin throws. It does not search the recordings
for something that matches.

The plugin also runs the real tool and throws its result away. Recorded runs
often rely on a tool's side effects — a tool that sets `transferToAgent` or
writes to state must still do so during a replay — so only the tool's response
is substituted. The one exception is an `AgentTool`: running it would re-drive a
whole sub-agent whose own requests and responses this plugin does not replay.

`ReplayPlugin` is internal to the `@google/adk-devtools` package. It is not
exported from `dev/src/index.ts`, so a caller imports the module directly, as
the sample below does from a file inside `dev/src/integration/`.

## Get started

Configure the plugin from the session, which is how adk-python's conformance
client drives it. Put a `_adk_replay_config` value in the session state and add
a plugin with no constructor arguments:

```ts
import {InMemorySessionService, LlmAgent, Runner} from '@google/adk';
import {ReplayPlugin} from './replay_plugin.js';

const sessionService = new InMemorySessionService();
const session = await sessionService.createSession({
  appName: 'conformance',
  userId: 'test-user',
  state: {
    _adk_replay_config: {
      dir: '/path/to/test-case',
      userMessageIndex: 0,
      streamingMode: 'none',
    },
  },
});

const runner = new Runner({
  appName: 'conformance',
  agent: new LlmAgent({name: 'dice_agent'}),
  sessionService,
  plugins: [new ReplayPlugin()],
});
```

`beforeRunCallback` reads that value, loads the recordings file it names, and
stores the parsed recordings under the invocation id. `afterRunCallback`
discards them again, so one plugin instance serves concurrent invocations.

The three fields:

| Field              | Meaning                                                                                |
| ------------------ | -------------------------------------------------------------------------------------- |
| `dir`              | The conformance test case directory.                                                   |
| `userMessageIndex` | Which turn's recordings this invocation replays.                                       |
| `streamingMode`    | `none` reads `generated-recordings.yaml`; `sse` reads `generated-recordings-sse.yaml`. |

Leave out `dir` or `userMessageIndex` and the plugin stays inert: it replays
nothing and lets the runtime execute every tool itself. A partial configuration
never half-enables replay.

## Injected recordings

`TestRunner` already holds the recordings in memory, so it constructs the plugin
with them instead:

```ts
const plugin = new ReplayPlugin(recordings, {userMessageIndex: 0});
```

This configuration verifies tool calls exactly as the session-state one does.
It additionally replays LLM responses from `beforeModelCallback`, which is how
adk-js avoids calling a model during a replay. The session-state configuration
leaves the model call alone, matching adk-python, which replays LLM responses
from its flow rather than from this plugin.

## Errors

| Error                                                                        | Cause                                                                                                     |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `Error: Unsupported streaming mode: <mode>`                                  | `streamingMode` is neither `none` nor `sse`.                                                              |
| `ReplayConfigError: Recordings file not found: <path>`                       | The directory holds no recordings file for that mode.                                                     |
| `ReplayConfigError: Failed to load recordings from <path>: <cause>`          | The file is not valid YAML, or breaks the recordings schema. The original failure is the error's `cause`. |
| `ReplayConfigError: Replay state not initialized.`                           | A tool call arrived before `beforeRunCallback` ran, or after `afterRunCallback` discarded the state.      |
| `ReplayVerificationError: Tool name mismatch ...`                            | The agent called a different tool than the next recording holds.                                          |
| `ReplayVerificationError: Tool args mismatch ...`                            | The tool name matched but the arguments did not.                                                          |
| `ReplayVerificationError: Runtime sent more tool requests than expected ...` | The agent made more tool calls than were recorded for it in this turn.                                    |

Each verification message names the agent and its replay index, so a failure in
a multi-agent run points at one agent's position in its own sequence:

```
Tool args mismatch for agent 'dice_agent' at index 0:
recorded: {"sides":6}
current: {"sides":20}
```

## Per-agent ordering

Each agent inside one invocation advances its own replay index. A sub-agent
calling a tool does not move the parent's position, and the two can interleave
freely. Recordings belonging to another `userMessageIndex` are invisible to the
current invocation, so replaying turn 1 cannot consume turn 0's recordings.
