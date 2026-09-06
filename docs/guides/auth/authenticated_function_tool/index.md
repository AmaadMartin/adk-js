# AuthenticatedFunctionTool

`AuthenticatedFunctionTool` is a `FunctionTool` that resolves a credential
before it runs your function. Reach for it when the function calls a
third-party API on the end user's behalf.

## Introduction

A tool that reads someone's calendar or documents needs a credential that
belongs to that person. Only the user can grant it, and granting it means
leaving the agent for a consent screen. That round trip cannot happen inside a
tool call, so ADK models it as a pause. The tool returns a placeholder and
records what it needs, the application runs the consent flow, and the next run
executes the same call with the credential in hand.

Three pieces describe the credential:

- `AuthScheme` says how the API expects to be authenticated. It is an OpenAPI
  security scheme (`apiKey`, `http`, `oauth2`, `openIdConnect`) or an
  `OpenIdConnectWithConfig`.
- `AuthCredential` is the secret. `authType` picks the shape (`API_KEY`,
  `HTTP`, `OAUTH2`, `OPEN_ID_CONNECT`, `SERVICE_ACCOUNT`) and the matching
  field holds it.
- `AuthConfig` pairs the two and adds a `credentialKey`, which names the
  credential in a `BaseCredentialService`.

`AuthenticatedFunctionTool` owns a `CredentialManager` for its `AuthConfig`.
The manager resolves the credential; the tool decides whether to run the
function or to pause.

## Get started

Declare a `credential` parameter to receive the resolved credential. The model
never sees that parameter.

```ts
import {
  AuthConfig,
  AuthCredential,
  AuthCredentialTypes,
  AuthenticatedFunctionTool,
} from '@google/adk';
import {z} from 'zod/v3';

const authConfig: AuthConfig = {
  credentialKey: 'documents-api',
  authScheme: {
    type: 'oauth2',
    flows: {
      authorizationCode: {
        authorizationUrl: 'https://provider.example.com/authorize',
        tokenUrl: 'https://provider.example.com/token',
        scopes: {'documents.read': 'Read your documents'},
      },
    },
  },
  rawAuthCredential: {
    authType: AuthCredentialTypes.OAUTH2,
    oauth2: {
      clientId: process.env.DOCUMENTS_CLIENT_ID,
      clientSecret: process.env.DOCUMENTS_CLIENT_SECRET,
    },
  },
};

const listDocuments = new AuthenticatedFunctionTool({
  name: 'list_documents',
  description: 'Lists the documents in a folder.',
  parameters: z.object({
    folder: z.string(),
    credential: z.custom<AuthCredential>().optional(),
  }),
  authConfig,
  execute: async ({folder, credential}) =>
    fetchDocuments(folder, credential?.oauth2?.accessToken),
});
```

Give the runner a credential service, so a granted credential survives between
turns:

```ts
import {
  InMemoryCredentialService,
  InMemorySessionService,
  Runner,
} from '@google/adk';

const runner = new Runner({
  appName: 'documents-agent',
  agent,
  sessionService: new InMemorySessionService(),
  credentialService: new InMemoryCredentialService(),
});
```

## How the credential is resolved

`CredentialManager.getAuthCredential` tries these sources in order, and stops
at the first that answers:

1.  The raw credential itself, when it is an `API_KEY` or an `HTTP` credential.
    Nothing has to be exchanged, so a copy of it is returned.
2.  The credential service, under `authConfig.credentialKey`.
3.  The auth response the client sent back from a consent flow.
4.  The raw credential again, when the scheme uses the client-credentials
    flow. That flow authenticates the application, so no user is involved.

Nothing left to try means the tool needs the user. It calls
`context.requestCredential(authConfig)` and returns
`responseForAuthRequired`, which defaults to `'Pending User Authorization.'`.
The function does not run.

A credential that came from step 2, 3 or 4 is then exchanged for a token when
the type requires it, or refreshed when it has expired. The manager saves the
result through the credential service, so the next call skips the handshake.

## The credential parameter

The credential reaches your function only when the declared parameters include
a `credential` property. A tool that does not declare one still gets the auth
gate; it just never receives the value.

`credential` is removed from the function declaration the model reads, from
both `properties` and `required`. A `credential` value that arrives in the call
arguments anyway is overwritten by the resolved one, so the model cannot supply
a credential of its own.

Without an `authConfig`, the tool logs a warning and behaves like a plain
`FunctionTool`. A declared `credential` parameter is then `undefined`.

## Failure modes

The manager rejects a configuration it cannot use, naming the field at fault:

- An `oauth2` or `openIdConnect` scheme with no `rawAuthCredential`.
- An `OAUTH2` or `OPEN_ID_CONNECT` credential with no `oauth2` block.
- An OAuth2 scheme that declares a flow but leaves its URL empty, for example
  `flows.authorizationCode.tokenUrl`.

A failed exchange or refresh propagates as well. It is not turned into a
pending-authorization answer, which would loop the user through consent
forever. An error thrown by your own function keeps `FunctionTool`'s wrapping:
`Error in tool '<name>': <message>`.
