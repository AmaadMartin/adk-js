# CLI usage metrics

When you have opted in to telemetry, the `adk` command records one line per
invocation in a local queue file. Read this page to see what is recorded, what
is not, and how to turn it off.

## Introduction

`adk telemetry enable` stores your consent, but on its own it changes nothing:
nothing was reading that consent. This is the reader. Each invocation appends
one record naming the command you ran, how it ended and how long it took.

The record holds no user input. There is no agent path, no prompt, no flag
value, and no project id — only the command name, the subcommand name, the exit
code, the duration, and the name of the error class if the run crashed.

The file is `~/.adk/telemetry_queue.jsonl`, the same path adk-python uses, so a
machine with both SDKs installed keeps one queue. adk-js does not upload it.
The uploader lives in adk-python's telemetry module, which adk-js has not
ported, so on a JavaScript-only machine the queue is a local file that nothing
sends anywhere.

## Get started

Opt in, run a command, and read the queue:

```bash
adk telemetry enable
adk run ./my_agent

cat ~/.adk/telemetry_queue.jsonl
# {"event_time_ms":1788342833407,
#  "source_extension_json":
#    "{\"command_run\":{\"command\":\"run\",\"subcommand\":\"\",
#      \"exit_code\":1,\"duration_ms\":10}}"}
```

Turn it off, and nothing further is written:

```bash
adk telemetry disable
adk telemetry status
# Telemetry collection is disabled.
```

## What is recorded

| Field            | Meaning                                                          |
| ---------------- | ---------------------------------------------------------------- |
| `command`        | The top-level command, such as `run` or `deploy`.                |
| `subcommand`     | The subcommand, such as `cloud_run`, or `""` when there is none. |
| `exit_code`      | The process exit code.                                           |
| `duration_ms`    | Milliseconds from start-up to exit.                              |
| `exception_type` | The name of the error that ended the run. Absent on a clean run. |

adk-python's record also carries a client session id, a sequence number and an
environment fingerprint. Those come from its telemetry module, which adk-js has
not ported, so adk-js omits them.

## When nothing is recorded

- You have not opted in. No consent means no listener is registered and the
  queue file is never created.
- You opted out.
- You asked for help with `--help`. Note that `-h` does not count, because the
  adk-js subcommands bind `-h` to `--host`.
- You ran the `telemetry` group itself.
- The queue already holds more than 1 MB. It is then left alone until a
  reporter drains it.

A failure to write is swallowed. Telemetry must never break the command you
actually asked for, so an unwritable home directory costs you a record and
nothing else.
