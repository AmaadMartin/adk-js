# VertexAiExampleStore

`VertexAiExampleStore` reads few-shot examples from a Vertex AI Example Store
instead of from an array in your source. Reach for it when the useful examples
change more often than the agent does, or when there are too many of them to
keep in the code.

## Introduction

`ExampleTool` prepends a few-shot block to the system instruction on every
turn. It accepts either a fixed `Example[]` or a `BaseExampleProvider`, which
picks the examples for the current query. A fixed array sends the same examples
every turn and has to be redeployed to change, so it suits an agent with a
handful of stable examples.

`VertexAiExampleStore` is the provider for the other case. It searches a store
you curate outside the agent, so the examples can change while the agent keeps
running, and the model only sees the ten nearest examples rather than the whole
set. The store is a Vertex AI resource; you upload examples to it, and this
class only reads.

The provider searches on every turn. That is one authenticated HTTPS call per
turn, so a store with a stable, small example set is better served by an array.

## Get started

Point the store at its resource name and hand it to an `ExampleTool`:

```ts
import {ExampleTool, LlmAgent, VertexAiExampleStore} from '@google/adk';

const agent = new LlmAgent({
  name: 'weather_agent',
  model: 'gemini-2.0-flash',
  instruction: 'Answer the question.',
  tools: [
    new ExampleTool(
      new VertexAiExampleStore(
        'projects/my-project/locations/us-central1/exampleStores/my-store',
      ),
    ),
  ],
});
```

The resource name must be
`projects/{project}/locations/{location}/exampleStores/{example_store}`. The
constructor throws on any other shape, because it reads the location out of the
name to address the regional Vertex AI endpoint.

Credentials come from Application Default Credentials, and the principal must
be allowed to read the store.

## What a search returns

Each turn, the tool passes the latest user text to `getExamples`, which:

- asks the store for the 10 nearest examples,
- drops any result scoring below 0.5,
- keeps the remaining results in the order the store returned them.

Every surviving result becomes one `Example`. Its `input` is the search key
stored with the example, not the query you searched with, so the few-shot block
shows the curated question rather than the user's phrasing.

A stored part becomes an output part when it is text, a function call, or a
function response. Any other kind of part is dropped, because the few-shot
block is text and cannot render it.

## Errors

The search rejects rather than returning an empty result when it fails, so a
missing credential, a denied permission, or an unreachable store fails the
turn. A search that succeeds and matches nothing resolves to an empty array,
and `ExampleTool` then appends an empty few-shot block.

## Writing your own remote provider

`BaseExampleProvider.getExamples` returns `Example[] | Promise<Example[]>`, so
a provider that calls a network service returns a promise:

```ts
import {BaseExampleProvider, Example} from '@google/adk';

class RemoteExampleProvider extends BaseExampleProvider {
  constructor(private readonly search: (query: string) => Promise<Example[]>) {
    super();
  }

  override getExamples(query: string): Promise<Example[]> {
    return this.search(query);
  }
}
```

A provider that already has its examples in memory still returns them
directly; the array is assignable to the union.
