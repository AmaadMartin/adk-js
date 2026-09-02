# LoadArtifactsTool

`LoadArtifactsTool` lets a model pull a saved artifact into the current request.
It also converts an artifact the model cannot read — a DOCX file, an SVG image,
a CSV blob — into text before the request goes out. Reach for it whenever an
agent must answer questions about files a user uploaded.

## Introduction

An artifact lives in the artifact service, not in the conversation. The model
therefore cannot see it until something puts it in the request. This tool is
that something: it lists the artifact names in the system instruction, and when
the model calls `load_artifacts`, it appends the named artifacts to the request
for that one turn.

Appending raw bytes is not always safe. Gemini accepts images, audio, video and
PDF as inline data, and rejects everything else. It rejects SVG with a 400 even
though the type starts with `image/`. So the tool runs each artifact through
`asSafePartForLlm` first. An artifact Gemini accepts passes through untouched.
Anything else becomes text: a DOCX file becomes its extracted paragraphs, a
text-like payload becomes its decoded text, and a payload that is neither
becomes a short placeholder naming the artifact and its size. Conversion never
throws — a document the tool cannot read degrades to the placeholder.

Two hooks change that behaviour. `enableSpreadsheetParsing` adds a converter
that renders an XLSX workbook as markdown tables. `processArtifact` replaces the
built-in conversion entirely, so an application can redact an artifact or drop
it before the model ever sees it.

## Get started

Add `LOAD_ARTIFACTS` to an agent's tools and give the runner an artifact
service. `InMemoryRunner` supplies one already.

```ts
import {InMemoryRunner, LOAD_ARTIFACTS, LlmAgent} from '@google/adk';
import {createUserContent} from '@google/genai';

const agent = new LlmAgent({
  name: 'artifact_agent',
  model: 'gemini-2.5-flash',
  instruction: 'Load the artifact the user asks about, then answer from it.',
  tools: [LOAD_ARTIFACTS],
});

const runner = new InMemoryRunner({agent, appName: 'artifact_app'});
const session = await runner.sessionService.createSession({
  appName: 'artifact_app',
  userId: 'u1',
});

await runner.artifactService!.saveArtifact({
  appName: 'artifact_app',
  userId: 'u1',
  sessionId: session.id,
  filename: 'people.csv',
  artifact: {
    inlineData: {
      data: Buffer.from('name,age\nAlice,30\n', 'utf8').toString('base64'),
      mimeType: 'application/csv',
    },
  },
});

let answer = '';
for await (const event of runner.runAsync({
  userId: 'u1',
  sessionId: session.id,
  newMessage: createUserContent('How old is Alice in people.csv?'),
})) {
  answer += event.content?.parts?.[0]?.text ?? '';
}
```

## How an artifact is converted

`asSafePartForLlm` decides in this order.

1. An artifact with no `inlineData` is returned unchanged.
2. An artifact whose MIME type Gemini accepts inline is returned unchanged:
   `image/*`, `audio/*`, `video/*` and `application/pdf`. The SVG and XML image
   subtypes are excluded, because Gemini rejects them.
3. An artifact with no data becomes `[Artifact: <name>, type: <mime>. No inline
data was provided.]`.
4. `inlineData.data` is a base64 string. A string that is not base64 is taken as
   literal text and returned as it is.
5. A DOCX file becomes its text. The tool tries this when the MIME type is the
   DOCX type or `application/octet-stream`, or when the name ends `.docx`.
6. A text-like payload becomes its decoded text. The tool tries this when the
   MIME type starts `text/`, or is one of `application/csv`,
   `application/json`, `application/xml`, `application/svg+xml`, `image/svg`,
   `image/svg+xml` or `image/xml`, or when the name ends `.csv`, `.txt`,
   `.json` or `.xml`.
7. A workbook becomes markdown, but only when `enableSpreadsheetParsing` is on.
8. Anything left becomes `[Binary artifact: <name>, type: <mime>, size: <n> KB.
Content cannot be displayed inline.]`.

The function is exported, so a `processArtifact` callback can call it to fall
back to the default behaviour for artifacts it does not want to handle itself.

## Spreadsheets

Spreadsheet parsing is off by default. Turn it on per tool instance:

```ts
import {LoadArtifactsTool} from '@google/adk';

const tools = [new LoadArtifactsTool({enableSpreadsheetParsing: true})];
```

Each sheet renders as a markdown table under a `### Sheet: <name>` heading. The
first row is the header, and a sheet with no rows below its header is left out.

A workbook is an untrusted upload, so every dimension of the output is capped
and the renderer says when a cap applied: 100 data rows per sheet, 100 columns
per sheet, and 100 sheets per workbook. Exceeding one appends a notice such as
`[Output is limited to the first 100 rows. Total rows: <n>]`.

Two limitations are worth knowing. The legacy binary `.xls` format is not a zip
container, so it yields `[Invalid spreadsheet format: ...]`. Cells render from
their stored values, so a date held as a serial number renders as that number.

## Customizing or filtering an artifact

`processArtifact` runs in place of the built-in conversion, so the callback
receives the artifact exactly as it was loaded. Return a part to add it, or
`undefined` to leave the artifact out of the request.

```ts
import {LoadArtifactsTool, asSafePartForLlm} from '@google/adk';

const tool = new LoadArtifactsTool({
  processArtifact: async (artifact, artifactName) => {
    if (artifactName.endsWith('.pem')) {
      return undefined;
    }
    return asSafePartForLlm(artifact, artifactName);
  },
});
```

The callback may be synchronous or asynchronous. It receives the artifact name
without the `user:` prefix, even when the artifact was found only under that
prefix. If it throws, the tool logs the error and leaves that artifact out; the
remaining artifacts still load.

## Declaration shape

The tool normally declares its parameters as a `Schema`. Enable the
experimental `JSON_SCHEMA_FOR_FUNC_DECL` feature to declare them as
`parametersJsonSchema` instead:

```ts
import {FeatureName, withTemporaryFeatureOverride} from '@google/adk';

const declaration = await withTemporaryFeatureOverride(
  FeatureName.JSON_SCHEMA_FOR_FUNC_DECL,
  true,
  () => tool._getDeclaration(),
);
```

The feature is off by default and also reads the
`ADK_ENABLE_JSON_SCHEMA_FOR_FUNC_DECL` environment variable.
