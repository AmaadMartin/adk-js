# Answering a pause in `adk run`

An agent that raises a long-running function call is waiting for a person.
`adk run` prompts for each waiting call as soon as the turn ends, and sends the
typed answers back as function responses, so the agent continues in the same
conversation.

## Introduction

A human-in-the-loop tool pauses the run: it emits a function call, marks the
call id on the event's `longRunningToolIds`, and stops. Nothing resumes until
the caller delivers a `functionResponse` carrying that id.

Before this, the interactive CLI printed the pause and then asked for the next
`[user]:` line, which it sent as a plain-text message. The paused call was never
answered, so the agent could not make progress. `adk run` now recognises the
pause and asks for the answer it actually needs.

Two calls raised in one turn are prompted in the order they were raised, and
both answers travel in a single message. The run resumes from one message, so
sending them one at a time would resume with the first answer and lose the rest.

## Get started

Nothing to configure. Run an agent whose tool pauses, and answer at the prompt:

```
$ adk run ./agent.ts
Running agent ask_twice, type exit to exit.
[user]: start
--- [ask_twice] is waiting for your input ---
City?
Expected response: {"type":"string"}
Type your reply at the next prompt to continue.
[user]: Paris
--- [ask_twice] is waiting for confirmation ---
Tool: send_order
Send the order?
Reply 'yes' to approve or 'no' to reject.
[user]: yes
[ask_twice]: answers: ask-1={"result":"Paris"} ask-2={"confirmed":true}
```

## The prompts

A pause is described by `getUserInputRequests`, the same reader the rest of ADK
uses, so all three kinds read alike: an input request, a credential request, and
a tool confirmation. Each one prints its message, and any payload, schema or
auth scheme it carries, immediately before the `[user]:` prompt that answers it.

A long-running call that is not one of those three has nothing to describe, so
it is reported with its arguments:

```
[HITL] Waiting for input for slow_lookup({"city":"SF"})
```

## The answers

A confirmation answers `{confirmed: true}` for `y`, `yes`, `true` or `confirm`,
in any case and ignoring surrounding spaces. Anything else answers
`{confirmed: false}`.

Every other call reads the line as JSON. A JSON object is the response itself,
so one line can answer a structured request. A JSON value that is not an object,
and a line that is not JSON at all, travel under `result`:

| You type       | The agent receives       |
| -------------- | ------------------------ |
| `{"count": 3}` | `{count: 3}`             |
| `42`           | `{result: 42}`           |
| `twenty one`   | `{result: 'twenty one'}` |

## Limits

- Only the interactive run prompts. A scripted run (`--replay`) has no prompt to
  answer at, so the answer has to be the next query in the input file. That run
  reports `The run ended while still waiting for user input.` when it finishes
  with a pause open.
- A call with no id or no name is skipped. A function response is addressed by
  both, so neither can be answered.
- A turn that throws raises no prompt. The failure is reported and the session
  stays open for the next `[user]:` line.
