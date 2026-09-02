# BaseRetrievalTool

`BaseRetrievalTool` is the base class for a tool that looks up data for a
natural-language query. Reach for it when you write a tool that searches an
index, a document store, or a knowledge base, and you want the model to see the
same parameter every other ADK retrieval tool declares.

## Introduction

Every retrieval tool asks the model for one thing: a query string. Writing that
declaration by hand in each tool invites drift, and a divergent parameter name
or description changes how well the model calls the tool. `BaseRetrievalTool`
declares it once — a single optional string parameter `query`, described as
`'The query to retrieve.'` — and a subclass supplies `runAsync` only.

It extends `BaseTool`, so a retrieval tool inherits the normal request path:
`processLlmRequest` appends the declaration to the request and registers the
tool by name. The difference from a plain `BaseTool` is the declaration and the
`isBaseRetrievalTool` type guard, which lets other code recognise a retrieval
tool without `instanceof`. The guard uses a `Symbol.for` brand, so it still
returns `true` when two copies of adk-js run in one process.

A retrieval that matches nothing is a normal outcome, not an error. Return a
result that says so and let the model continue the turn. The model populates
`args['query']`, so treat it as untrusted input and validate it before it
reaches a filesystem, an index, or a network call.

## Get started

Extend the class and implement `runAsync`.

```ts
import {BaseRetrievalTool, RunAsyncToolRequest} from '@google/adk';

const DOCUMENTS = [
  'ADK agents run tools through a Runner.',
  'A retrieval tool answers a natural-language query.',
];

class DocsRetrieval extends BaseRetrievalTool {
  constructor() {
    super({
      name: 'docs_retrieval',
      description: 'Searches the ADK documentation.',
    });
  }

  override async runAsync({args}: RunAsyncToolRequest): Promise<unknown> {
    const query = args['query'];
    if (typeof query !== 'string' || query.trim() === '') {
      return {result: 'Provide a non-empty query string.'};
    }
    const matches = DOCUMENTS.filter((doc) =>
      doc.toLowerCase().includes(query.toLowerCase()),
    );
    if (matches.length === 0) {
      return {result: `No document matches ${query}.`};
    }
    return {result: matches.join('\n')};
  }
}

const tool = new DocsRetrieval();
```

Pass `tool` to an agent's `tools` and the model sees one function,
`docs_retrieval`, with one `query` parameter.

## The declaration shape

`_getDeclaration` returns one of two shapes, and the
`JSON_SCHEMA_FOR_FUNC_DECL` feature selects which. The feature is off by
default, so the declaration carries a genai `Schema` on `parameters`:

```ts
{
  name: 'docs_retrieval',
  description: 'Searches the ADK documentation.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      query: {type: Type.STRING, description: 'The query to retrieve.'},
    },
  },
}
```

Turn the feature on and the declaration carries a raw JSON schema on
`parametersJsonSchema` instead, with `parameters` unset:

```ts
{
  name: 'docs_retrieval',
  description: 'Searches the ADK documentation.',
  parametersJsonSchema: {
    type: 'object',
    properties: {
      query: {type: 'string', description: 'The query to retrieve.'},
    },
  },
}
```

Enable it for a whole process with the environment variable
`ADK_ENABLE_JSON_SCHEMA_FOR_FUNC_DECL=1`, or from code:

```ts
import {
  FeatureName,
  overrideFeatureEnabled,
  withTemporaryFeatureOverride,
} from '@google/adk';

overrideFeatureEnabled(FeatureName.JSON_SCHEMA_FOR_FUNC_DECL, true);

// Or for one call only:
const declaration = await withTemporaryFeatureOverride(
  FeatureName.JSON_SCHEMA_FOR_FUNC_DECL,
  true,
  () => tool._getDeclaration(),
);
```

`_getDeclaration` reads the feature on every call, so a host can toggle it
without rebuilding its tools. `query` is never marked required in either shape.
