# VertexRagRetrievalTool

Grounds an agent in a Vertex AI RAG corpus. Reach for it when the answers live
in documents you have already imported into a RAG corpus, and you want the model
to cite them instead of guessing.

## Introduction

Vertex AI serves RAG retrieval two different ways, and which one applies depends
on the model. A Gemini model retrieves server-side: you attach the corpus to the
request and Gemini reads it while it generates. Another model, such as Claude on
Vertex, has no such built-in, so somebody has to make the retrieval call.

`VertexRagRetrievalTool` covers both. It reads `llmRequest.model` and picks a
mode:

- A Gemini model gets `retrieval.vertexRagStore` on the request config, and
  never sees a function to call.
- Any other model gets a function declaration with a single `query` string. When
  the model calls it, the tool queries the RAG Engine itself and answers with the
  matching text.

One tool therefore serves a whole agent tree, whatever models the agents in it
use. Compare it with `VertexAiSearchTool`, which grounds against a Vertex AI
Search data store and supports Gemini models only.

## Get started

The tool needs Application Default Credentials, and a corpus you have already
populated.

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
only the mode does.

## Configuration

`VertexRagRetrievalToolParams` extends `VertexRagStore` from `@google/genai`, so
every field of the store is a constructor option. `name` and `description` are
the two additions.

| Option                    | Default                          | Description                                                                             |
| ------------------------- | -------------------------------- | --------------------------------------------------------------------------------------- |
| `name`                    | `'vertex_rag_retrieval'`         | The function name a non-Gemini model calls.                                             |
| `description`             | `'Vertex AI RAG Retrieval Tool'` | The description that model reads.                                                       |
| `ragResources`            | none                             | The corpus to search, as `{ragCorpus, ragFileIds}`.                                     |
| `ragCorpora`              | none                             | Corpus names. Deprecated upstream; `ragResources` is the replacement.                   |
| `similarityTopK`          | none                             | How many chunks to return.                                                              |
| `vectorDistanceThreshold` | none                             | Drops a chunk whose vector distance is larger.                                          |
| `ragRetrievalConfig`      | none                             | The full retrieval config. It wins over `similarityTopK` and `vectorDistanceThreshold`. |

The RAG Engine supports one corpus per `ragResources` array. Create one tool per
corpus.

## What the tool returns

`runAsync` answers with the text of every matching chunk, in the order the API
returned them:

```ts
const texts = await ragTool.runAsync({
  args: {query: 'how do I ship it'},
  toolContext,
});
// ['Ship it with the release script...', 'Then tag the commit...']
```

Matching nothing is a normal outcome, not an error. The tool answers with a
message instead, so the model can say so and carry on:

```
No matching result found with the config: {"ragResources":[{"ragCorpus":"..."}]}
```

## Failure modes

The tool throws a plain `Error` in four cases.

| Condition                                             | Message                                                                   |
| ----------------------------------------------------- | ------------------------------------------------------------------------- |
| The model calls the tool without a string `query`     | `Vertex AI RAG retrieval requires a string 'query'.`                      |
| Neither `ragResources` nor `ragCorpora` is configured | `Vertex AI RAG retrieval requires ragResources or ragCorpora.`            |
| The project and location cannot be resolved           | `Vertex AI RAG retrieval could not resolve the project and location. ...` |
| The API answers with a non-2xx status                 | `Vertex AI RAG retrieval failed with status <status>: <body>`             |

The tool reads the project and the location out of a fully qualified
`ragCorpus` name. When the name is bare, it falls back to
`GOOGLE_CLOUD_PROJECT` and `GOOGLE_CLOUD_LOCATION`, and throws when neither
source supplies them.

## Forcing the server-side mode

Set `ADK_DISABLE_GEMINI_MODEL_ID_CHECK=true` when Gemini serves your model under
an id that does not start with `gemini-`. The tool then attaches the built-in
retrieval tool whatever the model id says.
