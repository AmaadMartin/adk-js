# Code executors

A code executor lets an `LlmAgent` run the code its model writes. The agent
finds a fenced code block in the model's response, hands it to the executor,
and sends the output back to the model as the next turn, so the model can
compute an answer instead of guessing one.

## Introduction

A language model is unreliable at arithmetic, at counting, and at reading a
table it cannot see all of at once. Code is reliable at all three. A code
executor closes that gap: the model writes a small program, the program runs,
and the model reads what it printed before answering.

You set one executor on an agent through `LlmAgent`'s `codeExecutor` field. The
executor is not a tool. The model never calls it by name and it does not appear
in the tool list; the agent reads the model's text for a code block and acts on
it. That difference decides how you prompt for it: the instruction asks the
model to write a fenced code block, not to call a function.

The executors differ in where the code runs, and that is the choice you make.

| Executor                         | Where the code runs                                      | Import from                                  |
| :------------------------------- | :------------------------------------------------------- | :------------------------------------------- |
| `BuiltInCodeExecutor`            | Inside the Gemini model, as its code execution tool      | `@google/adk`                                |
| `UnsafeLocalCodeExecutor`        | A child process on this machine, with no sandbox         | `@google/adk`, Node.js only                  |
| `ContainerCodeExecutor`          | A long-lived Docker container, networking off by default | `@google/adk`, Node.js only                  |
| `VertexAiCodeExecutor`           | The Vertex AI Code Interpreter extension                 | `@google/adk`, Node.js only                  |
| `AgentEngineSandboxCodeExecutor` | A Vertex AI Agent Engine sandbox                         | `@google/adk`, Node.js only                  |
| A subclass of `BaseCodeExecutor` | Wherever your `executeCode` sends it                     | Extend `BaseCodeExecutor` from `@google/adk` |

`BuiltInCodeExecutor` is the only one the model runs itself. Every other
executor runs code that ADK extracts from the response, and the rest of this
guide is about that path.

## Get started

This example gives an agent `UnsafeLocalCodeExecutor` and tells the model to
answer by writing Python.

```ts
import {LlmAgent, UnsafeLocalCodeExecutor} from '@google/adk';

export const rootAgent = new LlmAgent({
  name: 'calculator',
  model: 'gemini-flash-latest',
  instruction: `Answer by writing one Python code block fenced as \`\`\`python.
Print every value you need. The output comes back in a \`\`\`tool_output block.`,
  codeExecutor: new UnsafeLocalCodeExecutor(),
});
```

Asked for the 50th Fibonacci number, the model replies with a code block. The
agent runs it and emits two events before the model answers: one whose part is
`executableCode` holding the code, and one whose part is `codeExecutionResult`
holding the output. The model then receives the output and replies in text.

`UnsafeLocalCodeExecutor` runs the code as the current user with full access to
the file system and the network. Use it where you trust whoever writes the
prompt, and a container or a managed sandbox anywhere else.

## How it works

One user turn can go round the model several times. Each round follows the
same steps.

1. **The request goes out.** Earlier code and results in the conversation are
   rewritten as text, so any model can read them. A turn that ends in an
   `executableCode` part has it replaced by a block fenced with the executor's
   first `codeBlockDelimiters` pair, ` ```tool_code ` by default. A turn that
   holds only a `codeExecutionResult` part becomes a ` ```tool_output ` block in
   a `user` turn.
2. **The response comes back.** The agent looks for the first code block in it,
   either an `executableCode` part with no result after it or text between one
   of the `codeBlockDelimiters` pairs. The response is cut off after that block,
   and anything the model wrote after the code is dropped. A response with no
   code block ends the loop and is the answer.
3. **The code runs.** The agent emits the truncated response as an event, calls
   `executeCode`, and emits a second event with one `codeExecutionResult` part.
   Its `output` field carries the text the model reads next:
   - With `stderr` set, the outcome is `OUTCOME_FAILED` and `output` is the
     `stderr` text alone. Standard output is discarded.
   - Otherwise the outcome is `OUTCOME_OK`, and `output` is
     `Code execution result:\n<stdout>\n` followed, when there are output files,
     by a blank line and `` Saved artifacts:\n`a.csv`,`b.png` ``.
4. **Files are saved.** Each output file is saved through the invocation's
   artifact service under its `name`, and the result event's
   `actions.artifactDelta` maps each name to the version the service returned.
   An invocation without an artifact service throws
   `Artifact service is not initialized.` at this step. `InMemoryRunner` and
   `adk web` both supply one.
5. **The model goes again.** The result event is not a final response, so the
   agent calls the model again with the output in the history.

Two limits keep the loop bounded. `errorRetryAttempts` stops execution once
that many consecutive runs in one invocation have set `stderr`; a successful run
resets the count. The model can still keep answering, but its code blocks are
no longer run. And each executor applies its own timeout to a single run.

The agent passes `CodeExecutionLanguage.PYTHON` for every block it extracts,
whatever the fence says. A ` ```javascript ` block is recognized because
`javascript` is one of the default delimiters, and then runs as Python. Prompt
for Python unless you override `executeCode` to decide the language yourself.

