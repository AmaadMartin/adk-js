# LlmAgent single-turn and task modes

An `LlmAgent` sub-agent that declares a `mode` is offered to the parent model as
a callable tool. The parent calls it like a function, the sub-agent runs once
inside the parent's own invocation, and its output becomes the tool result.
Reach for a mode when you want a specialist the parent _uses_, rather than a
peer the parent hands the conversation to.

## Introduction

A sub-agent with no `mode` is a conversational agent. The parent can transfer
the conversation to it with `transfer_to_agent`, and from then on that agent
answers the user directly. This is the right shape for a router.

A sub-agent with `mode: 'single_turn'` or `mode: 'task'` is a specialist. The
parent stays in control of the conversation. It calls the specialist, reads the
result, and continues. `LlmAgent` builds the tool for you at construction time,
so `subAgents` is the only thing you configure.

A specialist is offered one way only. It is not a `transfer_to_agent` target,
for itself or for its peers, because the parent already reaches it as a tool and
it runs for one node execution rather than for a conversation.

The two modes differ in how the specialist decides it is done:

- `single_turn` finishes after one model turn. Its reply is the tool result.
- `task` loops (model, then tools) until it calls `finish_task`. The arguments
  of that call are the tool result.

Both run **inline**: the specialist shares the parent's session and its events
reach the parent's event stream. This is the opposite of wrapping an agent in
`AgentTool`, which starts a nested runner with a session of its own.

## Get started

```ts
import {InMemoryRunner, LlmAgent} from '@google/adk';

const translator = new LlmAgent({
  name: 'translator',
  model: 'gemini-2.5-flash',
  description: 'Translates the input text to Spanish.',
  instruction: 'Translate the input text to Spanish.',
  mode: 'single_turn',
});

const writer = new LlmAgent({
  name: 'writer',
  model: 'gemini-2.5-flash',
  instruction: 'Write a short line, then use the translator tool on it.',
  subAgents: [translator],
});

const runner = new InMemoryRunner({agent: writer, appName: 'demo'});
```

`writer.tools` now holds one tool named `translator`. Nothing else is needed:
you do not build an `AgentTool`, and you do not add the sub-agent to `tools`
yourself.

## Passing arguments

The tool's parameters come from the sub-agent's `inputSchema`:

```ts
import {z} from 'zod/v3';

const coder = new LlmAgent({
  name: 'coder',
  model: 'gemini-2.5-flash',
  description: 'Applies a small change to one file.',
  mode: 'single_turn',
  inputSchema: z.object({file: z.string(), change: z.string()}),
});
```

The model then calls `coder` with `file` and `change`. ADK validates the
arguments against the schema before the sub-agent runs, and the sub-agent
receives the parsed value.

A sub-agent with no `inputSchema` gets a single `request` string parameter, and
that string is its input.

## What the sub-agent sees

The sub-agent runs on a branch of its own, named
`<parentBranch>.<agentName>@<functionCallId>`. Its events carry that branch, so
you can tell its turn apart from the parent's in the session.

History is hidden by default. A `single_turn` sub-agent reads only the tool-call
arguments, because ADK sets `includeContents` to `'none'` for it. Set
`includeContents: 'default'` on the sub-agent when it needs the surrounding
conversation.

## Failure and nesting

A sub-agent that throws does not end the parent's turn. The tool result is the
text `Error running sub-agent: <message>`, and arguments the schema rejects give
`Error validating input: <message>`. The parent model reads the message and can
try something else.

Delegation nests up to 8 levels. Past that the call fails with a nesting error,
reported to the model as text like any other failure. The limit exists because a
specialist can itself have specialists, and a cycle would otherwise spend
without bound.

## Task mode

`mode: 'task'` uses the same inline execution and adds a `finish_task` tool to
the specialist. The specialist may take several model turns. The task output is
what it passes to `finish_task`, whose parameters mirror the specialist's
`outputSchema`.

```ts
const researcher = new LlmAgent({
  name: 'researcher',
  model: 'gemini-2.5-flash',
  description: 'Researches a topic and reports one finding.',
  mode: 'task',
  outputSchema: z.object({finding: z.string()}),
});
```

The tool description ends with a warning that tells the model not to call the
tool in parallel with any other tool.
