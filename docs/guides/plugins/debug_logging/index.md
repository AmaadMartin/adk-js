# DebugLoggingPlugin

`DebugLoggingPlugin` records a complete account of every invocation to a file: the requests each model call received, the responses it returned, the tool calls and their results, the events the runner yielded, and the session state at the end. Reach for it when the console log is too lossy to explain what an agent did, or when you need a trace to attach to a bug report.

## Introduction

A multi-agent run produces far more than a console can usefully show. By the time a wrong answer appears, the prompt that caused it has scrolled away, and the tool result that fed it is gone. This plugin keeps the whole record instead, on disk, in a form a person can read.

Each invocation becomes one YAML document, appended to the output file and separated by `---`, so the file loads with a multi-document YAML loader. Entries appear in the order the callbacks fired, so the document reads as a timeline.

The plugin only observes. Every callback returns nothing, so registering it cannot change what an agent does. A write that fails is logged at error level and swallowed; the invocation continues.

Two neighbouring pieces are worth knowing about:

- **`LoggingPlugin`** logs the same callback points to the console. It writes no file and does no redaction. Use it to watch a run live; use this plugin to keep the run.
- **`BaseTool` and agent callbacks** see one call each. This plugin sees the whole invocation, which is what makes the file a timeline rather than a set of fragments.

## Get started

```typescript
import {App, DebugLoggingPlugin, LlmAgent} from '@google/adk';

const agent = new LlmAgent({
  name: 'city_agent',
  model: 'gemini-2.5-flash',
  instruction: 'Answer questions about cities.',
});

export const app = new App({
  name: 'my_app',
  rootAgent: agent,
  plugins: [new DebugLoggingPlugin({outputPath: '/tmp/adk_debug.yaml'})],
});
```

Run a turn, then read `/tmp/adk_debug.yaml`:

```yaml
---
invocationId: e-4f2c1a90
sessionId: 0d5f2b31
appName: my_app
userId: user
startTime: '2026-09-04T12:34:56.789Z'
entries:
  - timestamp: '2026-09-04T12:34:56.790Z'
    entryType: user_message
    invocationId: e-4f2c1a90
    data:
      content:
        role: user
        parts:
          - text: How big is Zurich?
```

The plugin works on a `Runner` too:

```typescript
import {DebugLoggingPlugin, InMemoryRunner, LlmAgent} from '@google/adk';

const runner = new InMemoryRunner({
  agent: new LlmAgent({name: 'city_agent', model: 'gemini-2.5-flash'}),
  appName: 'my_app',
  plugins: [new DebugLoggingPlugin({outputPath: '/tmp/adk_debug.yaml'})],
});
```

## Configuration options

| Option                     | Type      | Default                  | Description                                                                         |
| :------------------------- | :-------- | :----------------------- | :---------------------------------------------------------------------------------- |
| `name`                     | `string`  | `'debug_logging_plugin'` | Plugin instance identifier.                                                         |
| `outputPath`               | `string`  | `'adk_debug.yaml'`       | Output file. A relative path resolves against the working directory of the process. |
| `includeSessionState`      | `boolean` | `true`                   | Whether to record a session state snapshot at the end of each invocation.           |
| `includeSystemInstruction` | `boolean` | `true`                   | Whether to record the full system instruction rather than only its length.          |
| `maxBufferedInvocations`   | `number`  | `64`                     | How many in-flight invocations to hold in memory. See "Memory" below.               |

`DEFAULT_DEBUG_OUTPUT_PATH` is exported, so a test can assert the default without reaching into an instance.

## Entry kinds

Every entry carries a `timestamp`, an `entryType`, the `invocationId`, an `agentName` where one applies, and a `data` payload. The `DebugEntryType` enum names each kind, and its values match adk-python's, so you can filter a trace the same way in either SDK.