The executor state the agent keeps between rounds, such as the error count and
the execution id, lives in session state under keys beginning with
`_code_execution` and `_code_executor`. Treat those keys as reserved.

## Configuration options

Every executor inherits these fields from `BaseCodeExecutor`. They are public
properties rather than constructor options, so you set them on the instance
after constructing it.

| Field                       | Type                      | Default                                                                | Description                                                              |
| :-------------------------- | :------------------------ | :--------------------------------------------------------------------- | :----------------------------------------------------------------------- |
| `codeBlockDelimiters`       | `Array<[string, string]>` | `tool_code`, `python`, `javascript`, `typescript`, `bash`, `sh` fences | The opening and closing strings that mark a code block in model text.    |
| `executionResultDelimiters` | `[string, string]`        | `['```tool_output\n', '\n```']`                                        | The strings wrapped around a result when it is sent back to the model.   |
| `errorRetryAttempts`        | `number`                  | `2`                                                                    | Consecutive failed runs after which the agent stops executing code.      |
| `stateful`                  | `boolean`                 | `false`                                                                | Whether to pass the session id to the executor as `executionId`.         |
| `optimizeDataFile`          | `boolean`                 | `false`                                                                | Whether to pull CSV attachments out of the prompt and into the executor. |

`codeBlockDelimiters` decides what counts as code. Each pair is an opening and a
closing string, and the opening string includes the newline after the fence
name. The first pair also formats earlier code blocks in the request, so put
the fence you want the model to imitate first. adk-python's list has only the
`tool_code` and `python` pairs; the extra four pairs are an adk-js addition.

`errorRetryAttempts` is a count of consecutive failures per invocation, not a
retry of the same code. Each failure goes back to the model, which usually
writes a corrected block; this field decides how many chances it gets. A new
user turn starts a new invocation and a new count.

`stateful` does not make an executor stateful by itself. With it set, the agent
sends the session id as `executionId` on every run, and an executor that keeps
a runtime per id can keep variables between blocks. `VertexAiCodeExecutor`
forwards it to the extension as `session_id`. `UnsafeLocalCodeExecutor`
ignores `executionId` and starts a fresh process every time.

`optimizeDataFile` handles a CSV file attached to a user message. The agent
replaces the attachment with the text ``Available file: `data_<m>_<n>.csv` ``,
numbered by the message and part it came from, stores the file in session state, and passes it to the executor as an input file
on every later run. The first time it sees a file, the agent also runs a
`pandas` snippet that loads and describes it, so the executor needs `pandas`.
`UnsafeLocalCodeExecutor` sets this field to `false` in its constructor.

### UnsafeLocalCodeExecutor options

`UnsafeLocalCodeExecutor` takes an `UnsafeLocalCodeExecutorOptions` object.

| Option              | Type     | Default                            | Description                          |
| :------------------ | :------- | :--------------------------------- | :----------------------------------- |
| `timeoutSeconds`    | `number` | `30`                               | Wall-clock limit for one run.        |
| `pythonCommandPath` | `string` | `python3`, or `python` on Windows  | The interpreter for Python code.     |
| `commandPath`       | `string` | `process.execPath`                 | The interpreter for JavaScript code. |
| `shellCommandPath`  | `string` | `bash`, or `powershell` on Windows | The interpreter for shell code.      |

Each run writes the code to a script in a new temporary directory, copies the
input files beside it, and runs the interpreter there. Every regular file left
in the directory afterwards, other than the script and the input files, comes
back as an output file named by its path relative to the directory. The
directory is then deleted. A run that exceeds `timeoutSeconds` is killed, and
`stderr` ends with `Code execution timed out after <n> seconds.` A non-zero exit
with nothing on standard error sets `stderr` to `Exit code <n>`.

