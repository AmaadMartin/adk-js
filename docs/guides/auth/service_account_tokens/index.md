# Service account tokens for OpenAPI tools

An OpenAPI tool authenticates with a Google service account when you give it a
`SERVICE_ACCOUNT` credential. The exchanger turns that configuration into a
bearer token on every call. Reach for it when the API behind the tool is a
Google API, a Cloud Run service, or a Cloud Function.

## Introduction

An OpenAPI tool calls a real HTTP endpoint, so it needs a credential the
endpoint accepts. `ServiceAccountCredentialExchanger` produces one. You declare
what the tool needs, and the exchanger mints the token before each request.

Two kinds of token exist, and they are not interchangeable.

- An **access token** proves what you may do. Google APIs such as BigQuery
  check it against the scopes you asked for.
- An **ID token** proves who you are. Cloud Run and Cloud Functions check the
  `aud` claim against their own URL, and reject an access token.

Set `useIdToken` to choose the second kind. The exchanger reads the key from
`serviceAccountCredential`, or from application default credentials when
`useDefaultCredential` is true.

Two behaviours come with the exchange. On the default-credentials access-token
path the exchanger resolves a quota project and sends it as the
`x-goog-user-project` header, so the call bills the project you expect. Every
minted token is also cached, keyed on the configuration that produced it, so a
tool called repeatedly does not mint a token per call.

## Get started

This toolset calls a BigQuery-style API with an access token from application
default credentials. Run `gcloud auth application-default login` first.

The spec has to declare a security scheme, and the operation has to require it.
An operation that needs no authentication never asks for a credential, so the
exchange never runs and the request goes out with no `Authorization` header.
Pass `authScheme` to the toolset when your spec declares no scheme.

```ts
import {
  AuthCredentialTypes,
  OpenAPIToolset,
  type AuthCredential,
} from '@google/adk';

const spec = JSON.stringify({
  openapi: '3.0.0',
  info: {title: 'Datasets', version: '1.0.0'},
  servers: [{url: 'https://bigquery.googleapis.com/bigquery/v2'}],
  components: {
    securitySchemes: {
      google: {
        type: 'oauth2',
        flows: {
          authorizationCode: {
            authorizationUrl: 'https://accounts.google.com/o/oauth2/auth',
            tokenUrl: 'https://oauth2.googleapis.com/token',
            scopes: {
              'https://www.googleapis.com/auth/bigquery':
                'Manage BigQuery data.',
            },
          },
        },
      },
    },
  },
  security: [{google: ['https://www.googleapis.com/auth/bigquery']}],
  paths: {
    '/projects/{projectId}/datasets': {
      get: {
        operationId: 'listDatasets',
        parameters: [
          {
            name: 'projectId',
            in: 'path',
            required: true,
            schema: {type: 'string'},
          },
        ],
        responses: {'200': {description: 'The datasets of the project.'}},
      },
    },
  },
});

const authCredential: AuthCredential = {
  authType: AuthCredentialTypes.SERVICE_ACCOUNT,
  serviceAccount: {
    useDefaultCredential: true,
    scopes: ['https://www.googleapis.com/auth/bigquery'],
  },
};

const toolset = new OpenAPIToolset({specStr: spec, authCredential});
```

A tool from this toolset sends `Authorization: Bearer <access token>`. It also
sends `x-goog-user-project` when a quota project is resolved.

## Calling a Cloud Run service

Cloud Run verifies the caller's identity, so it needs an ID token whose `aud`
claim is the service URL. Set `useIdToken` and `audience` together.

```ts
import {AuthCredentialTypes, type AuthCredential} from '@google/adk';

const authCredential: AuthCredential = {
  authType: AuthCredentialTypes.SERVICE_ACCOUNT,
  serviceAccount: {
    useDefaultCredential: true,
    useIdToken: true,
    audience: 'https://my-service.run.app',
  },
};
```

An explicit key works the same way. Supply `serviceAccountCredential` instead of
`useDefaultCredential`.

```ts
import {
  AuthCredentialTypes,
  type AuthCredential,
  type ServiceAccountCredential,
} from '@google/adk';

declare const key: ServiceAccountCredential;

const authCredential: AuthCredential = {
  authType: AuthCredentialTypes.SERVICE_ACCOUNT,
  serviceAccount: {
    serviceAccountCredential: key,
    useIdToken: true,
    audience: 'https://my-service.run.app',
  },
};
```

## The quota project header

A Google API bills each call to a project. Application default credentials
carry the project to bill, either on the credentials themselves or as the
ambient project of the environment. The exchanger resolves it and puts it on
the exchanged credential as `additionalHeaders['x-goog-user-project']`, and the
tool sends that header with the request.

The header appears only on the default-credentials access-token path. An
explicit key already names its project, and an ID token carries no quota
project. A machine with no ambient project still gets a token, with no header.

## The token cache

The exchanger caches every token it mints in a module-level map. A cached token
is reused until 300 seconds before it expires, which leaves a margin for the
call it is used on. The expiry comes from the token endpoint, or from the `exp`
claim of an ID token; a token that carries neither is cached for one hour.

The cache key covers `useDefaultCredential`, `scopes`, `useIdToken`,
`audience`, and the key's `clientEmail` and `privateKeyId`. Two configurations
that differ in any of these never share a token. The cache holds 100 entries
and evicts the oldest one when it is full.

The cache is per module, not per exchanger, so two runners in one process share
it.

## Errors

| Condition                                                | Error                        |
| -------------------------------------------------------- | ---------------------------- |
| The credential is not a service account credential       | `CredentialExchangeError`    |
| The credential carries no `serviceAccount`               | `AuthCredentialMissingError` |
| `useIdToken` is set and `audience` is not                | `InputValidationError`       |
| No key, and `useDefaultCredential` is not set            | `AuthCredentialMissingError` |
| An explicit key declares no `scopes` for an access token | `AuthCredentialMissingError` |
| The token endpoint rejects the exchange                  | `AuthCredentialMissingError` |

`AuthCredentialMissingError` and `CredentialExchangeError` are unrelated
classes. A `catch` on one does not catch the other.
