# Configuring the Gemini model

`Gemini` builds the `@google/genai` client that carries every model call. Its
constructor options decide which endpoint that client talks to, how it retries,
and what a live connection sounds like. Reach for them when the default
endpoint, the default API version, or the default client is not what you want.

## Introduction

By default `Gemini` builds its own client from an API key or from your Vertex
AI project and location, and lets the SDK pick the endpoint and the API
version. That is the right default, and most agents never change it.

Three situations need more. A production deployment may need the stable Vertex
AI endpoint rather than the preview one the SDK defaults to. A deployment
behind a proxy needs a different base URL. A deployment with its own
credentials, region, or transport already has a configured `GoogleGenAI`
client, and needs ADK to use that one instead of building another.

The options below cover all three. They are constructor options, so they apply
to every request the model makes. To change one request only, put the value on
that request's `config.httpOptions`: the model never overwrites an API version
a request already carries.

## Get started

Pin the stable Vertex AI API version:

```ts
import {Gemini, LlmAgent} from '@google/adk';

const agent = new LlmAgent({
  name: 'assistant',
  model: new Gemini({model: 'gemini-2.5-pro', apiVersion: 'v1'}),
});
```

## Choosing an endpoint

`baseUrl` sets the endpoint and `apiVersion` sets the version. The version is
resolved in this order, and the first one that is set wins:

1. a version in the path of a `*.googleapis.com` `baseUrl`;
2. the `apiVersion` option;
3. the `GOOGLE_GENAI_API_VERSION` environment variable;
4. the SDK's own default.

A Google endpoint whose whole path is a version is split, so this model sends
`v1alpha` to `https://generativelanguage.googleapis.com/`:

```ts
const model = new Gemini({
  model: 'gemini-2.5-flash',
  baseUrl: 'https://generativelanguage.googleapis.com/v1alpha',
});
```

Any other URL is sent as it is. A proxy therefore keeps its own path:
`https://proxy.example.com/gemini/v1alpha` reaches the proxy unchanged, and the
SDK's default version applies.

Live (bidi) connections resolve the version differently. A version in
`baseUrl` still wins, but the `apiVersion` option and the environment variable
do not apply: the live endpoint uses `v1beta1` on Vertex AI and `v1alpha` on
the Gemini API.

## Bringing your own client

`client` takes a `GoogleGenAI` you built yourself. ADK then uses it for every
call, including live connections, and builds no client of its own. `baseUrl`,
`retryOptions` and `clientKwargs` no longer apply, because nothing is left for
them to configure. `apiVersion` still does: it is set on each request, so an
injected client honours it too.

```ts
import {GoogleGenAI} from '@google/genai';
import {Gemini} from '@google/adk';

const model = new Gemini({
  model: 'gemini-3-pro-preview',
  client: new GoogleGenAI({
    vertexai: true,
    project: 'my-project',
    location: 'global',
  }),
});
```

`clientKwargs` is the smaller version of the same idea. It is merged over the
options ADK passes to the `GoogleGenAI` constructor, so it can set a field ADK
does not expose, or override one it does.

## Retrying a failed request

`retryOptions` is forwarded to the SDK's HTTP layer, which retries a retriable
status such as 429 or 503:

```ts
const model = new Gemini({
  model: 'gemini-2.5-flash',
  retryOptions: {attempts: 2},
});
```

`attempts` counts the first call, so `{attempts: 2}` means one retry. Retries
apply to ordinary requests only, not to live connections.

## Handling an exhausted quota

An HTTP 429 arrives as a `ResourceExhaustedError`, a subclass of the SDK's
`ApiError`. It keeps the original status and message, and prefixes the message
with a link to the mitigation guide. Every other status is thrown unchanged.

```ts
import {Gemini, ResourceExhaustedError} from '@google/adk';

try {
  for await (const response of model.generateContentAsync(request)) {
    // ...
  }
} catch (error: unknown) {
  if (error instanceof ResourceExhaustedError) {
    // error.status is 429 and error.cause is the original error.
  }
}
```

One interaction is worth knowing. When `retryOptions` is set, the SDK's retry
layer reports an exhausted retry as a plain `Error` that carries no status, so
a 429 does not become a `ResourceExhaustedError`.

## Choosing a voice for a live run

`speechConfig` is applied to every live connection this model opens. It
overrides a speech config already on the request:

```ts
const model = new Gemini({
  model: 'gemini-2.5-flash',
  speechConfig: {voiceConfig: {prebuiltVoiceConfig: {voiceName: 'Kore'}}},
});
```

## What the model does to a request

Two things happen to every request before it goes out, whichever backend is in
use.

The ADK tracking labels are merged into `x-goog-api-client` and `user-agent`.
Your own value for either header is kept: its parts are appended after the ADK
ones, without duplicates.

Inline data the model cannot read is turned into text. A part whose MIME type
Gemini accepts inline — an image, audio, video, or a PDF — is left alone. Any
other inline part becomes text: the decoded content for a text-like type, and
a short summary naming the type and the size otherwise.