### VertexAiCodeExecutor options

`VertexAiCodeExecutor` takes a `VertexAiCodeExecutorOptions` object.

| Option                     | Type                       | Default                                           | Description                          |
| :------------------------- | :------------------------- | :------------------------------------------------ | :----------------------------------- |
| `resourceName`             | `string`                   | The `CODE_INTERPRETER_EXTENSION_NAME` variable    | The extension to run code on.        |
| `codeInterpreterExtension` | `CodeInterpreterExtension` | A `VertexAiCodeInterpreterExtension` for the name | The client that calls the extension. |

`resourceName` has the form
`projects/<project>/locations/<location>/extensions/<id>`, and the location in
it picks the regional endpoint. The constructor throws when there is neither a
resource name nor a `codeInterpreterExtension`, because adk-js does not create
an extension for you; adk-python creates one from the extension hub in that
case. `VertexAiCodeInterpreterExtension` authenticates with Application Default
Credentials.

Each run prepends a preamble that imports `io`, `math`, `re`,
`matplotlib.pyplot as plt`, `numpy as np`, `pandas as pd` and `scipy`, and
defines `crop` and `explore_df`. Output files are renamed by type:
`plot_<yyyyMMdd_HHmmss>_<n>.<ext>` for PNG and JPEG images,
`data_<yyyyMMdd_HHmmss>_<n>.csv` for CSV files, and
`<yyyyMMdd_HHmmss>_<n>.<ext>` for anything else. The timestamp is local time.
`n` counts only images and CSV files, so two files of another type in one run
receive the same name, and the second is saved as a new version of the first.

Pass a `codeInterpreterExtension` of your own to route calls through a proxy or
to test an agent without a network. The interface has one method, `execute`,
which receives `{operationId, operationParams}` and resolves to the extension's
response in its wire format: `execution_result`, `execution_error` and
`output_files`, each optional.

## Advanced applications

Subclass `BaseCodeExecutor` to run code somewhere ADK does not support, such as
a remote job queue. Implement `executeCode`, which receives the invocation
context and a `CodeExecutionInput`, and resolve to a `CodeExecutionResult`.

```ts
import {
  BaseCodeExecutor,
  CodeExecutionResult,
  ExecuteCodeParams,
} from '@google/adk';

class RemoteCodeExecutor extends BaseCodeExecutor {
  override async executeCode({
    codeExecutionInput,
  }: ExecuteCodeParams): Promise<CodeExecutionResult> {
    const {stdout, stderr} = await submitToQueue(codeExecutionInput.code);
    return {stdout, stderr, outputFiles: []};
  }
}
```

`CodeExecutionInput` carries `code`, `language`, `inputFiles`, and the optional
`executionId` and `args`. `CodeExecutionResult` requires all three of `stdout`,
`stderr` and `outputFiles`, so return empty values rather than leaving one out.
Remember that any non-empty `stderr` marks the run as failed, including
warnings a program prints there while succeeding.

An output `File` has a `name`, a `content` string and a `mimeType`, and an
optional `contentEncoding` of `FileContentEncoding.UTF8` or
`FileContentEncoding.BASE64`. The agent saves `content` as the artifact's
`inlineData.data` without converting it, so return base64 content when the
artifact must be readable as binary.

## Limitations

- Only the first code block in a response runs. Anything the model wrote after
  it is dropped, so ask for one block per reply.
- `ContainerCodeExecutor` ignores `inputFiles` and returns no output files, so
  `optimizeDataFile` and file outputs do not work with it.
- `UnsafeLocalCodeExecutor`, `ContainerCodeExecutor`, `VertexAiCodeExecutor`
  and `AgentEngineSandboxCodeExecutor` are exported only from the Node.js entry
  point of `@google/adk`, not from the browser build.
- `BuiltInCodeExecutor` throws
  `Gemini code execution tool is not supported for model <model>` for a model
  other than Gemini 2 or later.

## Related samples

- [`samples/code_execution/local_code_execution/`](../../../samples/code_execution/local_code_execution/README.md) - An agent that answers by writing Python, run by `UnsafeLocalCodeExecutor`, with a file saved as an artifact.
