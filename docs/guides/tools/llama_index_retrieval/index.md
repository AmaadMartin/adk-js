# LlamaIndexRetrievalTool

`LlamaIndexRetrievalTool` exposes a LlamaIndex.TS index to an agent as a tool.
Reach for it when you already built an index with LlamaIndex.TS and you want a
model to ground its answers in that index.

## Introduction

An agent that answers from its own weights cannot cite your documents. The usual
remedy is retrieval: the model writes a query, something searches a corpus, and
the best passage comes back as a tool response the model can quote.

ADK does not own the index. `LlamaIndexRetrievalTool` takes a retriever you
built and adapts it to the tool interface, so the search stays entirely in
LlamaIndex.TS.

Two other retrieval tools sit next to it, and they are not interchangeable:

- `VertexRagRetrievalTool` runs on the server. It asks Gemini to query a Vertex
  AI RAG corpus, so no retrieval code runs in your process.
- `VertexAiSearchTool` grounds the model in a Vertex AI Search data store.

Use `LlamaIndexRetrievalTool` when the index is yours and lives in your process.

ADK does not depend on `llamaindex`. The tool declares the small structural
interface it calls, and a real LlamaIndex.TS `BaseRetriever` satisfies that
interface with no cast. Install `llamaindex` yourself only if you use it.

## Get started

```ts
import {LlamaIndexRetrievalTool, LlmAgent} from '@google/adk';
import {Document, VectorStoreIndex} from 'llamaindex';

const index = await VectorStoreIndex.fromDocuments([
  new Document({text: 'ADK agents call tools to ground their answers.'}),
]);

const docsTool = new LlamaIndexRetrievalTool({
  name: 'docs',
  description: 'Retrieves ADK documentation.',
  retriever: index.asRetriever(),
});

const agent = new LlmAgent({
  name: 'helper',
  model: 'gemini-flash-latest',
  instruction: 'Answer from the docs tool. Say so when it finds nothing.',
  tools: [docsTool],
});
```

The model sees one function, `docs`, with a single string parameter `query`. The
tool passes that string to `retriever.retrieve` and returns the text of the
top-ranked hit.

## What the tool guarantees

**One passage, not a list.** The retriever ranks the hits and the tool returns
the first. Pass `similarityTopK` to `asRetriever` to change what the retriever
ranks first; the tool never re-ranks.

**Raw chunk text.** The tool asks the node for its content in LlamaIndex.TS's
`MetadataMode.NONE`, so the returned text carries no metadata.

**A miss is a tool response, not an exception.** The tool returns
`No matching result found for the query: <query>`, so tell the model in the
instruction what to do with a miss, as the example above does. An error your
retriever throws propagates unchanged; the tool does not catch, wrap or retry.

**A bad `query` throws.** The declaration does not mark `query` as required, so
a model may omit it. Anything that is not a string is rejected before the
retriever runs:

```ts
await docsTool.runAsync({args: {}, toolContext});
// Error: Tool docs requires a string 'query' argument.
```

An empty string is a valid query and reaches the retriever unchanged.

## Using a retriever that is not LlamaIndex.TS

The tool depends on the interface, not on the package. Anything that implements
`LlamaIndexRetriever` works:

```ts
import {LlamaIndexRetrievalTool} from '@google/adk';
import type {LlamaIndexRetriever} from '@google/adk';

const retriever: LlamaIndexRetriever = {
  async retrieve(query: string) {
    const text = await search(query);
    return text ? [{node: {getContent: () => text}}] : [];
  },
};

const tool = new LlamaIndexRetrievalTool({
  name: 'notes',
  description: 'Searches my notes.',
  retriever,
});
```