| `entryType`              | Recorded when                                           |
| :----------------------- | :------------------------------------------------------ |
| `invocation_start`       | The runner starts an invocation.                        |
| `user_message`           | A user message arrives.                                 |
| `agent_start`            | An agent begins.                                        |
| `agent_end`              | An agent finishes.                                      |
| `llm_request`            | A request is about to reach the model.                  |
| `llm_response`           | A response arrives from the model.                      |
| `llm_error`              | A model call throws.                                    |
| `tool_call`              | A tool is about to run.                                 |
| `tool_response`          | A tool returns.                                         |
| `tool_error`             | A tool throws.                                          |
| `event`                  | The runner yields an event.                             |
| `session_state_snapshot` | The invocation ends, and `includeSessionState` is true. |
| `invocation_end`         | The invocation ends.                                    |

An `llm_request` entry records the model name, the number of contents, the contents themselves, the tool names available, and the generation config. Inline blob bytes are never written; a part carrying one records its mime type, its display name and `dataOmitted: true`.

## Redaction

The file holds whole prompts and responses, so credentials are cut out of it before it is written. Four rules apply, and they are unconditional — there is no opt-out and no hook to supply your own.

1. **By shape.** A value whose fields identify it as an ADK credential is replaced with `[REDACTED]` wholesale, wherever it sits and under whatever key. This covers `AuthCredential`, `HttpAuth`, `HttpCredentials`, `OAuth2Auth`, `ServiceAccount` and `ServiceAccountCredential`.
2. **By key name.** A mapping key that names a secret is redacted. The `app:` and `user:` state scopes are stripped first, and hyphens and camel case are folded, so `apiKey`, `X-Api-Key`, `api_key` and `user:api_key` all match the same rule. Matching is by exact name, by substring (`openai_api_key`) and by the `_token` suffix (`bearer_token`).
3. **Temporary state.** Every `temp:`-prefixed state key is redacted, credential or not, because ADK stores exchanged credentials there. An intermediate value passed between agents under a `temp:` key therefore reads as `[REDACTED]`.
4. **Armored private keys.** A `-----BEGIN … PRIVATE KEY-----` block is cut out of any string, leaving the rest of the string readable. This catches a service account file pasted into state, which no key name identifies.

The `_token` rule is a suffix and not a substring on purpose: `promptTokenCount`, `totalTokenCount` and `maxOutputTokens` keep their values, because usage counters are part of what the trace exists to show.

An event's `requestedAuthConfigs` is recorded as a count rather than as the configs, since a config holds a credential.

Redaction is not a guarantee that the file is safe to share. It removes credentials; it does not remove the conversation. Read the file before you attach it to anything.

## File permissions

A file this plugin creates is created mode `0600`, readable and writable by its owner only.

The mode applies only to a file the plugin creates. A file left behind by an earlier run keeps whatever mode it had, so the plugin checks the mode it actually got and warns once per instance when the file is readable beyond its owner. It does not change the mode: silently overriding a permission you chose would be worse than telling you about it.

## Memory and file growth

The plugin holds one record per in-flight invocation. `afterRunCallback` writes that record and drops it, but an invocation that is abandoned or that crashes never reaches that callback, so in a long-running server the records would accumulate.

`maxBufferedInvocations` bounds them. Once that many are held, opening a new record first flushes the oldest one to the file and drops it. A record flushed this way is marked `incomplete: true`, so you can tell a truncated trace from a finished one. Pass a non-positive number to hold every invocation instead.

The file itself grows for the life of the process. The plugin does not rotate it and does not cap its size — the whole point is to keep entire prompts and responses. Delete or rotate it yourself between debugging sessions.

## Differences from adk-python

The port follows `google/adk-python`'s `debug_logging_plugin` closely. Four differences are worth knowing:

- **Keys in the file are camelCase** (`entryType`, `functionCall`, `mimeType`) rather than snake_case. The `entryType` **values** are unchanged, so a filter on `llm_request` works against either SDK's file.
- **A credential is identified by its shape**, not by its class, because the credential types are erased TypeScript interfaces with no runtime representation. One consequence: an `OAuth2Auth` carrying only a `clientId` is not detected as a credential. It holds nothing to protect, and any secret-named key inside it is still redacted by name.
- **Timestamps are UTC** (`new Date().toISOString()`), where adk-python writes naive local time.
- **The user message is always recorded.** The runner calls the user-message callback before the run callback, so adk-python's plugin, which opens its record only in the run callback, drops the message at real runtime. This port opens the record from whichever callback arrives first.

`maxBufferedInvocations` has no adk-python counterpart.
