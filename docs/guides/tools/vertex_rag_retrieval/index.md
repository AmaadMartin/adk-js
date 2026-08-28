# VertexRagRetrievalTool

Grounds an agent in a Vertex AI RAG corpus. Reach for it when the answers live
in documents you have already imported into a corpus, and you want the model to
read them instead of guessing.

## Introduction

Vertex AI serves RAG retrieval two different ways, and which one applies depends
on the model. A Gemini model retrieves server-side: you attach the corpus to the
request and Gemini reads it while it generates. Another model, such as Claude on
Vertex, has no such built-in, so somebody has to make the retrieval call.

`VertexRagRetrievalTool` covers both. It reads `llmRequest.model` and picks a
mode: a Gemini model gets `retrieval.vertexRagStore` on the request config and
never sees a function to call, while any other model gets a function declaration
with a single `query` string and the tool queries the RAG Engine itself. One
tool therefore serves a whole agent tree, whatever models the agents in it use.
Compare it with `VertexAiSearchTool`, which grounds against a Vertex AI Search
data store and supports Gemini models only.

## Get started

The tool needs Application Default Credentials, and a corpus you have already
populated. Every field of `VertexRagStore` is a constructor option, plus `name`
and `description`.

```ts
import {LlmAgent, VertexRagRetrievalTool} from '@google/adk';

const ragTool = new VertexRagRetrievalTool({
  name: 'rag_retrieval',
  description: 'Retrieves product documentation.',
  ragResources: [
    {
      ragCorpus:
        'projects/my-project/locations/us-central1/ragCorpora/my-corpus',
    },
  ],
  similarityTopK: 5,
});

const agent = new LlmAgent({
  name: 'docs_agent',
  model: 'gemini-2.5-flash',
  instruction: 'Answer from the product documentation.',
  tools: [ragTool],
});
```

Point the same tool at a non-Gemini model and nothing about the setup changes;
only the mode does. `name` and `description` are what that model reads to decide
whether to call the tool, so they are worth writing for it.

The RAG Engine supports one corpus per `ragResources` array. Create one tool per
corpus.

## Matching nothing is not an error

`runAsync` answers with the text of every matching chunk, in the order the API
returned them. When nothing matches, it answers with a message that says so
rather than throwing, so the model can report it and carry on. Only a real fault
throws: a call carrying no string `query`, a store naming no corpus, a project
and location that cannot be resolved, or a non-2xx status from the API.

## Resolving the project and the location

The tool reads both out of a fully qualified `ragCorpus` name. When the name is
bare, it falls back to `GOOGLE_CLOUD_PROJECT` and `GOOGLE_CLOUD_LOCATION`, and
throws when neither source supplies them.

Set `ADK_DISABLE_GEMINI_MODEL_ID_CHECK=true` when Gemini serves your model under
an id that does not start with `gemini-`. The tool then attaches the built-in
retrieval tool whatever the model id says.
