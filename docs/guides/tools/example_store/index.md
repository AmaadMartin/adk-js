# VertexAiExampleStore

`VertexAiExampleStore` supplies few-shot examples to an agent from a Vertex AI
Example Store. Reach for it when the useful examples depend on what the user
just asked, and when you want to curate them without redeploying the agent.

## Introduction

`ExampleTool` prepends a block of worked examples to the system instruction. You
can give it a fixed array, which is enough when a handful of examples covers
every request. It stops being enough when the agent handles many unrelated
topics: a fixed array either grows past a useful prompt size, or it shows the
model examples that do not match the question.

A `BaseExampleProvider` solves that by choosing examples per turn.
`VertexAiExampleStore` is the provider backed by Vertex AI. You give it a store
resource name. Each turn it runs a similarity search for the user's text, keeps
the ten nearest results, drops any scoring below 0.5, and converts the rest into
`Example` objects. Both numbers are fixed, so the class has no options beyond
the store name.

The search is one HTTPS call per turn. There is no cache, no timeout and no
retry, so a failed search fails the turn instead of quietly returning nothing.
The call uses Application Default Credentials and needs the
`aiplatform.exampleStores.search` permission on the store.

## Get started

Populate a store with the Vertex AI Example Store API first, then point the
provider at it.

```ts
import {ExampleTool, LlmAgent, VertexAiExampleStore} from '@google/adk';

const agent = new LlmAgent({
  name: 'support_agent',
  model: 'gemini-2.0-flash',
  instruction: 'Help the user with their order.',
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
constructor reads the location from it to address the regional endpoint, so a
malformed name throws immediately rather than on the first turn.

## What the agent sees

Each surviving result becomes one `Example`. Its `input` is the stored search
key, as a `user` turn. Its `output` is the stored expected contents, with each
role preserved. `ExampleTool` renders them into the `<EXAMPLES>` block that it
appends to the system instruction.

Only three part kinds survive the conversion: text, function calls and function
responses. A part of any other kind, such as inline image data, is dropped from
the rendered example.

## Writing your own provider

`VertexAiExampleStore` is one implementation of `BaseExampleProvider`. Subclass
it directly to fetch examples from somewhere else. `getExamples` may return the
list or a promise for it, so a provider that calls a network service is
supported without any change at the call site.

```ts
import {BaseExampleProvider, Example} from '@google/adk';

class DatabaseExampleProvider extends BaseExampleProvider {
  override async getExamples(query: string): Promise<Example[]> {
    const rows = await findSimilarRows(query);
    return rows.map((row) => ({
      input: {role: 'user', parts: [{text: row.question}]},
      output: [{role: 'model', parts: [{text: row.answer}]}],
    }));
  }
}
```
