# Temp folder logging

`--log_to_tmp` sends the ADK log records to `<temp>/agents_log/` instead of the
terminal, one `agent.<timestamp>.log` per run with an `agent.latest.log`
symlink beside it. `adk run`, `adk web` and `adk api_server` all take the flag,
so you can tail the log in a second shell while the first one stays readable.

```console
$ adk api_server --log_to_tmp ./agents
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
them. A folder that already exists keeps the permissions it has. Creating the
file also refuses to follow a symlink at the last path segment, so another
local user cannot point the name at a file of yours and have the command
truncate it.

The folder path is predictable, unlike the random directory `mkdtemp` gives
you. A stable path is the point: `tail -F /tmp/agents_log/agent.latest.log` has
to work without you reading the file name first. On a shared machine another
local user may already own `<temp>/agents_log`.

The symlink is best effort. If a real file already sits at `agent.latest.log`,
the command warns and keeps running, and the printed hint names the timestamped
file instead. Windows without developer mode refuses symlinks, and the same
fallback applies.

An agent file that the loader compiles carries its own copy of `@google/adk`,
with its own logger. Records from that copy still reach the terminal. Records
from the ADK packages the command itself loaded go to the file.

Agent logs can hold model prompts and responses. Treat the file as you would
the conversation, and do not attach it to a public bug report unread.
