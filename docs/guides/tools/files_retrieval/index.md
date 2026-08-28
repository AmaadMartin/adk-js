# FilesRetrieval

`FilesRetrieval` turns a directory of text files into a tool an agent can
search. Reach for it when the answers live in local documents that the model
was never trained on.

## Introduction

An agent that must answer from your own documents needs retrieval. The
alternative — pasting every document into the instruction — costs tokens on
every turn and stops working once the documents outgrow the context window.
Retrieval keeps the documents outside the prompt and pulls in only the passage
that matches the query.

ADK splits this into three layers, so you can enter at whichever one fits.

- `BaseRetrievalTool` is the shared model-facing declaration. Every retrieval
  tool takes one string parameter, `query`.
- `RetrieverTool` adapts any object with a `retrieve(query)` method into a
  tool. Use it when you already run a vector store or a search API.
- `FilesRetrieval` is the batteries-included case. It reads a directory,
  embeds it, and keeps the index in memory.

A query that matches nothing is a normal outcome, not an error. The tool
answers `No matching result found for the query: <query>`, and the model
continues the turn.

`FilesRetrieval` is not the same thing as `VertexRagRetrievalTool`. That tool
asks the Vertex AI RAG Engine to ground the model on the server side and never
reads a local file.

## Get started

Write a document, index it, and give the tool to an agent.

```ts
import {FilesRetrieval, LlmAgent} from '@google/adk';

const searchDocuments = await FilesRetrieval.create({
  name: 'search_documents',
  description: 'Search the local ADK documentation files.',
  inputDir: './data',
});

const agent = new LlmAgent({
  name: 'files_retrieval_agent',
  model: 'gemini-2.0-flash',
  instruction: 'Call search_documents before you answer.',
  tools: [searchDocuments],
});
```

`create` is a static factory because reading and embedding the directory is
asynchronous, and a constructor cannot await.

## What gets indexed

`FilesRetrieval` walks `inputDir` recursively and reads every regular file.
A file is skipped when it is not valid UTF-8, when it is blank, or when the
process cannot read it. Symbolic links are skipped, so the walk cannot follow
one out of the directory or into a cycle.

Only plain text is indexed. adk-python delegates to llama-index, which reads
PDF and Office documents through reader plugins. There is no equivalent here,
so those files are skipped as binary. Convert them to text first.

Each file is split into 1024-character chunks that overlap by 200 characters.
The index lives in memory and is rebuilt on every `create` call.

## Embedding

The default embedding model is `gemini-embedding-2-preview`, called one text
per request. It builds its client from the environment on first use, so an
unused tool needs no credentials. Set `GOOGLE_API_KEY`, or set
`GOOGLE_GENAI_USE_ENTERPRISE` together with `GOOGLE_CLOUD_PROJECT` and
`GOOGLE_CLOUD_LOCATION` for Vertex AI.

Pass `embeddingModel` to use another model, or to run offline:

```ts
import {
  EmbeddingModel,
  FilesRetrieval,
  GeminiEmbeddingModel,
} from '@google/adk';

const embeddingModel: EmbeddingModel = new GeminiEmbeddingModel({
  model: 'gemini-embedding-2-preview',
  embedBatchSize: 8,
});

const tool = await FilesRetrieval.create({
  name: 'search_documents',
  description: 'Search the local ADK documentation files.',
  inputDir: './data',
  embeddingModel,
});
```

## Bring your own retriever

`RetrieverTool` wraps anything that returns documents for a query, ranked
best-first. The tool answers with the first document's text.

```ts
import {RetrieverTool} from '@google/adk';

const documents = ['The loop agent repeats its sub-agents.'];

const tool = new RetrieverTool({
  name: 'docs',
  description: 'Search the product documentation.',
  retriever: {
    retrieve: async (query: string) =>
      documents.filter((text) => text.includes(query)).map((text) => ({text})),
  },
});
```

## Failure modes

| Condition                                    | Result                                                                      |
| -------------------------------------------- | --------------------------------------------------------------------------- |
| `inputDir` is missing, or is not a directory | `create` rejects with `Input directory does not exist: <dir>`               |
| `inputDir` holds no readable text            | `create` rejects with `No files found in: <dir>`                            |
| The model sends no query, or a blank one     | `runAsync` throws `Retrieval requires a non-empty string "query" argument.` |
| Nothing matches the query                    | `runAsync` returns `No matching result found for the query: <query>`        |
| The embedding API fails                      | The error propagates unchanged                                              |
