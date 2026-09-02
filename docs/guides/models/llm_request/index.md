# LlmRequest

`LlmRequest` is the assembled model call: the contents, the generation config,
the tool declarations and the tools that back them. Reach for this guide when
you inspect or mutate a request from a `beforeModelCallback`, a plugin or a
request processor.

## Introduction

An agent does not call the model directly. Each turn, ADK builds one
`LlmRequest` and passes it through the request processors, then through every
`beforeModelCallback`, and only then to the model. That single object is the
one place where instructions, contents, tools and generation config meet, so it
is where you change what the model actually sees.

`LlmRequest` is a structural interface, not a class. You build one with an
object literal and you read its fields directly. Three fields carry state that
is easy to get wrong:

- `config.tools` is a list of tool entries. The Gemini API accepts at most one
  entry that carries `functionDeclarations`, so ADK merges every declared tool
  into that one entry. Built-in tool entries such as `{googleSearch: {}}` sit
  beside it and are never merged into.
- `config.responseSchema` and `config.responseMimeType` control structured
  output. ADK sets both together; setting only the schema leaves the model free
  to answer in prose.
- `isManagedAgent` marks a request that a managed agent built. Such a request
  resolves its built-in tools server-side and therefore carries no model name.
  Built-in tools read the flag to decide whether they can enable themselves.

## Get started

A `beforeModelCallback` receives the request and can mutate it. This one reads
the declared tools and forces structured output for a single turn.

```ts
import {LlmAgent, LlmRequest} from '@google/adk';
import {Type} from '@google/genai';

function describeRequest(request: LlmRequest): string {
  const declared = (request.config?.tools ?? []).flatMap(
    (tool) =>
      ('functionDeclarations' in tool && tool.functionDeclarations) || [],
  );
  return declared.map((declaration) => declaration.name).join(', ');
}

const agent = new LlmAgent({
  name: 'reporter',
  model: 'gemini-2.5-flash',
  beforeModelCallback: ({request}) => {
    request.config = request.config ?? {};
    request.config.responseSchema = {
      type: Type.OBJECT,
      properties: {answer: {type: Type.STRING}},
    };
    request.config.responseMimeType = 'application/json';
    return undefined;
  },
});
```

`describeRequest` shows the shape you must expect from `config.tools`: an entry
may carry an empty or absent `functionDeclarations`, so a reader has to skip
those rather than assume the key implies a declaration.

## Structured output

Set `responseSchema` and `responseMimeType` together. An agent that declares
`outputSchema` gets both set for it, so you only do this by hand when you
override the schema for one turn.

ADK treats the pair as one setting: the request processor that reads
`LlmAgent.outputSchema` always writes both. It also skips them for a task-mode
agent, because that agent finishes through the `finish_task` tool and function
calling is incompatible with a JSON response mime type.

## Managed-agent requests

A managed agent runs its built-in tools on the server, so its request has no
`model`. A built-in tool that gates itself on the model name must also accept
`isManagedAgent`:

```ts
import {LlmRequest} from '@google/adk';

function isServerResolved(request: LlmRequest): boolean {
  return !request.model && request.isManagedAgent === true;
}
```

The field is absent on an ordinary request, which reads as falsy. Nothing in
ADK sets it today except a managed agent, so treat it as internal request
state rather than a knob to turn on.
