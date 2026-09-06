# VertexAiCodeExecutor

Runs model-generated Python on a managed Vertex AI Code Interpreter extension.
Reach for it when an agent must compute, transform data or draw a chart, and you
do not want that code running on your own machine.

## Introduction

A code executor is what turns a model's Python block into a real result. ADK
ships several, and they differ in where the code runs.
`UnsafeLocalCodeExecutor` runs it in a subprocess on the host, which is fast and
has no isolation at all. `AgentEngineSandboxCodeExecutor` runs it in an Agent
Engine sandbox that you create and own. `VertexAiCodeExecutor` runs it in a
Vertex AI Code Interpreter extension, a managed Python environment that Google
provisions and keeps warm.

The extension ships with `matplotlib`, `numpy`, `pandas` and `scipy` already
installed, so a data-analysis agent needs no environment setup. The executor
prepends a fixed preamble to every execution that imports those libraries and
defines `explore_df`, a helper that prints the dtypes, null counts and unique
values of a DataFrame. Files the code writes come back as output files, and
files you attach go in as input files.

Note: Vertex AI Extensions is a Preview offering and is deprecated. See the
[Code Interpreter extension
documentation](https://cloud.google.com/vertex-ai/generative-ai/docs/extensions/code-interpreter).

## Get started

The executor needs Application Default Credentials with the `cloud-platform`
scope, and a project.

```ts
import {LlmAgent, VertexAiCodeExecutor} from '@google/adk';

const agent = new LlmAgent({
  name: 'data_scientist',
  model: 'gemini-2.5-flash',
  instruction: 'Answer questions by writing and running Python.',
  codeExecutor: new VertexAiCodeExecutor({stateful: true}),
});
```

With `stateful: true` the request processor sends the ADK session id to the
extension as its interpreter session id, so a later code block sees the
variables an earlier one defined. It defaults to `false`, which runs every
block on its own.

## Choosing the extension

The executor resolves the extension in this order:

1. the `resourceName` option;
2. the `CODE_INTERPRETER_EXTENSION_NAME` environment variable;
3. a new extension, imported from the public hub on the first execution.

An extension it creates is written back into
`CODE_INTERPRETER_EXTENSION_NAME`, and exposed as `executor.resourceName`, so
you can reuse it on the next run:

```ts
const executor = new VertexAiCodeExecutor({
  resourceName: 'projects/my-project/locations/us-central1/extensions/456',
});
```

One executor creates at most one extension, even when several executions start
at the same time. A resource name pins its own region, so `location` is read
only when the executor has to create an extension; it falls back to
`GOOGLE_CLOUD_LOCATION` and then to `us-central1`. A malformed resource name
throws from the constructor rather than on the first call.

## Files and MIME types

Input files go to the extension as they are: `File.content` is already
base64-encoded, and the executor does not re-encode it. Output files come back
the same way, so an artifact service can store the content directly.

The MIME type of an output file comes from its extension: `png`, `jpg` and
`jpeg` become `image/<extension>`, `csv` becomes `text/csv`, and anything else
is guessed from the name, falling back to `application/octet-stream`. A `.jpg`
therefore reports `image/jpg` rather than the registered `image/jpeg`, matching
adk-python.

## Failure modes

The executor only runs Python. Given any other language it returns a result
whose `stderr` says so, rather than throwing, so the model can rewrite the block
and try again.

Everything else propagates. A non-2xx response from the extension, an import
that fails, and an import that does not finish within the poll budget all throw,
so a caller sees the fault instead of an empty result.
