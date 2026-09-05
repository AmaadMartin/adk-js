# GoogleSearchAgentTool

`GoogleSearchAgentTool` runs Google Search inside a sub-agent and calls that
sub-agent as an ordinary function tool. Reach for it when your agent needs
Google Search beside other tools and the model rejects that combination.

## Introduction

`GoogleSearchTool` is a built-in tool: the model runs it inside its own serving
stack. A Gemini 1.x request rejects `google_search` when it already carries
another tool, and `GoogleSearchTool` throws rather than send such a request.
The message is `Google search tool can not be used with other tools in Gemini
1.x.`

This tool works around that limit by splitting the work over two requests. The
sub-agent's request carries `google_search` and nothing else. Your agent's
request carries `google_search_agent` as a plain function declaration, beside
whatever other tools you gave it. Neither request breaks the limit.

The cost of the extra hop is one more model call per search, and the search
result reaching your agent as tool output rather than as a grounded answer. The
tool publishes the sub-agent's grounding metadata to your agent's state so the
citation is not lost. See [Grounding metadata](#grounding-metadata).

Two symbols make up the feature:

- `createGoogleSearchAgent(model)` builds the sub-agent. It is an `LlmAgent`
  named `google_search_agent` whose only tool is the shared `GOOGLE_SEARCH`
  instance.
- `GoogleSearchAgentTool` wraps that sub-agent. It is an `AgentTool` with
  grounding-metadata propagation turned on.

This is a workaround. Prefer plain `GOOGLE_SEARCH` on a model that accepts it
beside your other tools.

## Get started

```typescript
import {
  createGoogleSearchAgent,
  FunctionTool,
  GoogleSearchAgentTool,
  LlmAgent,
} from '@google/adk';
import {z} from 'zod';

const countWords = new FunctionTool({
  name: 'count_words',
  description: 'Counts the words in a piece of text.',
  parameters: z.object({text: z.string()}),
  execute: async ({text}) => ({wordCount: text.trim().split(/\s+/).length}),
});

export const rootAgent = new LlmAgent({
  name: 'root_agent',
  model: 'gemini-2.5-flash',
  instruction: 'Use the google_search_agent tool to look things up on the web.',
  tools: [
    new GoogleSearchAgentTool(createGoogleSearchAgent('gemini-2.5-flash')),
    countWords,
  ],
});
```

The model calls the tool by the sub-agent's name, `google_search_agent`, and
sends it one `request` string. `dev/samples/google_search_agent_tool.ts` holds
this same agent, runnable with `npm run sample`.

## Choosing the sub-agent's model

`createGoogleSearchAgent` takes a model name or a `BaseLlm` instance and passes
it to the sub-agent unchanged. It applies no default and validates nothing, so
give it a model that supports Google Search. `GoogleSearchTool` throws on any
model that is not a Gemini model.

The sub-agent's model is independent of your agent's model. Point the sub-agent
at a cheaper model when the search turn does not need the larger one.

## Grounding metadata

After the sub-agent answers, the tool writes the grounding metadata of the
sub-agent's last content-bearing reply to your agent's state, under
`temp:_adk_grounding_metadata`. adk-python writes the same value under the same
key.

The `temp:` prefix scopes the value to the invocation that is running. The
session service drops such keys when it writes the event, so the metadata never
reaches the stored session:

```typescript
const session = await sessionService.getSession({appName, userId, sessionId});
// 'temp:_adk_grounding_metadata' is not in session.state.
```

The tool writes nothing when the sub-agent's last reply carries no grounding
metadata.

Reading the value back onto your agent's own response is a separate step that
adk-js does not perform yet. Today the metadata is published for your own code
to read during the invocation.

## Doing this on a plain AgentTool

`propagateGroundingMetadata` is an option on `AgentTool`, so any wrapped agent
can publish its grounding metadata:

```typescript
import {AgentTool} from '@google/adk';

const tool = new AgentTool({agent: myAgent, propagateGroundingMetadata: true});
```

`GoogleSearchAgentTool` is that option applied to a search sub-agent. The option
is off by default.
