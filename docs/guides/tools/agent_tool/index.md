# AgentTool

`AgentTool` exposes one agent to another as a callable tool. The caller's model
sees a function declaration built from the wrapped agent, calls it with
arguments, and gets the wrapped agent's answer back as the tool result. Reach
for it when a specialist agent should answer one question and hand control
straight back.

## Introduction

ADK gives a parent agent two ways to involve another agent. Agent transfer hands
the conversation over, and the sub-agent keeps answering the user. `AgentTool`
does not: the wrapped agent runs once, in a nested run, and the parent stays in
charge of the conversation.

The nested run is a full run of the wrapped agent, driven by its own `Runner`.
That raises three questions this guide answers: what run settings the nested run
uses, what happens to the resources it holds, and what the caller's model is
allowed to pass in.

## Get started

```ts
import {AgentTool, LlmAgent} from '@google/adk';

const translator = new LlmAgent({
  name: 'translator',
  model: 'gemini-2.5-flash',
  description: 'Translates a sentence into French.',
  instruction: 'Answer with the French translation only.',
});

const assistant = new LlmAgent({
  name: 'assistant',
  model: 'gemini-2.5-flash',
  description: 'Answers user questions.',
  instruction: 'Use the translator tool whenever the user asks for French.',
  tools: [new AgentTool({agent: translator})],
});
```

The tool's name is the wrapped agent's name and its description is the wrapped
agent's description, so give the wrapped agent a clear `description`. It is the
only thing the caller's model reads when it decides whether to call the tool.

## Run settings of the nested run

The nested run inherits the caller's `RunConfig`, because the wrapped agent runs
as part of the caller's invocation. A caller that limits itself to 20 model
calls limits the wrapped agent to 20 as well:

```ts
for await (const event of runner.runAsync({
  userId,
  sessionId,
  newMessage,
  runConfig: {maxLlmCalls: 20},
})) {
  // The nested run stops after 20 model calls too.
}
```

The count is per invocation, so the nested run gets its own budget of 20 rather
than sharing the caller's. Two settings do not carry over:

- `supportCfc` is forced off. Compositional function calling describes how the
  caller's own model executes. Applying it to another agent replaces that
  agent's code executor, and refuses to run it unless its model is a Gemini 2
  one.
- `streamingMode` is forced to `NONE`. Only the last event of the nested run
  becomes the tool result, so a streamed nested run would leave a partial chunk
  as the answer.

The caller's `RunConfig` object is never modified; both overrides are made on a
copy.

## Arguments and the input schema

By default the declaration takes a single `request` string. Give the wrapped
agent an `inputSchema` and the declaration takes that schema's fields instead:

```ts
import {z} from 'zod';

const reporter = new LlmAgent({
  name: 'reporter',
  model: 'gemini-2.5-flash',
  description: 'Reports the weather in a city.',
  inputSchema: z.object({city: z.string()}),
});
```

The arguments are validated against that schema before the nested run starts,
and the validated value is passed to the wrapped agent as a bare JSON document.
Arguments the model got wrong are rejected at the tool boundary, so the failure
names the offending field instead of surfacing as a parse error inside the
wrapped agent.

## Resources

`AgentTool` builds a `Runner` for the nested run and closes it when the run
ends, on the error path and the aborted path as well as the normal one. Closing
a runner closes the toolsets its agent declares, which is what releases a
long-lived connection such as an MCP session.

`Runner.close()` is public, so an application that builds a runner for one run
can do the same:

```ts
const runner = new Runner({appName, agent, sessionService});
try {
  for await (const event of runner.runAsync({userId, sessionId, newMessage})) {
    // ...
  }
} finally {
  await runner.close();
}
```
