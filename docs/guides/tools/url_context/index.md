# UrlContextTool

`UrlContextTool` lets a Gemini model fetch the URLs a user mentions and answer
from their content. Reach for it when the conversation carries links that the
model must read before it can reply.

## Introduction

`UrlContextTool` is a built-in tool. A built-in tool has no function
declaration and no local implementation: the model fetches the URL inside its
own serving stack. Your process never sees a function call for it, and it never
opens a network connection on your behalf. That is the difference from
`FunctionTool`, where the model asks ADK to run your code and waits for the
result.

Because the model runs the tool, the tool must know that the model supports it.
`processLlmRequest` appends `{urlContext: {}}` to `llmRequest.config.tools`, and
creates `config` and `config.tools` first if the request lacks them. For a model
that does not support the tool it throws instead, rather than sending a request
the model rejects.

Two conditions open that gate:

- The request names a Gemini model. Any id that resolves to `gemini-*` counts,
  including a Vertex AI path such as
  `projects/<project>/locations/<location>/publishers/google/models/gemini-2.5-flash`.
- The `ADK_DISABLE_GEMINI_MODEL_ID_CHECK` environment variable is enabled. Use
  it when your Gemini deployment does not follow the public `gemini-*` naming.

## Get started

Add the shared `URL_CONTEXT` instance to an agent's `tools`:

```typescript
import {LlmAgent, URL_CONTEXT} from '@google/adk';

export const rootAgent = new LlmAgent({
  name: 'url_reader',
  description: 'An assistant that reads the pages a user links to.',
  model: 'gemini-2.5-flash',
  instruction:
    'Answer the user question from the content of the URLs they provide.',
  tools: [URL_CONTEXT],
});
```

## Failure modes

The tool throws an `Error` when neither condition holds:

```
URL context tool is not supported for model claude-3-sonnet
```

A request with no model throws the same error, with `undefined` as the model.
In an agent run this cannot happen: a request processor assigns
`llmRequest.model` from the agent's model before any tool runs. It reports a
caller that built an `LlmRequest` by hand and left the model out.

The tool normalises `config` and `config.tools` before it decides, so a request
that fails the check still comes back with an empty `config.tools` array rather
than an absent one.
