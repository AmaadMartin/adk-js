# UnsafeLocalCodeExecutor

`UnsafeLocalCodeExecutor` runs a model-generated program in a child process on
the host, with no sandbox. Reach for it in development, when you want the
shortest path from a generated code block to a result, and you already trust
the model and the machine.

## Introduction

A model that writes code cannot run it. An executor closes that gap: the agent
extracts the code block, hands it to `executeCode`, and feeds the output back
into the conversation. `UnsafeLocalCodeExecutor` is the simplest of these. It
spawns an interpreter on the host and captures its streams.

It provides no isolation. The program runs with your process's user, files and
network. `ContainerCodeExecutor` and `VertexAiCodeExecutor` isolate the program
instead, at the cost of a Docker daemon or a Google Cloud project. Choose this
executor only for code you would run yourself.

The executor supports JavaScript, Python, Shell, PowerShell and cmd. It writes
input files into a private scratch directory, runs the program with that
directory as its working directory, and returns any file the program left
behind.

## Get started

Configure it on an agent through `codeExecutor`, or drive it directly:

```typescript
import {CodeExecutionLanguage, UnsafeLocalCodeExecutor} from '@google/adk';

const executor = new UnsafeLocalCodeExecutor({timeoutSeconds: 30});

const result = await executor.executeCode({
  invocationContext,
  codeExecutionInput: {
    code: 'print("answer: 42")',
    language: CodeExecutionLanguage.PYTHON,
    inputFiles: [],
  },
});

console.log(result.stdout); // "answer: 42\n"
console.log(result.stderr); // ""
```

## How a result is classified

`stderr` is what marks a run failed. A non-empty `stderr` drives the agent's
retry counter, so the executor derives it from the child's exit status rather
than from whatever the program printed:

| The child                                | `stderr`                                    |
| ---------------------------------------- | ------------------------------------------- |
| Exits 0                                  | `''`, even when the program wrote a warning |
| Exits non-zero, having written to stderr | What the program wrote                      |
| Exits non-zero silently                  | `Code execution exited with status 3.`      |
| Dies by signal                           | `Code execution exited with status -9.`     |
| Times out                                | The program's output, then the timeout note |

A program that prints a deprecation warning and exits 0 therefore reports a
clean run:

```typescript
const result = await executor.executeCode({
  invocationContext,
  codeExecutionInput: {
    code: [
      'import sys',
      'print("answer: 42")',
      'sys.stderr.write("DeprecationWarning: old api\\n")',
    ].join('\n'),
    language: CodeExecutionLanguage.PYTHON,
    inputFiles: [],
  },
});

// result.stdout === 'answer: 42\n'
// result.stderr === ''
```

## Timeouts

`timeoutSeconds` bounds the run and defaults to 30. On the deadline the
executor sends `SIGTERM`, waits five seconds, then sends `SIGKILL` and releases
the read ends of the child's pipes.

On POSIX the child leads its own process group, so both signals reach
everything the program spawned. A worker the program left running does not
outlive the timeout, and cannot hold the output pipes open. The child also stops
receiving the parent terminal's `SIGINT` as a consequence of leading its own
group.

Windows has no process group to signal, so only the child itself is killed
there.

## How Python runs

The Python program arrives on the child's stdin, not in a script file. Three
consequences follow.

The program has no `__file__`, and its tracebacks name `<code>`. Only the
program's own frames appear; the executor's wrapper does not.

`__name__` follows the code. A program containing `if __name__ == '__main__':`
runs as `__main__`; one without the guard does not:

```typescript
// prints "guarded ran"
"if __name__ == '__main__':\n  print('guarded ran')";

// prints "None"
"print(globals().get('__name__'))";
```

Stdin is at end-of-file once the program starts, so `input()` raises
`EOFError` instead of blocking until the timeout. The same holds for the other
languages, whose stdin is closed immediately.

The Python child also gets two environment variables:

- `PYTHONPATH` starts with `process.cwd()`, then whatever the host already set.
  The child runs in the scratch directory, so this keeps a module the
  application can import resolvable.
- `PYTHONIOENCODING` is `utf-8`. Without it the child encodes its output with
  the host locale and dies printing non-ASCII on a non-UTF-8 host.

## State between runs

`stateful` and `optimizeDataFile` are always false. Every execution gets a fresh
process and a fresh scratch directory, so no variable defined in one run
survives into the next.
