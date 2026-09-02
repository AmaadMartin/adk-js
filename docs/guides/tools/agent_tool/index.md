# AgentTool

`AgentTool` exposes one agent to another as a callable tool. The calling model
sees an ordinary function; behind it, ADK runs the wrapped agent to completion
and returns its final text as the tool result. Reach for it when a sub-agent
owns a self-contained job — a lookup, a translation, a report — and the caller
only wants the answer.

## Introduction

An `AgentTool` call is a nested run. ADK builds a second `Runner` around the
wrapped agent, runs it in its own invocation, and hands the caller only the
last event's content. The nested run does not stream its events to the caller,
and it does not share the caller's LLM-call counter.

That nesting is why the run configuration matters. The wrapped agent is part of
the caller's invocation, so it obeys the caller's `RunConfig` — with two
exceptions the caller keeps to itself:

- **`supportCfc`** describes how the caller's own model executes. Passing it on
  would replace the wrapped agent's code executor.
- **A streaming mode** would make the nested run emit partial events. Only the
  last event becomes the tool result, so ADK always runs the nested agent
  unary.

Everything else is forwarded untouched, `maxLlmCalls` included. Without a
caller `RunConfig`, the nested run falls back to `RunConfig`'s defaults: a
`maxLlmCalls` ceiling of 500 and no metadata.

Use `sub_agents` instead when you want the sub-agent to answer the user
directly and keep the conversation. `AgentTool` is for the case where the
caller stays in charge and consumes the answer.

## Get started

```ts
import {AgentTool, InMemorySessionService, LlmAgent, Runner} from '@google/adk';

const weatherAgent = new LlmAgent({
  model: 'gemini-2.5-flash',
  name: 'weather_agent',
  description: 'Answers questions about the weather.',
});

const assistant = new LlmAgent({
  model: 'gemini-2.5-flash',
  name: 'assistant',
  description: 'Answers general questions.',
  tools: [new AgentTool({agent: weatherAgent})],
});

const sessionService = new InMemorySessionService();
await sessionService.createSession({
  appName: 'demo',
  userId: 'user',
  sessionId: '1',
});

const runner = new Runner({appName: 'demo', agent: assistant, sessionService});
for await (const event of runner.runAsync({
  userId: 'user',
  sessionId: '1',
  newMessage: {role: 'user', parts: [{text: 'What is the weather in Tokyo?'}]},
})) {
  console.log(event.content?.parts?.[0]?.text);
}
```

## What the model sends, and what the agent receives

When the wrapped agent declares no `inputSchema`, the tool takes a single
`request` string, and that string becomes the prompt verbatim. An empty
`request` produces an empty prompt.

If the model calls the tool with other arguments instead, ADK serializes the
whole argument object to JSON with the keys sorted at every depth. Two calls
that differ only in key order therefore produce identical prompt text, which
keeps the nested run reproducible and cacheable.

When the wrapped agent does declare an `inputSchema`, that schema becomes the
tool's parameters and the arguments are passed through as JSON.

## Bounding the nested run

A ceiling set on the caller applies to the nested run as well, because the
caller's `RunConfig` is forwarded:

```ts
for await (const event of runner.runAsync({
  userId: 'user',
  sessionId: '1',
  newMessage: {role: 'user', parts: [{text: 'What is the weather in Tokyo?'}]},
  runConfig: {maxLlmCalls: 4},
})) {
  // The wrapped agent gets its own budget of 4 model calls, not 500.
}
```

The count is per-invocation, so the nested run starts at zero and the ceiling
bounds it rather than being shared with the caller's own calls. A run that
exceeds it ends with an error event carrying `Max number of llm calls limit of
4 exceeded`.

## Building one from a configuration file

`AgentTool.fromConfig` builds the tool from a declarative configuration, so a
config file can name the agent to wrap:

```ts
import {AgentTool} from '@google/adk';

const tool = await AgentTool.fromConfig(
  {agent: {code: './agents.js#weatherAgent'}, skipSummarization: true},
  '/abs/path/to/root_agent.yaml',
);
```

The reference must set exactly one field. `code` is a fully-qualified name of
the form `<module specifier>#<export>`; with no `#`, the whole string is the
module and the `default` export is read. A relative specifier resolves against
the directory of the config file you pass as the second argument.

Resolving a name imports the module, which runs its top-level code — trust the
name exactly as far as you trust the config file it came from. Node built-ins
are refused, so a config file cannot reach `node:child_process`.

`configPath` is rejected: adk-js has no agent config loader, so a config-file
agent reference cannot be resolved. Reference the agent in code instead.
