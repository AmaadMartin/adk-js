# AgentTool

Wraps an agent so another agent can call it as a tool. Reach for it when one
agent needs a second agent's answer inside its own turn, rather than handing the
conversation over.

## Introduction

An `LlmAgent` can delegate in two ways. Agent transfer moves the conversation to
another agent, which then owns the turn. `AgentTool` does not: the caller stays
in control, calls the wrapped agent like any other tool, reads the reply, and
carries on.

That makes `AgentTool` the right choice for a specialist the caller consults —
a translator, a summariser, a calculator — and the wrong choice for a handover.
The wrapped agent runs in its own `Runner`, so it has its own instruction, its
own tools and its own model. The caller sees only the final text it produced.

The tool declaration the caller's model reads comes from the wrapped agent. The
agent's `name` becomes the tool name and its `description` becomes the tool
description, so a vague description is the usual reason a model never calls the
tool.

## Get started

```ts
import {AgentTool, InMemorySessionService, LlmAgent, Runner} from '@google/adk';

const translator = new LlmAgent({
  model: 'gemini-flash-latest',
  name: 'translator',
  description: 'Translates English text into French.',
  instruction: 'Translate the request into French. Reply with the translation.',
});

const assistant = new LlmAgent({
  model: 'gemini-flash-latest',
  name: 'assistant',
  description: 'Answers questions, and translates when asked.',
  instruction: 'Call the translator tool when the user asks for French.',
  tools: [new AgentTool({agent: translator})],
});

const sessionService = new InMemorySessionService();
await sessionService.createSession({
  appName: 'demo',
  userId: 'user',
  sessionId: 'session',
});

const runner = new Runner({appName: 'demo', agent: assistant, sessionService});

for await (const event of runner.runAsync({
  userId: 'user',
  sessionId: 'session',
  newMessage: {role: 'user', parts: [{text: 'How do I say hello in French?'}]},
})) {
  // Handle the assistant's events.
}
```

## The arguments the caller sends

`AgentTool` builds the wrapped agent's prompt from the tool arguments. Which
rule applies depends on whether an input schema resolves.

An input schema resolves from the wrapped agent itself when it is an `LlmAgent`.
For a composite agent, such as a `SequentialAgent`, it resolves from the first
sub-agent, recursively. The output schema resolves the same way from the **last**
sub-agent, because a composite agent reads its input at the first leg and
produces its output at the last.

With an input schema, the arguments are validated against it and then sent as a
bare JSON document. Properties whose value is `null` are dropped. Arguments that
break the schema make the tool call fail, and the wrapped agent never runs.

```ts
import {LlmAgent} from '@google/adk';
import {z} from 'zod';

const search = new LlmAgent({
  model: 'gemini-flash-latest',
  name: 'search',
  description: 'Searches the product catalogue.',
  inputSchema: z.object({query: z.string(), language: z.string().nullable()}),
});

// Called with {query: 'running shoes', language: null}, the agent receives
// the text {"query":"running shoes"}.
```

Without an input schema, the tool declares a single string parameter named
`request`. A string `request` argument is passed through unchanged, an empty one
included. Any other argument set is serialized with its keys sorted, so the same
arguments always produce the same prompt text.

## What the tool returns

The result is the text of the wrapped agent's last event. Thought parts are
never included. Every other part contributes its text, its code execution output
with trailing newlines removed, or the code it ran, in that order of preference.
The pieces are joined with a newline, so a code-executing agent returns its code
and its output rather than an empty string.

When an output schema resolves, the merged text is parsed as JSON and the parsed
object is returned instead of the string.

## State and sessions

The wrapped agent runs under its own app name, in a session that shares the
caller's session service and session id. Parent state seeds that session, except
for keys that ADK owns: `temp:` keys stay in the caller, and so do keys that
start with `_adk`.

State the wrapped agent writes flows back to the caller, again without its
`temp:` keys. The wrapped agent's own conversation stays in its own session.

## Options

| Option              | Default  | Effect                                                                                                                                                                                                               |
| ------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent`             | required | The agent to expose as a tool.                                                                                                                                                                                       |
| `skipSummarization` | `false`  | Accepted for parity with adk-python, and read by nothing today. adk-js already returns the wrapped agent's output verbatim, and setting the flag on the shared `EventActions` would end the caller's run loop early. |
