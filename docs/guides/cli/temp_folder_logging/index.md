# Temp folder logging

The ADK command line interface can send its log records to a file in the system
temp folder instead of the terminal. Reach for it when the log lines get in the
way of what the command prints, or when you want to keep a run's records after
the terminal scrolls.

## Introduction

The ADK packages log through one process-wide logger. By default that logger
writes to the console, which suits a server you are watching. It suits two
other cases badly.

`adk run` paints a chat transcript on stdout. A log line lands in the middle of
a model response and the transcript stops being readable. `adk web` and
`adk api_server` print a startup banner and then stream request logs over it,
and the records are gone once the terminal scrolls.

Temp folder logging moves the records to `<temp>/agents_log/`. One file per
run, named `agent.<timestamp>.log`, plus an `agent.latest.log` symlink that
always points at the newest one. You tail the symlink in a second shell and the
first shell stays readable. This mirrors `log_to_tmp_folder` in adk-python.

`adk run` always logs this way. `adk web` and `adk api_server` do it only when
you pass `--log_to_tmp`, because a server's log lines on the terminal are
useful by default.

## Get started

```console
$ adk api_server --log_to_tmp ./agents
Log setup complete: /tmp/agents_log/agent.20260829_000610.log
To access latest log: tail -F /tmp/agents_log/agent.latest.log
```

Then, in a second shell:

```console
$ tail -F /tmp/agents_log/agent.latest.log
2026-08-29 00:06:19,794 - INFO - ADK API Server - GET /list-apps
```

The same flag works on `adk web`. `adk run` needs no flag.

## What lands in the file

Each line is `<timestamp> - <LEVEL> - <label> - <message>`. The label names the
component that logged, such as `ADK API Server` or `AgentLoader`. The file
never receives the terminal's colour escape sequences.

`--log_level` still selects the lowest level that reaches the file:

```console
$ adk api_server --log_to_tmp --log_level debug ./agents
```

The startup banner and the error line of a failed command stay on the terminal.
They are not log records, and a command that exits without telling you why is
not useful.

## Guarantees and limits

The command creates the folder and the file before it prints the two paths, so
`tail -F` has something to attach to right away. A second run writes a new
timestamped file and repoints `agent.latest.log` at it.

Three things are worth knowing before you rely on it.

The folder path is predictable, unlike the random directory `mkdtemp` gives
you. A stable path is the point: `tail -F /tmp/agents_log/agent.latest.log` has
to work without you reading the file name first. On a shared machine another
local user may already own `<temp>/agents_log`.

The symlink is best effort. If a real file already sits at
`agent.latest.log`, the command warns and keeps running, and the printed hint
names the timestamped file instead. Windows without developer mode refuses
symlinks, and the same fallback applies.

An agent file that the loader compiles carries its own copy of `@google/adk`,
with its own logger. Records from that copy still reach the terminal. Records
from the ADK packages the command itself loaded go to the file.

Agent logs can hold model prompts and responses. Treat the file as you would
the conversation, and do not attach it to a public bug report unread.
