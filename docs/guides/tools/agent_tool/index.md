# AgentTool

`AgentTool` wraps an agent so another agent can call it as a tool. Reach for it
when one agent needs a second agent's answer inside its own turn, rather than
handing the conversation over to it.

## Introduction

A sub-agent and an `AgentTool` both give one agent access to another, but they
differ in who keeps control. Transferring to a sub-agent moves the conversation:
the sub-agent answers the user directly and the parent stops. An `AgentTool`
keeps the parent in charge. The wrapped agent runs to completion in a nested
run, and only its final answer comes back, as the result of one function call
the parent's model made.

That nested run is a full run, driven by its own `Runner`. Three things follow
from it, and they are what this guide is about. The nested run inherits the
caller's `RunConfig`, so limits the caller set still apply. Its arguments are
validated at the tool boundary when the wrapped agent declares an input schema.
And the runner it uses is released when the run ends, so a toolset the wrapped
agent holds does not stay open.

`AgentTool` is exported from `@google/adk`.

## Get started

The parent agent below has one tool: a summarizing agent. The parent's model
decides when to call it.

```ts
import {AgentTool, InMemorySessionService, LlmAgent, Runner} from '@google/adk';

const summarizer = new LlmAgent({
  name: 'summarizer',
  model: 'gemini-2.5-flash',
  description: 'Summarizes a block of text in two sentences.',
  instruction: 'Summarize the text you are given in two sentences.',
});

const assistant = new LlmAgent({
  name: 'assistant',
  model: 'gemini-2.5-flash',
  instruction: 'Use the summarizer tool when the user asks for a summary.',
  tools: [new AgentTool({agent: summarizer})],
});

const runner = new Runner({
  appName: 'guide',
  agent: assistant,
  sessionService: new InMemorySessionService(),
});

const session = await runner.sessionService.createSession({
  appName: 'guide',
  userId: 'ada',
});

for await (const event of runner.runAsync({
  userId: session.userId,
  sessionId: session.id,
  newMessage: {role: 'user', parts: [{text: 'Summarize the release notes.'}]},
  runConfig: {maxLlmCalls: 8},
})) {
  if (event.content?.parts?.[0]?.text) {
    process.stdout.write(event.content.parts[0].text);
  }
}
```

The tool's name and description come from the wrapped agent, so give the agent
a description that tells the parent's model when to call it.

## Arguments

A wrapped agent with no input schema is declared with one string parameter,
`request`. Its value becomes the message the wrapped agent receives, verbatim —
including an empty string.

A model does not always respect that declaration. When the arguments carry no
string `request`, `AgentTool` sends them as JSON with the keys sorted at every
depth. Two calls with the same arguments therefore produce the same message,
whatever order the model emitted the keys in:

```
{product: 'running shoes', brand: 'Nike'}
  -> {"brand":"Nike","product":"running shoes"}
```

Give the wrapped agent an `inputSchema` when it needs structured arguments:

```ts
import {AgentTool, LlmAgent} from '@google/adk';
import {z} from 'zod';

const search = new LlmAgent({
  name: 'catalogue_search',
  model: 'gemini-2.5-flash',
  description: 'Searches the product catalogue.',
  inputSchema: z.object({query: z.string(), limit: z.number()}),
});

const searchTool = new AgentTool({agent: search});
```

The schema then does two jobs. It becomes the tool declaration's parameters, so
the model is told what to send. And `AgentTool` validates the arguments against
it before the nested run starts. Arguments that violate the schema throw out of
the tool call, which the agent loop reports back to the model as a tool error,
so the model can correct the call. Nothing reaches the wrapped agent.

Validation uses the schema in the form you supplied it. A Zod refinement is
enforced even though the genai schema sent to the model cannot express it.

The validated arguments reach the wrapped agent as a bare JSON document, with
no prose around it, because the wrapped agent parses that text against the same
schema.

## The nested run config

The nested run uses the caller's `RunConfig`, so a `maxLlmCalls` ceiling, HTTP
options, or metadata the caller set also apply to the wrapped agent. The call
counter is per-invocation, so the ceiling bounds the nested run rather than
being shared with the caller's.

Two settings are overridden, and your own `RunConfig` object is never modified:

- `supportCfc` is forced off. Compositional function calling describes how the
  caller's own model executes. Passing it on switches the wrapped agent to the
  live API path, which only works if its model supports it.
- `streamingMode` is forced to `StreamingMode.NONE`. Only the last nested
  event's content becomes the tool result, so a streamed nested run could leave
  a partial chunk as the answer.

A caller with no `RunConfig` produces a nested run with no `RunConfig`; the
runner applies its own defaults.

## Releasing the sub-runner

`AgentTool` awaits `Runner.close()` when the nested run ends — after a normal
run, after an abort, and after the wrapped agent throws. `Runner.close()`
releases the toolsets held by its agent and their sub-agents, so an MCP session
the wrapped agent opened does not outlive the tool call.

It closes nothing else. The session service and the plugins belong to the
caller, which is still using them.

`Runner.close()` is public, so you can call it on a runner of your own. It is
safe to call more than once: a runner is reusable across runs, and each call
closes the toolsets again.
