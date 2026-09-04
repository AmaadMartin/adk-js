# DiscoveryEngineSearchTool

`DiscoveryEngineSearchTool` searches a Vertex AI Search (Discovery Engine) data
store or search engine, and returns the matching titles, urls and content to
the model. Reach for it when your agent must ground on a data store and the
model cannot ground itself.

## Introduction

ADK ships two ways to search a Vertex AI Search data store, and they are not
interchangeable.

`VertexAiSearchTool` is a built-in grounding tool. It never issues a request.
It attaches a `retrieval.vertexAiSearch` block to the request, and Gemini does
the search on the server. That is the cheapest option, and it only works on
Gemini.

`DiscoveryEngineSearchTool` is an ordinary function tool. The model calls
`discovery_engine_search(query)`, this tool sends the search, and the results
come back as a tool response. Because the search happens in your process, the
tool works with any model: Claude on Vertex, a self-hosted model, or Gemini.

The tool also handles the two ways a data store shapes its answers. An
unstructured store returns chunks of text. A structured store — a bug export, a
product catalogue — rejects chunk mode and returns whole documents. You do not
have to know which kind you have: the tool tries chunks first, notices the
error the API returns, and switches to documents for the rest of its life.

## Get started

```ts
import {DiscoveryEngineSearchTool, LlmAgent} from '@google/adk';

const agent = new LlmAgent({
  name: 'docs_agent',
  model: 'gemini-2.5-flash',
  instruction: 'Answer the question using discovery_engine_search.',
  tools: [
    new DiscoveryEngineSearchTool({
      dataStoreId:
        'projects/my-project/locations/global/collections/' +
        'default_collection/dataStores/my-store',
    }),
  ],
});
```

The tool reads Application Default Credentials on its first search, so run
`gcloud auth application-default login` first, or give the process a service
account. A runnable version of this agent is in
`samples/tools/discovery_engine_search/agent.ts`. It makes real API calls and
needs a data store with documents in it.

## Configuration

Give the tool exactly one of `dataStoreId` or `searchEngineId`. The constructor
throws when you give it both or neither.

| Option             | Effect                                                           |
| ------------------ | ---------------------------------------------------------------- |
| `dataStoreId`      | Searches one data store.                                         |
| `searchEngineId`   | Searches a search engine.                                        |
| `dataStoreSpecs`   | Narrows an engine to some of its stores. Needs `searchEngineId`. |
| `filter`           | Sent as the request `filter`.                                    |
| `maxResults`       | Sent as the request `pageSize`. A value of 0 sends nothing.      |
| `searchResultMode` | Fixes the mode and skips auto-detection.                         |
| `location`         | Overrides the endpoint location.                                 |

Both ids accept a full resource path or a bare id.

## The endpoint the tool calls

The tool reads the location out of the `/locations/<location>/` segment of the
id you gave it. `global`, and an id with no location segment, call
`discoveryengine.googleapis.com`. Any other location calls
`<location>-discoveryengine.googleapis.com`, which is what a data-residency
requirement needs.

Pass `location` to override this. An override that contradicts the id is an
error, so a typo fails at construction instead of searching the wrong region.

```ts
// Calls eu-discoveryengine.googleapis.com.
new DiscoveryEngineSearchTool({
  dataStoreId:
    'projects/my-project/locations/eu/collections/default_collection/' +
    'dataStores/my-store',
});
```

Set `GOOGLE_API_USE_MTLS_ENDPOINT=always`, or set it to `auto` together with
`GOOGLE_API_USE_CLIENT_CERTIFICATE=true`, to call the mutual-TLS host instead.
The endpoint is resolved when you construct the tool, so change these variables
before that.

## Result modes

Leave `searchResultMode` unset and the tool detects the mode on its first
search. It sends one `CHUNKS` request; if the API answers that the store needs
`DOCUMENTS`, it records that and retries. The answer is kept for the life of
the tool, so only the first search pays for the probe.

The probe is shared. Several searches that start before the first one finishes
wait for it rather than each sending their own `CHUNKS` request. A probe that
fails for an unrelated reason — no permission, the service is down — is not
recorded, and the next search probes again.

Set the mode yourself when you already know it:

```ts
import {DiscoveryEngineSearchTool, SearchResultMode} from '@google/adk';

new DiscoveryEngineSearchTool({
  dataStoreId: 'my-store',
  searchResultMode: SearchResultMode.DOCUMENTS,
});
```

## What the model receives

A successful search returns `{status: 'success', results}`, where each result
is `{title, url, content}`. A field the store does not supply is an empty
string.

The tool never throws out of a search. An API failure becomes
`{status: 'error', error_message}`, so the model reads the reason and can try a
different query. The message is the one the API returned.
