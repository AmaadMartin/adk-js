# Temp folder logging

The ADK CLI can send its log records to `<temp>/agents_log/` instead of the
terminal, one `agent.<timestamp>.log` per run with an `agent.latest.log`
symlink beside it. You can then tail the log in a second shell while the first
one stays readable.

`adk run` does this always, matching `adk run` in adk-python. The command paints
a chat transcript, and a log record between the prompt and the answer is what
the file exists to prevent. `adk web` and `adk api_server` keep logging to the
terminal unless you pass `--log_to_tmp`.

```console
$ adk run ./my_agent
Log setup complete: /tmp/agents_log/agent.20260829_000610.log
To access latest log: tail -F /tmp/agents_log/agent.latest.log
```

## What lands in the file

Each line is `<timestamp> - <LEVEL> - <label> - <message>`. The label names the
component that logged, such as `ADK API Server` or `AgentLoader`. The file
never receives the terminal's colour escape sequences, and `--log_level` still
selects the lowest level that reaches it.

The startup banner and the error line of a failed command stay on the terminal.
They are not log records, and a command that exits without telling you why is
not useful.

## Guarantees and limits

The command creates the folder and the file before it prints the two paths, so
`tail -F` has something to attach to right away. A second run writes a new
timestamped file and repoints `agent.latest.log` at it.

The folder is created `0700` and the file `0600`, so only your account can read
them. A folder that already exists keeps the permissions it has.

The folder path is predictable, unlike the random directory `mkdtemp` gives
you. A stable path is the point: `tail -F /tmp/agents_log/agent.latest.log` has
to work without you reading the file name first. That predictability is also
the weakness, so treat the following as a guard and not as a sandbox. Creating
the file passes `O_NOFOLLOW`, which refuses a symlink at the last path segment.
The log stream then reopens the same path without that flag, so a race remains,
and neither check covers a symlink earlier in the path. Once your account owns
the `0700` folder, no other local user can reach inside it. On a shared machine
another local user may already own `<temp>/agents_log`, and then these
protections do not apply.

When the folder or the file cannot be opened at all, the command says so and
keeps logging to the terminal. It does not stop.

The symlink is best effort. If a real file already sits at `agent.latest.log`,
the command warns and keeps running, and the printed hint names the timestamped
file instead. Windows without developer mode refuses symlinks, and the same
fallback applies.

An agent file that the loader compiles carries its own copy of `@google/adk`,
with its own logger. Records from that copy still reach the terminal. Records
from the ADK packages the command itself loaded go to the file.

Agent logs can hold model prompts and responses. Treat the file as you would
the conversation, and do not attach it to a public bug report unread.
