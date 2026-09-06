# SaveFilesAsArtifactsPlugin

`SaveFilesAsArtifactsPlugin` moves every file a user attaches to a message into
the artifact service, and leaves a short text placeholder in its place. Reach
for it when users upload files in a chat, and the agent must still work with
those files later in the session.

## Introduction

A user message can carry a file as an `inlineData` part. That part travels with
the conversation, so the bytes are re-sent to the model on every later request
in the session. Nothing else can reach the file either: a tool receives only
what the model passes to it, and the model cannot pass a blob.

The plugin breaks that coupling. It saves each blob through the artifact
service, then rewrites the message to name the artifact instead of carrying it.
The bytes leave the conversation, and the file stays reachable by name for the
rest of the session. Add the `LOAD_ARTIFACTS` tool to the agent, or load the
artifact in your own tool, to read the file back.

`RunConfig.saveInputBlobsAsArtifacts` runs a similar save inside the runner.
The plugin adds the 20MB size limit and the `attachFileReference` switch.

## Get started

Register the plugin on the runner. The runner must have an artifact service;
`InMemoryRunner` creates one for you.

```typescript
import {readFileSync} from 'node:fs';

import {
  InMemoryRunner,
  LlmAgent,
  LOAD_ARTIFACTS,
  SaveFilesAsArtifactsPlugin,
} from '@google/adk';

const agent = new LlmAgent({
  name: 'file_assistant',
  model: 'gemini-2.5-flash',
  instruction: 'Answer questions about the files the user uploads.',
  tools: [LOAD_ARTIFACTS],
});

const runner = new InMemoryRunner({
  agent,
  appName: 'file_demo',
  plugins: [new SaveFilesAsArtifactsPlugin()],
});

const session = await runner.sessionService.createSession({
  appName: 'file_demo',
  userId: 'user1',
});

for await (const event of runner.runAsync({
  userId: 'user1',
  sessionId: session.id,
  newMessage: {
    role: 'user',
    parts: [
      {text: 'Summarize this.'},
      {
        inlineData: {
          displayName: 'report.pdf',
          mimeType: 'application/pdf',
          data: readFileSync('report.pdf').toString('base64'),
        },
      },
    ],
  },
})) {
  // Handle the event stream.
}
```

The model sees `Summarize this.` followed by
`[Uploaded Artifact: "report.pdf"]`, and `report.pdf` is now in the artifact
service.

## What the plugin puts in the message

The plugin walks the parts of the user message in order and keeps every part
that is not `inlineData`. For each blob it appends:

1. A placeholder, `[Uploaded Artifact: "<filename>"]`.
2. A `fileData` reference part, but only when the artifact service reports a
   canonical URI the model can fetch itself. The accepted schemes are `gs`,
   `https` and `http`. `GcsArtifactService` reports such a URI;
   `InMemoryArtifactService` and `FileArtifactService` do not, so no reference
   part is added with those.

Set `attachFileReference: false` to save the files without the reference part.
The model then reaches a file only through a tool.

```typescript
new SaveFilesAsArtifactsPlugin('save_files_as_artifacts_plugin', {
  attachFileReference: false,
});
```

## Filenames

The filename comes from `inlineData.displayName`. A blob without one is saved
as `artifact_<invocationId>_<index>`, where the index is the position of the
part in the original message.

Artifacts are scoped to the session. Prefix the display name with `user:` to
store the file in the user namespace instead, where later sessions of the same
user can load it.

Saving a file under a name that already exists appends a new version. The
placeholder always names the latest one.

## Limits and failures

A blob larger than 20MB is not saved. The Gemini API rejects inline data above
that size, and saving the file does not avoid the limit: `LOAD_ARTIFACTS`
pushes the artifact back into a later request as an inline part. The plugin
replaces the blob with an error the user can read:

```
[Upload Error: File report.pdf (24.30 MB) exceeds the maximum supported size of 20MB. Please upload a smaller file.]
```

The size is the decoded byte count, not the length of the base64 string.

Two failures leave the message usable rather than ending the invocation:

- The save fails. The plugin logs the error and keeps the original blob part,
  so the model still receives the file.
- The runner has no artifact service. The plugin logs a warning and leaves the
  message alone.
