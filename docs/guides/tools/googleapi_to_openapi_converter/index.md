# GoogleApiToOpenApiConverter

Turns a Google API Discovery document into an OpenAPI 3.0 document, so a public
Google REST API such as Calendar, Gmail or Docs can drive `OpenAPIToolset`.
Reach for it when you want an agent to call a Google API and you do not want to
write the specification by hand.

## Introduction

Google publishes a machine-readable description of most of its REST APIs as a
[Discovery document](https://developers.google.com/discovery). ADK cannot use
that format directly: the tool machinery in `core/src/tools/openapi_tool` reads
OpenAPI. The converter closes that gap. It fetches the Discovery document for
one API and version, translates it, and gives you an `OpenAPIV3.Document` that
`OpenAPIToolset` accepts.

The translation is a rewrite, not a copy. Discovery nests methods under
resources; OpenAPI puts every operation under a flat `paths` map, so the
converter walks the resource tree and flattens it. Discovery marks a required
property with a boolean on the property; OpenAPI lists the required names on the
parent object. Discovery names a schema `Calendar`; OpenAPI addresses it as
`#/components/schemas/Calendar`.

Use the converter when the API you want is a public Google API with a Discovery
document. Write the specification yourself when the service is not a Google API,
or when you want to expose a subset of an API that the Discovery document does
not already describe as its own resource.

## Get started

Convert one API and hand the result to a toolset.

```ts
import {GoogleApiToOpenApiConverter, OpenAPIToolset} from '@google/adk';

const converter = new GoogleApiToOpenApiConverter('calendar', 'v3');
const spec = await converter.convert();

const toolset = new OpenAPIToolset({specDict: spec});
const tools = await toolset.getTools();
```

`convert()` fetches the document the first time you call it and reuses it
afterwards, so calling it twice issues one request.

To keep the result, write it to a file:

```ts
await converter.saveOpenApiSpec('calendar_openapi.json');
```

`saveOpenApiSpec` writes what the converter holds right now, as JSON indented by
two spaces. Call `convert()` first, or you write an empty OpenAPI 3.0 skeleton.

The `adk` command line does the same thing in one step:

```console
$ adk convert-google-api calendar v3 --output calendar_openapi.json
```

`--output` defaults to `openapi_spec.json`. The command exits with status 1 when
the conversion fails.

## A private discovery service

Pass `discoveryUrl` to read the document from somewhere other than the public
service. `{api}` and `{apiVersion}` are substituted; a URL with no placeholders
is fetched as it is written. Both `https:` and `http:` URLs work.

```ts
const converter = new GoogleApiToOpenApiConverter('calendar', 'v3', {
  discoveryUrl: 'https://discovery.internal.example.com/{api}/{apiVersion}',
});
```

## Mutual TLS

Set `GOOGLE_API_USE_CLIENT_CERTIFICATE=true` to make the converter present a
client certificate. It then reads the SecureConnect context-aware metadata file
at `~/.secureConnect/context_aware_metadata.json`, runs the
`cert_provider_command` that file names, and presents the certificate the
command prints.

Two things change when the variable is set:

- The default discovery host becomes `www.mtls.googleapis.com`, because the
  plain host does not accept a client certificate. An explicit `discoveryUrl`
  still wins.
- The converted `servers` entry uses the document's `mtlsRootUrl` when it
  declares one.

The certificate, the key and the passphrase stay in memory. Nothing is written
to disk and nothing is logged.

The converter reads the variable once, in the constructor. Changing the
environment after that does not affect a conversion already under way.

A machine with no metadata file is the normal case, and it is not an error: the
converter falls back to a plain connection. A metadata file that exists but is
malformed, and a certificate provider that fails, both reject.

## Failure modes

`convert()` rejects, rather than returning a partial document, when:

- the discovery service answers with a non-2xx status,
- the response body is not a JSON object describing an API,
- the SecureConnect metadata is not valid JSON, or names no
  `cert_provider_command`,
- the certificate provider fails, or prints no certificate and key pair.

Every message names the API, the version and the URL or file involved. No
message carries certificate material.

## What the converter emits

- `openapi` is always `3.0.0`.
- `components.securitySchemes.apiKey` is always present. `oauth2` is added only
  when the Discovery document declares an OAuth 2.0 block, with its scopes.
- A schema that Discovery states beside a `$ref` keeps both. Discovery puts a
  field's only description there, so the converter emits `$ref` and
  `description` together rather than dropping one.
- Parameter values are copied, not coerced. A Discovery `default` of `"250"`
  stays the string `"250"`.
