# SaveFilesAsArtifactsPlugin

`SaveFilesAsArtifactsPlugin` moves every file a user attaches to a message out of the conversation and into the artifact service. It replaces the bytes with a short text placeholder and, when the artifact has a URI the model can read, a `fileData` reference. Reach for it when your chat surface lets people upload files.

## Introduction

A user message can carry a file as an inline blob. The blob travels with the message into session history, so every later turn resends the same bytes to the model. A large upload therefore costs tokens on every turn, and the model has no name to refer to the file by.

This plugin intercepts the message before the runner appends it to the session. It saves each inline blob under the artifact service and rewrites that part as `[Uploaded Artifact: "<name>"]`. The bytes are stored once and the history stays small. The agent reads a file back with the `LOAD_ARTIFACTS` tool, or with a tool of your own that calls `context.loadArtifact(filename)`.

The plugin is a `BasePlugin`. Register it on the `Runner` or on an `App`, and it applies to every agent in that application.

Two neighbouring pieces are worth knowing about:

- **`runConfig.saveInputBlobsAsArtifacts`** does a similar rewrite inside the runner. It has no size limit and no way to suppress the file reference. Both can be enabled at once without saving twice: the plugin runs first, and the parts it returns carry no `inlineData` for the runner to act on.
- **The `LOAD_ARTIFACTS` tool** is what makes a saved file readable when no model-accessible URI exists. Add it to the agent whenever you set `attachFileReference: false`.

## Get started

```typescript
import {
  Event,
  InMemoryArtifactService,
  InMemorySessionService,
  LlmAgent,
  Runner,
  SaveFilesAsArtifactsPlugin,
} from '@google/adk';

const agent = new LlmAgent({
  name: 'file_reader',
  model: 'gemini-2.5-flash',
  instruction: 'Answer questions about the files the user uploads.',
});

const sessionService = new InMemorySessionService();
const artifactService = new InMemoryArtifactService();

const runner = new Runner({
  appName: 'file_demo',
  agent,
  sessionService,
  artifactService,
  plugins: [new SaveFilesAsArtifactsPlugin()],
});

await sessionService.createSession({
  appName: 'file_demo',
  userId: 'user_1',
  sessionId: 'session_1',
});

const events: Event[] = [];
for await (const event of runner.runAsync({
  userId: 'user_1',
  sessionId: 'session_1',
  newMessage: {
    role: 'user',
    parts: [
      {text: 'Here is the report:'},
      {
        inlineData: {
          mimeType: 'application/pdf',
          data: Buffer.from('report bytes').toString('base64'),
          displayName: 'report.pdf',
        },
      },
    ],
  },
})) {
  events.push(event);
}
```

The stored session now holds `[Uploaded Artifact: "report.pdf"]` in place of the blob, and the bytes are retrievable from the artifact service under `report.pdf`.

## Configuration options

| Option                | Type      | Default                            | Description                                                                                           |
| :-------------------- | :-------- | :--------------------------------- | :---------------------------------------------------------------------------------------------------- |
| `name`                | `string`  | `'save_files_as_artifacts_plugin'` | Plugin instance identifier. Also names the session state key the plugin stashes saved versions under. |
| `attachFileReference` | `boolean` | `true`                             | Whether to append a `fileData` part next to the placeholder.                                          |

Set `attachFileReference: false` to save the bytes without giving the model a direct read:

```typescript
new SaveFilesAsArtifactsPlugin({attachFileReference: false});
```

## Naming and scope

The artifact filename comes from `inlineData.displayName`. When the blob carries no display name, the plugin generates `artifact_<invocationId>_<partIndex>` and logs the name it chose. Two uploads with the same display name overwrite each other, and the later save gets a higher version number.

Artifacts are session-scoped. Prefix the display name with `user:` to store a file against the user instead, so a later session can still read it.

## The file reference

The plugin only appends a `fileData` part when all three of these hold:

1. `attachFileReference` is true.
2. `artifactService.getArtifactVersion` returns a record with a `canonicalUri`.
3. That URI uses the `gs`, `https` or `http` scheme.

A `file://` or `memory://` URI, or an artifact service that reports no URI at all, leaves only the placeholder — no model connector could fetch those. `InMemoryArtifactService` reports no canonical URI, so the placeholder is all you get from it. `GcsArtifactService` reports the object's public `https://` URL.

The reference takes its mime type from the blob, falling back to the version record's.

## Size limit

A blob whose decoded size exceeds 20 MB is rejected, matching the Gemini API inline-data limit. The plugin does not save it. It replaces the part with an error the model can read and explain:

```
[Upload Error: File report.pdf (21.00 MB) exceeds the maximum supported size of 20MB. Please upload a smaller file.]
```

The limit is measured on the decoded bytes, not on the base64 text that carries them, so the same file is accepted or rejected in adk-js and adk-python alike. A file at exactly 20 MB is saved.

## Failure handling

A part is handled on its own. If saving one file throws, the plugin logs the error, keeps that part unchanged, and carries on with the rest of the message. A message whose only file fails is therefore passed through untouched. If resolving the artifact version throws, the plugin logs a warning and omits the file reference; the artifact is still saved.

## Reporting the saved version

Each save is stashed on the session state under `<name>:pending_delta`. The plugin's `beforeAgentCallback` drains that stash into `callbackContext.actions.artifactDelta` and clears it, which is what puts the write on the event stream.

`BaseAgent` in adk-js does not call plugin agent callbacks yet, so nothing drains the stash during a normal `runner.runAsync` turn. Saving, rewriting and the file reference are unaffected. To report the delta today, drive the hook through the plugin manager yourself:

```typescript
await runner.pluginManager.runBeforeAgentCallback({agent, callbackContext});
```
