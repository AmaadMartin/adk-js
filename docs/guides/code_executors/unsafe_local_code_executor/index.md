# UnsafeLocalCodeExecutor

`UnsafeLocalCodeExecutor` runs a model's code on the machine the agent runs on,
with no sandbox. Reach for it in local development, in tests, and in a
trusted-input batch job. Do not reach for it when the code comes from an
untrusted user.

## Introduction

An agent that computes needs somewhere to run its code. ADK ships several
executors behind one interface, and they differ in where the code lands: a
container, a Vertex AI sandbox, or -- here -- the local host. The local one has
no isolation at all, so the program it runs can read your files and reach your
network. That is the whole trade: it needs no infrastructure and starts in
milliseconds.

The executor launches one child process per execution, in a scratch directory
it creates and deletes. Input files are written into that directory, and files
the program leaves behind come back as output files. Nothing carries over
between executions: the executor is not stateful, and it rejects a `stateful`
or `optimizeDataFile` option rather than ignoring one it cannot honour.

## Get started

Give an `LlmAgent` a `codeExecutor` and the model's code blocks run through it.

```ts
import {LlmAgent, UnsafeLocalCodeExecutor} from '@google/adk';

const agent = new LlmAgent({
  name: 'data_agent',
  model: 'gemini-2.5-flash',
  instruction: 'Write python to answer the question, then explain the result.',
  codeExecutor: new UnsafeLocalCodeExecutor({timeoutSeconds: 10}),
});
```

The options are `timeoutSeconds` (30 by default), and the command each language
runs through: `commandPath` for JavaScript, `pythonCommandPath` for Python, and
`shellCommandPath` for shell.

## Reading the result

A run reports `stdout`, `stderr`, `outputFiles` and `exitCode`.

`exitCode` is what says whether the run failed. It is the status the process
exited with, and it is negative when a signal ended the program (`-9` for
`SIGKILL`). ADK reports a program that printed a warning and exited 0 to the
model as a success, and the warning stays in `stderr` for the caller to read.

When a program fails without saying why -- it called `os._exit`, or a signal
killed it -- the executor writes the sentence `Code execution exited with
status <n>.` into `stderr`, so the model sees the failure.

```ts
import {CodeExecutionLanguage, UnsafeLocalCodeExecutor} from '@google/adk';

const executor = new UnsafeLocalCodeExecutor();
const result = await executor.executeCode({
  invocationContext,
  codeExecutionInput: {
    code: "import sys\nsys.stderr.write('a warning')\nprint('42')",
    language: CodeExecutionLanguage.PYTHON,
    inputFiles: [],
  },
});
// result.stdout === '42\n', result.stderr === 'a warning', result.exitCode === 0
```

## How Python runs

The program is written to the child interpreter's stdin, not to a file, so its
size is not capped by the operating system's argument limit. The interpreter
compiles it under the name `<code>`, which is the name a traceback shows.
Three consequences are worth knowing:

- The program has no `__file__`, and `sys.argv[0]` is `-c`. Arguments passed in
  `codeExecutionInput.args` are still in `sys.argv[1:]`.
- The program cannot read stdin: the executor has already read it to the end.
- A traceback carries the program's own frames only. The frame belonging to
  ADK's wrapper is removed, because the model can do nothing with it.

Code guarded by `if __name__ == '__main__':` runs, and code without that guard
has no `__name__`. The child also inherits two pinned variables: `PYTHONPATH`
starts with the directory the agent process was started from, so imports that
resolved for the application still resolve; and `PYTHONIOENCODING` is `utf-8`,
so a program that prints non-ASCII does not die on a host configured for ASCII.

## Timeouts

An execution that outlives `timeoutSeconds` is signalled `SIGTERM`, and
`SIGKILL` five seconds later if it is still alive. `stderr` then ends with
`Code execution timed out after <n> seconds.`, after whatever the program had
already written.

On POSIX the child leads its own process group, so both signals reach every
process the program started. That also detaches the child from the terminal:
`Ctrl-C` in an interactive session no longer reaches it. Windows has no process
group to signal, so only the child itself is killed there.
