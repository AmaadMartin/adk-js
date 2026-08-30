# OpenAPI auth helpers

`OpenAPIToolset` and `RestApiTool` take an `authScheme` and an `authCredential`.
The auth helpers build that pair from what you already have: an API key, a
service account key file, or an OpenID Connect discovery URL. Reach for them
whenever you would otherwise hand-write a scheme object.

## Introduction

An OpenAPI operation declares a security scheme. ADK needs two things to call
it: the scheme itself, and a credential that satisfies the scheme. The two must
agree, and the agreement is easy to get wrong. A service account paired with an
HTTP bearer scheme, for example, makes the tool ask the client to authorize
interactively instead of exchanging the key it already holds.

Each factory returns both halves together, so they cannot disagree. The scheme
goes into the toolset; ADK exchanges the credential at call time and
`credentialToParam` turns the result into the request parameter the tool
injects.

Use the factory that matches your input:

| You have                              | Use                                    |
| ------------------------------------- | -------------------------------------- |
| An API key or a bearer token          | `tokenToSchemeCredential`              |
| A service account key file            | `serviceAccountDictToSchemeCredential` |
| A `ServiceAccount` you built          | `serviceAccountSchemeCredential`       |
| An OpenID Connect discovery URL       | `openidUrlToSchemeCredential`          |
| A static OpenID Connect configuration | `openidDictToSchemeCredential`         |

## Get started

An API key that travels in a header:

```ts
import {OpenAPIToolset, tokenToSchemeCredential} from '@google/adk';

const {authScheme, authCredential} = tokenToSchemeCredential(
  'apikey',
  'header',
  'X-API-Key',
  process.env.API_KEY,
);

const toolset = new OpenAPIToolset({specStr, authScheme, authCredential});
```

Pass `'oauth2Token'` instead of `'apikey'` for a bearer token. The location and
the name are then ignored, because a bearer token always travels in the
`Authorization` header.

## Service accounts

`serviceAccountDictToSchemeCredential` reads a key file as Google writes it.
The keys may be snake_case or camelCase.

```ts
import {readFile} from 'node:fs/promises';
import {serviceAccountDictToSchemeCredential} from '@google/adk';

const key = JSON.parse(await readFile(keyPath, 'utf8'));
const {authScheme, authCredential} = serviceAccountDictToSchemeCredential(key, [
  'https://www.googleapis.com/auth/cloud-platform',
]);
```

Both service account factories return an OAuth2 client-credentials scheme. That
is deliberate: a credential manager exchanges a raw service account on its own
only for a client-credentials flow. The token URL in the scheme is a
placeholder, because the exchange goes through Application Default Credentials
or a JWT assertion and never calls it.

The key file must carry all eleven fields of `ServiceAccountCredential`. A file
that is missing one raises an error naming the field, rather than failing later
during the token exchange.

## OpenID Connect

`openidUrlToSchemeCredential` fetches the provider's discovery document and
builds the scheme from it.

```ts
import {openidUrlToSchemeCredential} from '@google/adk';

const {authScheme, authCredential} = await openidUrlToSchemeCredential(
  'https://accounts.example.com/.well-known/openid-configuration',
  ['openid', 'email'],
  {client_id: process.env.CLIENT_ID, client_secret: process.env.CLIENT_SECRET},
);
```

The `scopes` argument overrides any scopes the document declares. The request
times out after 10 seconds and does not follow a redirect, so a discovery
endpoint must answer directly.

The client argument accepts a client secret file downloaded from the Google
Cloud console. Such a file nests the client under a single `web` or `installed`
key, and the factory unwraps it. Only the singular `redirect_uri` is read.

Use `openidDictToSchemeCredential` when you hold the configuration already and
want no network call. It takes the same arguments, with the document in place
of the URL.

## Failure modes

Every factory throws an `Error` rather than returning a partly built pair.

| Condition                                                 | Message                                                                    |
| --------------------------------------------------------- | -------------------------------------------------------------------------- |
| An API key location other than header, query or cookie    | `Invalid location for apiKey: <location>`                                  |
| An API key scheme with no name                            | `Missing name for apiKey scheme`                                           |
| A service account key file missing a field                | `Invalid service account configuration: <fields>`                          |
| An OpenID Connect configuration with no endpoints         | `Invalid OpenID Connect configuration: <fields>`                           |
| A client with no id or no secret                          | `Missing required fields in credentialDict: <fields>`                      |
| Discovery fails, or answers with a non-2xx status         | `Failed to fetch OpenID configuration from <url>: <reason>`                |
| Discovery answers with something other than a JSON object | `Invalid JSON response from OpenID configuration endpoint <url>: <reason>` |
