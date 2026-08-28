# ExecuteBashTool

`ExecuteBashTool` lets an agent run a shell command in a directory you choose.
Every call stops for a human to approve it. Reach for it when an agent must
inspect or drive a real working tree, and you accept that an approved command
runs on the host.

## Introduction

An agent that can read a repository, run a build, or call a script needs a way
to run commands. ADK already has two neighbouring pieces, and neither does this
job:

- `LocalEnvironment` runs commands in a working directory, but it is a
  building block, not a tool. A model never sees it, and it has no policy and
  no approval step.
- A code executor (`UnsafeLocalCodeExecutor`, `AgentEngineSandboxCodeExecutor`)
  runs a _script_ the model writes, in the executor's own environment. That is
  a different input and a different place to run it.

`ExecuteBashTool` fills the gap. It is a `BaseTool`, so you add it to an agent's
`tools`. It declares one parameter, `command`. Before it runs anything it
checks the command against a policy, then it asks the user. Only an approved
call reaches the host.

Two properties are worth knowing before you adopt it.

The tool does not use a shell. It tokenizes the command with POSIX `shlex`
rules and runs the resulting argument list directly. So `ls ; rm -rf /` passes
`;` and `rm` to `ls` as literal arguments. Pipelines, redirection and command
substitution do not work unless the model asks for `bash -c` explicitly.

The tool is not a sandbox. An approved command runs with the agent process's
own user, environment and file access. The policy narrows what a model can ask
for; it does not contain what an approved command then does.

## Get started

```ts
import {ExecuteBashTool, LlmAgent} from '@google/adk';

const agent = new LlmAgent({
  name: 'ops',
  model: 'gemini-2.5-flash',
  tools: [new ExecuteBashTool({workspace: '/srv/sandbox'})],
});
```

`workspace` is the command's working directory. It must already exist; the tool
does not create it. It defaults to `process.cwd()`.

## The confirmation gate

A call takes two turns.

On the first turn the tool records a confirmation request and returns:

```json
{"error": "This tool call requires confirmation, please approve or reject."}
```

It also sets `skipSummarization`, so the model does not narrate the pause. Your
client reads the request from
`context.actions.requestedToolConfirmations[functionCallId]` and shows the hint,
which names the command:

```
Please approve or reject the bash command: ls -la
```

On the second turn, after the user approves, the tool runs the command. If the
user rejects it, the tool returns `{"error": "This tool call is rejected."}` and
runs nothing.

There is no option that turns the gate off.

## Restricting what may be asked

The `policy` option narrows the commands a model may request.

```ts
new ExecuteBashTool({
  workspace: '/srv/sandbox',
  policy: {
    allowedCommandPrefixes: ['ls', 'cat', 'git status'],
    blockedOperators: ['|', ';', '$(', '`', '&&', '||'],
    timeoutSeconds: 10,
    maxMemoryBytes: 100 * 1024 * 1024,
    maxFileSizeBytes: 50 * 1024 * 1024,
    maxChildProcesses: 10,
  },
});
```

| Field                    | Meaning                                                                        |
| ------------------------ | ------------------------------------------------------------------------------ |
| `allowedCommandPrefixes` | Prefixes the command may start with. `['*']`, the default, allows any command. |
| `blockedOperators`       | Substrings that reject the command outright. Empty by default.                 |
| `timeoutSeconds`         | Wall-clock budget. Defaults to 30. `null` disables it.                         |
| `maxMemoryBytes`         | Address-space limit for the child.                                             |
| `maxFileSizeBytes`       | Largest file the child may write.                                              |
| `maxChildProcesses`      | Process limit for the child's user.                                            |

The policy also shapes the tool description the model reads, so a restricted
tool tells the model which prefixes it may use.

A prefix allowlist is a coarse filter. It compares the start of the trimmed
command string, so `cat` also admits `catalog`. Treat it as a way to keep an
agent on task, not as a security boundary.

The three resource limits are applied by a `bash` prologue that calls `ulimit`
before it `exec`s the command. The command itself is still passed as an
argument list, so the shell never re-parses it. A limit the kernel refuses is
skipped silently. When you set no limit, the prologue is skipped entirely.

## What the tool returns

A finished command returns the captured output and the exit status:

```json
{
  "stdout": "pdf\nsample.pdf\n",
  "stderr": "<no stderr captured>",
  "returncode": 0
}
```

An empty capture is reported as `<no stdout captured>` or
`<no stderr captured>`, not as an empty string. `returncode` is the exit status,
or the negative signal number when a signal killed the process.

A command that runs past `timeoutSeconds` gets `SIGKILL` sent to its whole
process group. The result then carries an `error` alongside the output:

```json
{
  "error": "Command timed out after 10 seconds.",
  "stdout": "…",
  "stderr": "…",
  "returncode": -9
}
```

A command that cannot start, and a command line the tokenizer cannot read,
return `{"error": "Execution failed: …"}` with the two output fields and no
`returncode`.

## Limits

- POSIX hosts only. On Windows an approved call returns
  `{"error": "ExecuteBashTool is only supported on POSIX systems."}`.
- The child inherits the whole of `process.env`, so any secret in the agent's
  environment is visible to the command.
- Output is buffered in memory with no cap, so a command that prints without
  bound grows the heap until it fails.
- The tool kills the command's process group on timeout. A grandchild that
  survives `SIGKILL` is outside its control.
- The child's stdin is closed. A command that waits for input reads end of
  file rather than stealing the agent's own stdin.
