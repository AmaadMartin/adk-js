# Authenticated tools

A tool that calls a third-party API on the user's behalf declares an
`AuthConfig`. `AuthenticatedFunctionTool` and `BaseAuthenticatedTool` resolve
the credential before the tool body runs, and return a placeholder while the
client collects one.

## Introduction

A tool that reads someone's calendar or mailbox needs a credential belonging to
that person. Only the end user can grant it, and granting it means leaving the
agent: opening a consent screen and coming back with a redirect. That round trip
cannot happen inside a tool call. So the tool declares what it needs, returns
`'Pending User Authorization.'`, and parks an auth request that the client
answers. The next call finds the credential and runs the tool body.

`AuthConfig` pairs two things. `authScheme` says how the API authenticates, and
is the OpenAPI security scheme (`apiKey`, `http`, `oauth2`, `openIdConnect`).
`rawAuthCredential` is what you configured, such as an OAuth client id and
secret, or the API key itself.

Both tool classes delegate to `CredentialManager`, which owns the credential
lifecycle: it validates the config, reads the credential service, picks up an
auth response, exchanges a service-account credential for an access token,
refreshes an expired OAuth2 token, and writes the result back. Reach for
`AuthenticatedFunctionTool` when your tool is a function, and
`BaseAuthenticatedTool` when it is a class. Use a plain `FunctionTool` with
`Context.requestCredential` only when you need to drive the handshake yourself.

## Get started

This tool needs an API key. The key is configured, so nothing pauses: the
function receives the credential on the first call.

```ts
import {AuthCredentialTypes, AuthenticatedFunctionTool} from '@google/adk';
import {z} from 'zod';

const listDocuments = new AuthenticatedFunctionTool({
  name: 'list_documents',
  description: 'Lists the documents in a folder.',
  parameters: z.object({folder: z.string()}),
  authConfig: {
    authScheme: {
      type: 'apiKey',
      in: 'header',
      name: 'X-Api-Key',
    },
    rawAuthCredential: {
      authType: AuthCredentialTypes.API_KEY,
      apiKey: process.env.DOCUMENTS_API_KEY,
    },
    credentialKey: 'documents_api',
  },
  execute: async ({folder}, toolContext, credential) => {
    const response = await fetch(
      `https://api.example.com/folders/${folder}/documents`,
      {headers: {'X-Api-Key': credential?.apiKey ?? ''}},
    );
    return response.json();
  },
});
```

The model never sees the credential. `AuthenticatedFunctionTool` builds its
function declaration from `parameters` alone, so the declaration above holds
only `folder`.

A class-based tool implements `runAsyncImpl` instead:

```ts
import {AuthenticatedRunRequest, BaseAuthenticatedTool} from '@google/adk';

class ListDocumentsTool extends BaseAuthenticatedTool {
  protected override async runAsyncImpl({
    args,
    credential,
  }: AuthenticatedRunRequest): Promise<unknown> {
    return fetchDocuments(args, credential?.apiKey);
  }
}
```

## The pause for consent

An OAuth2 scheme needs the end user. On the first call `CredentialManager` finds
no credential, so the tool calls `Context.requestCredential(authConfig)` and
returns `PENDING_USER_AUTHORIZATION`, the string `'Pending User
Authorization.'`. Pass `responseForAuthRequired` to return a different value —
an object or a string.

`requestCredential` writes an auth request into
`eventActions.requestedAuthConfigs`, keyed by the id of the waiting tool call.
The request carries the authorization URL in
`exchangedAuthCredential.oauth2.authUri`. The client sends the user there and
answers with the redirect it lands on. `AuthPreprocessor` then stores the
credential, and the next call to the tool runs the body with it.

`requestCredential` throws when the context has no `functionCallId`, so this
path only works from inside a tool call.

## Where the credential is kept

Without a credential service, a granted credential lasts one invocation and the
user consents again on the next turn. Pass a `credentialService` to the
`Runner` — `InMemoryCredentialService` or `SessionStateCredentialService` — and
`CredentialManager` saves the credential under `credentialKey`, scoped to the
app and the user. Later calls load it from there, and refresh an expired OAuth2
token rather than prompting again.

## Configuration options

| Option                               | Type                                | Default                         | Description                                                                                                                       |
| ------------------------------------ | ----------------------------------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `authConfig.authScheme`              | `AuthScheme`                        | _required_                      | How the API authenticates. An `oauth2` scheme carries the authorization and token URLs the authorization URL is built from.       |
| `authConfig.rawAuthCredential`       | `AuthCredential`                    | none                            | What you configured. Required for an `oauth2` or `openIdConnect` scheme, and an `OAUTH2` credential must carry an `oauth2` field. |
| `authConfig.exchangedAuthCredential` | `AuthCredential`                    | none                            | The working copy ADK fills in. Leave it unset when you construct the config.                                                      |
| `authConfig.credentialKey`           | `string`                            | _required_                      | The key the credential is stored under in the credential service.                                                                 |
| `responseForAuthRequired`            | `Record<string, unknown> \| string` | `'Pending User Authorization.'` | What the tool returns while the client collects the credential.                                                                   |

## Failure modes and limits

- **Experimental.** `CredentialManager`, `BaseAuthenticatedTool` and
  `AuthenticatedFunctionTool` are experimental, and warn once on first use.
  Their APIs may change without a major release.
- **Errors surface differently between the two classes.**
  `BaseAuthenticatedTool` lets a credential error propagate unchanged.
  `AuthenticatedFunctionTool` inherits `FunctionTool`'s contract, which wraps any
  error from the tool body as `Error in tool '<name>': <message>`.
- **A missing tool context is an error.** `AuthenticatedFunctionTool` throws when
  it has an `authConfig` but the call carries no `Context`.
- **Confirmation runs first.** A tool with `requireConfirmation` asks for
  approval before it requests any credential, so a rejected call never triggers
  a consent flow.
- **No OAuth2 exchanger is registered.** `AuthHandler` already trades the
  authorization code for a token, so `Context.getAuthResponse` returns an
  exchanged credential.
