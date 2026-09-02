# Configuring the Gemini model

`Gemini` builds the google-genai client that carries every model call. This
guide covers the options that shape that client — the endpoint, the API
version, retries and a live voice — and the request behaviour that depends on
them.

## Introduction

By default `Gemini` builds its own client from an API key or from your Vertex AI
project, and lets the google-genai SDK pick the endpoint and the API version.
That default is right for most agents. It is wrong in three situations.

The first is a pinned endpoint. The SDK defaults to `v1beta1` on Vertex AI,
which exposes preview features. A production deployment that needs the GA
endpoint must ask for `v1`. The second is a different endpoint altogether: a
regional host, or a proxy that fronts the model. The third is a client that ADK
cannot build for you, because it carries credentials or a transport of your own.

`baseUrl` and `apiVersion` cover the first two. `client` and `clientKwargs`
cover the third. `retryOptions` and `speechConfig` tune the calls themselves.
Every option is optional, and leaving them all unset gives you the default
client.

Note that the live endpoint is separate. It always uses `v1beta1` on Vertex AI
and `v1alpha` on the Gemini API, so `apiVersion` does not change it. Only a
version embedded in `baseUrl` does.

## Get started

```ts
import {Gemini} from '@google/adk';

// Pin the GA Vertex AI endpoint instead of the SDK's v1beta1 default.
const model = new Gemini({model: 'gemini-2.5-pro', apiVersion: 'v1'});
```

## Choosing an endpoint

`baseUrl` sets the endpoint. When the host is a `*.googleapis.com` host and the
whole path is a version segment, ADK lifts that version out and uses it as the
API version:

```ts
const model = new Gemini({
  model: 'gemini-2.5-flash',
  baseUrl: 'https://generativelanguage.googleapis.com/v1alpha',
});
// The client is built with baseUrl 'https://generativelanguage.googleapis.com/'
// and apiVersion 'v1alpha'.
```

Any other URL is passed through untouched, so a proxy keeps its path:

```ts
const model = new Gemini({
  model: 'gemini-2.5-flash',
  baseUrl: 'https://proxy.example.com/gemini/v1alpha',
});
// baseUrl is unchanged and the SDK's default API version applies.
```

The API version resolves in this order, first match wins:

1. A version lifted out of `baseUrl`.
2. The `apiVersion` field.
3. The `GOOGLE_GENAI_API_VERSION` environment variable.
4. The google-genai SDK default.

The environment variable is read only when ADK builds the client. A per-request
`config.httpOptions.apiVersion` you set yourself is never overwritten.

## Bringing your own client

`client` takes a client you configured. ADK then builds none of its own, and
uses yours for both the generate-content path and the live path. `clientKwargs`
is ignored in that case.

```ts
import {GoogleGenAI} from '@google/genai';

const client = new GoogleGenAI({
  vertexai: true,
  project: 'my-project',
  location: 'us-central1',
});
const model = new Gemini({model: 'gemini-2.5-flash', client});
```

`clientKwargs` is the lighter option. It passes google-genai constructor
options ADK does not expose as fields, and it is merged over the options ADK
computed, so it wins:

```ts
const model = new Gemini({
  model: 'gemini-2.5-flash',
  vertexai: true,
  project: 'my-project',
  clientKwargs: {location: 'global'},
});
```

## Retries and live voice

`retryOptions` sets the SDK's retry policy. It applies to the generate-content
client only; the live client does not retry.

```ts
const model = new Gemini({
  model: 'gemini-2.5-flash',
  retryOptions: {attempts: 3},
});
```

`speechConfig` picks the voice for a live session. It overrides a speech config
already on the request, so it is the model's setting that wins:

```ts
const model = new Gemini({
  model: 'gemini-2.5-flash',
  speechConfig: {languageCode: 'en-US'},
});
```

## Quota errors

When the model rejects a call with HTTP 429, `generateContentAsync` throws a
`ResourceExhaustedError` instead of the SDK's own error. Its message carries a
link to the mitigation guide followed by the original message, and the original
error is on `cause`. Any other error is rethrown unchanged.

```ts
import {
  getLogger,
  isResourceExhaustedError,
  LlmRequest,
  LlmResponse,
} from '@google/adk';

const logger = getLogger();

async function collect(request: LlmRequest): Promise<LlmResponse[]> {
  const responses: LlmResponse[] = [];
  try {
    for await (const response of model.generateContentAsync(request)) {
      responses.push(response);
    }
  } catch (e: unknown) {
    if (isResourceExhaustedError(e)) {
      // e.status is 429 and e.cause is the error the SDK raised.
      logger.warn(e.message);
    }
    throw e;
  }
  return responses;
}
```

Use `isResourceExhaustedError` rather than `instanceof`. Two copies of adk-js in
one runtime would fail an `instanceof` check between them.
