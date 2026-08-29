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
resource name. Each turn it runs a similarity search for the user's text, asks
for the ten nearest results, drops any scoring below 0.5, and converts the rest
into `Example` objects. Both numbers are fixed, so the class takes no options
beyond the store name.

The provider adds no cache, no timeout and no retry. A failed search fails the
turn; it does not return an empty list. The search uses Application Default
Credentials with the `cloud-platform` scope, and the caller needs the
`aiplatform.exampleStores.readExample` permission on the store.

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
key, as a `user` turn. Its `output` is the stored expected contents, and each
content keeps the role the store returned. `ExampleTool` renders the examples
into the `<EXAMPLES>` block that it appends to the system instruction.

Only three part kinds survive the conversion: text, function calls and function
responses. A part of any other kind, such as inline image data, is dropped from
the example.

An empty result set is safe. The agent still receives a well-formed, empty
`<EXAMPLES>` block.

## Providers may resolve asynchronously

`BaseExampleProvider.getExamples` returns `Example[]` or `Promise<Example[]>`. A
provider that calls a remote service therefore needs no change at the call site:
`ExampleTool` awaits the result before it sends the request. A provider that
already returns a plain array keeps working.
