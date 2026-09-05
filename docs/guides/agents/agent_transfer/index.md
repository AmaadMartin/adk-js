# Agent Transfer

Agent transfer lets a model hand a conversation to another agent. ADK adds a
`transfer_to_agent` tool to the request and tells the model which agents it may
name. Reach for it when one coordinator agent fronts several specialists.

---

## Introduction

`AgentTransferLlmRequestProcessor` runs before every model call on an
`LlmAgent`. It collects the transfer targets, appends instructions describing
each one, and registers the `transfer_to_agent` tool. The model transfers by
calling that tool with a target name.

The targets come from the agent tree:

1. The agent's own sub-agents.
2. Its parent agent, unless `disallowTransferToParent` is set.
3. Its peer agents, unless `disallowTransferToPeers` is set.

Two kinds of agent are not offered. A sub-agent or peer whose `mode` is
`'task'` or `'single_turn'` is a workflow node: the graph drives it, and its
parent reaches it as a tool instead. The parent agent is never filtered this
way, so an agent inside a task-mode parent can still return control upwards.

Transfer is function calling, so it does not combine with the Gemini built-in
search tools. See [Built-in search tools](#built-in-search-tools) below.

---

## Get started

Give a coordinator two sub-agents and the model can transfer to either one.

```ts
import {InMemoryRunner, LlmAgent} from '@google/adk';

const billing = new LlmAgent({
  name: 'billing_agent',
  model: 'gemini-2.5-flash',
  description: 'Answers questions about invoices and payments.',
});

const shipping = new LlmAgent({
  name: 'shipping_agent',
  model: 'gemini-2.5-flash',
  description: 'Answers questions about delivery and tracking.',
});

const coordinator = new LlmAgent({
  name: 'coordinator',
  model: 'gemini-2.5-flash',
  instruction: 'Route the customer to the right specialist.',
  subAgents: [billing, shipping],
});

const runner = new InMemoryRunner({agent: coordinator});
```

The coordinator's system instruction now ends with the list of names the model
may pass to `transfer_to_agent`:

```text
**NOTE**: the only available agents for `transfer_to_agent` function are
`billing_agent`, `shipping_agent`.
```

The names in that clause are sorted. The description blocks above it stay in
declaration order.

---

## Excluding an agent from transfer

Set `mode` on a sub-agent to keep it out of the transfer list.

```ts
const summarizer = new LlmAgent({
  name: 'summarizer',
  model: 'gemini-2.5-flash',
  description: 'Summarizes a document.',
  mode: 'task',
});

const coordinator = new LlmAgent({
  name: 'coordinator',
  model: 'gemini-2.5-flash',
  subAgents: [summarizer, billing],
});
```

The coordinator's NOTE clause names `billing_agent` only. If every sub-agent is
excluded and the agent has no parent, ADK appends no instructions and registers
no tool.

A `task` or `single_turn` agent gets no transfer instructions of its own
either, because the graph decides where it hands control next. The
`transfer_to_agent` tool stays registered on its request.

---

## Built-in search tools

The Gemini API rejects a request that combines a built-in search tool with
function declarations. Agent transfer adds a function declaration, so the two
cannot coexist. ADK reports this before the call instead of letting the API
reject it:

```ts
import {GoogleSearchTool, LlmAgent} from '@google/adk';

const coordinator = new LlmAgent({
  name: 'coordinator',
  model: 'gemini-2.5-flash',
  tools: [new GoogleSearchTool()],
  subAgents: [billing],
});
```

Running this agent throws:

```text
Agent 'coordinator' has sub-agent transfer targets but is configured with
GoogleSearchTool without bypassMultiToolsLimit: true. Gemini API does not allow
built-in search tools to be combined with function calling (agent delegation).
To enable both search and sub-agent delegation, set bypassMultiToolsLimit: true
on GoogleSearchTool or VertexAiSearchTool.
```

`GoogleSearchTool` and `VertexAiSearchTool` accept `bypassMultiToolsLimit` for
model endpoints that do support the combination:

```ts
const coordinator = new LlmAgent({
  name: 'coordinator',
  model: 'gemini-2.5-flash',
  tools: [new GoogleSearchTool({bypassMultiToolsLimit: true})],
  subAgents: [billing],
});
```

`EnterpriseWebSearchTool` has no such option and always throws.

Three details bound this check:

- It throws only when at least one target is a sub-agent. When the agent can
  reach only its parent and its peers, ADK skips the instructions and the tool
  and returns quietly, so the search tool keeps working.
- An agent with no transfer targets at all is never affected.
- The check reads the agent's `tools` list directly. A tool that a
  `BaseToolset` supplies is not inspected.
