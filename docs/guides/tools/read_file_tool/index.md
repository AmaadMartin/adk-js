# ReadFileTool

Lets an agent read a file out of a `BaseEnvironment` and get it back with line
numbers. Reach for it whenever the agent needs file content, instead of running
`cat`, `head` or `sed` through the environment's shell.

## Introduction

`BaseEnvironment` gives an agent a working directory it can run commands in and
read and write files in. Without a read tool, the only way for the model to see
a file is `Execute`, which puts a path the model chose onto a shell command
line. That path is model-supplied text, so quoting it correctly is the caller's
problem, and getting it wrong turns a file read into arbitrary command
execution.

`ReadFileTool` closes that gap. It calls `BaseEnvironment.readFile()` directly,
so the path never reaches a shell, and it never calls
`BaseEnvironment.execute()`. It also gives the model what a raw `cat` does not:
a 1-based line range, a line number in front of every line, and a character cap
so one large file cannot fill the context window.

The tool is read-only. It creates nothing and modifies nothing. Use
`BaseEnvironment.writeFile()` for the other direction.

## Get started

Attach the tool to an agent alongside the environment it should read from.

```ts
import {LlmAgent, LocalEnvironment, ReadFileTool} from '@google/adk';

const environment = new LocalEnvironment({workingDir: '/tmp/workspace'});
await environment.initialize();

const agent = new LlmAgent({
  name: 'file_reader',
  model: 'gemini-flash-latest',
  instruction: 'Use the ReadFile tool to read files before answering.',
  tools: [new ReadFileTool(environment)],
});
```

Call `initialize()` before the agent runs. `LocalEnvironment` rejects every
operation until you do.

A runnable version is at `samples/tools/read_file_tool/agent.ts`:

```
npm run sample -- samples/tools/read_file_tool/agent.ts
```

## What the model sends

The tool declares one required argument and two optional ones. The names are
`snake_case` because they match adk-python, and the two SDKs must show the same
schema to the same models.

| Argument     | Type    | Required | Meaning                                                                |
| ------------ | ------- | -------- | ---------------------------------------------------------------------- |
| `path`       | string  | yes      | Path of the file, relative to the working directory or absolute.       |
| `start_line` | integer | no       | First line to return, 1-based and inclusive. Defaults to line 1.       |
| `end_line`   | integer | no       | Last line to return, 1-based and inclusive. Defaults to the last line. |

A `start_line` below 1 is clamped to 1, and an `end_line` past the end of the
file is clamped to the last line. `0` and `null` both mean "not set".

## What the model gets back

`runAsync` always resolves with a plain object. It never rejects, so a failure
reaches the model as content it can act on rather than as an exception the flow
has to catch.

A successful read returns the selected lines. Each line is preceded by its
1-based number, right-aligned in a six-character column, then a tab. Original
line terminators are preserved.

For a `notes.txt` holding `alpha`, `beta`, `gamma` and `delta`:

```ts
const result = await tool.runAsync({args: {path: 'notes.txt'}, toolContext});
// {
//   status: 'ok',
//   content: '     1\talpha\n     2\tbeta\n     3\tgamma\n     4\tdelta\n',
// }
```

`total_lines` is added only when the read was partial — that is, when
`start_line` is past line 1 or `end_line` is before the last line. It tells the
model how much of the file it has not seen.

```ts
const result = await tool.runAsync({
  args: {path: 'notes.txt', start_line: 2, end_line: 3},
  toolContext,
});
// {status: 'ok', content: '     2\tbeta\n     3\tgamma\n', total_lines: 4}
```

A failure returns `{status: 'error', error}`. The two range errors also carry
`total_lines`, so the model can retry with a range that exists.

| Condition                                   | `error`                                             |
| ------------------------------------------- | --------------------------------------------------- |
| `path` missing, empty, or not a string      | `` `path` is required. ``                           |
| `start_line` present but not a whole number | `` `start_line` must be an integer if provided. ``  |
| `end_line` present but not a whole number   | `` `end_line` must be an integer if provided. ``    |
| `start_line` past the end of the file       | `` `start_line` 5 exceeds file length (2 lines). `` |
| `start_line` after `end_line`               | `` `start_line` (3) is after `end_line` (2). ``     |
| The file does not exist                     | `File not found: notes.txt`                         |
| Any other read failure                      | The underlying message.                             |

An empty file has zero lines, so reading one is the "exceeds file length" error
with `total_lines: 0`, not an empty success.

## Capping the output

The tool caps `content` at 30000 characters. Over the cap, it keeps the prefix
and appends a notice giving the original length:

```
... (truncated, 48211 total chars)
```

Set your own cap when the model has a smaller budget. `0` is honoured and
leaves only the notice.

```ts
new ReadFileTool(environment, {maxOutputChars: 4000});
```

The cap counts UTF-16 code units, so a character outside the Basic Multilingual
Plane costs two.

## Things to know

The tool reads the whole file into memory before it slices out the requested
lines, because `BaseEnvironment.readFile()` returns the complete contents. A
line range does not lower the cost of reading a large file.

Content is decoded as UTF-8. Bytes that are not valid UTF-8 become U+FFFD
instead of raising an error, and a leading byte order mark is kept as content.
Lines break on `\r\n`, `\r` and `\n`.

A missing file is recognised by Node's `ENOENT` code. A custom `BaseEnvironment`
that signals a missing file some other way gets the generic error message
instead of `File not found`.
