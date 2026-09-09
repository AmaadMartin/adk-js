# Validated CLI options

The `adk` command checks `--log_level`, `--type` and the pair
`--replay`/`--resume` before a command starts, and refuses an invocation it
cannot honour. Read this page when a command rejects your arguments, or when
you add an option to the CLI and want it to reject bad input the same way.

## Introduction

The CLI used to accept any `--log_level` string and fall back to `INFO`, so a
typo cost a debugging session. It also accepted `--replay` and `--resume`
together and used only one of them. In both cases the CLI knew the input was
wrong and said nothing.

Every option that takes a fixed set of values is now a closed list, matched
without regard to case. Two options that cannot both apply are refused instead
of silently ranked. The behaviour matches adk-python, so the same command line
means the same thing whichever SDK you installed.

## Get started

Ask for more logging, and see a typo reported:

```bash
adk web ./agents --log_level DEBUG

adk web ./agents --log_level verbose
# error: option '--log_level <string>' argument 'verbose' is invalid.
# Allowed choices are DEBUG, INFO, WARNING, WARN, ERROR, CRITICAL.
```

Every command that advertises `--log_level` also lists its values in
`--help`, so you never have to guess:

```bash
adk run --help
#   --log_level <string>  Optional. The log level of the server
#                         (choices: "DEBUG", "INFO", "WARNING", "WARN",
#                         "ERROR", "CRITICAL", default: "INFO")
```

## Log levels

`--log_level` accepts `DEBUG`, `INFO`, `WARNING`, `WARN`, `ERROR` and
`CRITICAL`, in any case. `WARNING` and `CRITICAL` come from adk-python.
`WARN` is kept because the adk-js CLI accepted it before the list closed.

| `--log_level`       | Resulting level |
| ------------------- | --------------- |
| `DEBUG`             | `DEBUG`         |
| `INFO`              | `INFO`          |
| `WARNING`, `WARN`   | `WARN`          |
| `ERROR`, `CRITICAL` | `ERROR`         |

`--verbose` is a shorthand for `--log_level DEBUG`. It raises a `--log_level`
you left at its default, and yields to one you gave on the command line:

```bash
adk web ./agents --verbose                      # DEBUG
adk web ./agents --verbose --log_level ERROR    # ERROR
adk web ./agents --log_level CRITICAL           # ERROR
```

## Seeding a run

`adk run` seeds a session from a recorded run with `--replay`, or from a saved
session with `--resume`. The two cannot both apply, so setting both is refused
and no agent starts:

```bash
adk run ./my_agent --replay queries.json --resume session.json
# error: Options 'resume' and 'replay' cannot be set together.
```

## Agent type on create

`adk create` takes `--type CODE` or `--type CONFIG`, in any case, and defaults
to `CODE`. `CONFIG` is accepted but not implemented: the command says so and
writes the code template. adk-js has no loader for a declarative agent config,
so a generated config file would not run.

```bash
adk create my-agent --type config
# Agent type 'CONFIG' is not ready for use, so 'CODE' is used instead.
```

## Exit codes

| Situation                              | Exit code |
| -------------------------------------- | --------- |
| `--replay` and `--resume` set together | 2         |
| A value outside a closed choice list   | 1         |

Two options set together exits 2, the code click uses for a usage error and
adk-python inherits. A rejected choice value exits 1, which is commander's own
code for a bad argument.
