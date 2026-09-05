# CLI usage metrics

The `adk` CLI can record one line per invocation on your own disk: which command you ran, which flags you named, how long it took, and how it ended. Recording happens only after you opt in, and no argument value is ever written.

## Introduction

The ADK team needs to know which commands people use and which of them fail. A crash report tells you nothing about the commands that quietly took thirty seconds, and a survey reaches the wrong people. Per-command metrics answer both questions from data the CLI already has.

The privacy contract is what makes this safe to run, so it is narrow and enforced in code:

- **Opt-in only.** Without an explicit `true` in your config, the CLI creates no file and registers no listener.
- **Names, never values.** An option contributes its flag (`--model`), and a positional argument contributes its declared name in angle brackets (`<agents_dir>`). Neither the model name, nor the agent path, nor an API key can reach the record.
- **Local only.** adk-js appends to a queue file and stops there. Nothing in this package sends the queue anywhere.
- **Bounded.** The queue stops growing at 1 MB, one record carries at most 50 flags, and session files are pruned after an hour.

The file layout matches adk-python, so a machine with both SDKs installed shares one queue file and one session file.

## Get started

Opt in by writing `~/.adk/config.json`:

```bash
mkdir -p ~/.adk
echo '{"telemetry": true}' > ~/.adk/config.json
```

Run any command, then read the queue:

```bash
adk deploy cloud_run ./my_agent --project my-project --region us-central1 --service_name demo
cat ~/.adk/telemetry_queue.jsonl
```

One line is appended per invocation:

```json
{
  "event_time_ms": 1788445879752,
  "source_extension_json": "{\"client_session_id\":\"c29ede53-3c0a-4b05-8c03-95533586be7b\",\"sequence_number\":1,\"environment\":{\"os_type\":\"linux\",\"language\":\"javascript\",\"language_version\":\"22.22.2\",\"adk_version\":\"2.0.0\",\"is_tty\":false},\"command_run\":{\"command\":\"deploy\",\"subcommand\":\"cloud_run\",\"exit_code\":0,\"duration_ms\":51,\"flags\":[\"--project\",\"--region\",\"--service_name\",\"<agents_dir>\"]}}"
}
```

Set `telemetry` to `false`, or delete the file, to stop recording. Delete `~/.adk/telemetry_queue.jsonl` and `~/.adk/telemetry_sessions/` to discard what was already recorded.

## What one record holds

`source_extension_json` is a string holding compact JSON with four keys.

| Key                 | Meaning                                                                                           |
| ------------------- | ------------------------------------------------------------------------------------------------- |
| `client_session_id` | Groups the commands run from one terminal.                                                        |
| `sequence_number`   | Position within that session, starting at 1.                                                      |
| `environment`       | `os_type`, `language`, `language_version`, `adk_version`, `is_tty`.                               |
| `command_run`       | `command`, `subcommand`, `exit_code`, `duration_ms`, and optionally `flags` and `exception_type`. |

A session is keyed by the terminal's parent process id. It ends after an hour of quiet: the next command gets a new `client_session_id` and restarts at 1.

## What is never recorded

`adk --help` and `adk <command> --help` append nothing, and neither does any `adk telemetry` invocation. `-h` is not treated as a help request, because the server commands bind it to `--host`.

A run you end with Ctrl-C is not recorded either. Node terminates on SIGINT without running exit handlers, and adk-js does not install a SIGINT handler, because that would change how the dev server and the interactive prompt shut down.

## Failure modes

Telemetry never changes what the CLI does. A read-only home directory, a corrupt session file, or a full disk is caught and logged at debug level; the command still runs and still exits with the code it would have had. A queue file already past 1 MB is left alone rather than truncated, so nothing already recorded is lost.
