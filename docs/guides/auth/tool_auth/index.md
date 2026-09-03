# Authenticated tools

A tool that calls a third-party API on the user's behalf declares an
`AuthConfig`. `BaseAuthenticatedTool` resolves the credential before the tool
body runs, and asks the client for one when there is none yet.

## Introduction

A tool that reads someone's calendar or mailbox needs a credential belonging to
that person. Only the end user can grant it, and granting it means leaving the
agent: opening a consent screen and returning with a redirect. That round trip
cannot happen inside a single tool call, so ADK splits the call in two. The
first call returns a placeholder and records a request for credentials. The
client runs the consent flow, and the next call runs the tool body with the
credential.

Two pieces describe what a tool needs, and `AuthConfig` pairs them:

- `AuthScheme` says how the API authenticates: an OpenAPI security scheme
  (`apiKey`, `http`, `oauth2`, `openIdConnect`) or `OpenIdConnectWithConfig`.
- `AuthCredential` is the secret. `authType` picks the shape (`API_KEY`,
  `HTTP`, `OAUTH2`, `OPEN_ID_CONNECT`, `SERVICE_ACCOUNT`) and the matching
  field holds it.

`BaseAuthenticatedTool` delegates the whole lifecycle to `CredentialManager`,
which validates the configuration, reads a stored credential, exchanges or
refreshes it, and saves the result. Reach for the base class when your tool
calls an authenticated API. Extend `BaseTool` directly when it does not.

## Get started

This tool reads an API key. An API key needs no consent round trip, so the
first call already receives the credential.

```ts
import {
  AuthConfig,
  AuthCredentialTypes,
  AuthenticatedRunAsyncToolRequest,
  BaseAuthenticatedTool,
} from '@google/adk';

const authConfig: AuthConfig = {
  authScheme: {type: 'apiKey', in: 'header', name: 'X-Api-Key'},
  rawAuthCredential: {
    authType: AuthCredentialTypes.API_KEY,
    apiKey: process.env.DOCUMENTS_API_KEY ?? '',
  },
  credentialKey: 'documents_api',
};

class ListDocumentsTool extends BaseAuthenticatedTool {
  constructor() {
    super({
      name: 'list_documents',
      description: 'Lists the documents in a folder.',
      authConfig,
    });
  }

  protected override async runAsyncImpl({
    args,
    credential,
  }: AuthenticatedRunAsyncToolRequest): Promise<unknown> {
    const response = await fetch(
      `https://provider.example.com/folders/${args['folder']}`,
      {headers: {'X-Api-Key': credential?.apiKey ?? ''}},
    );
    return response.json();
  }
}
```

An OAuth2 tool uses the same shape with an OAuth2 scheme. Its first call
returns `'Pending User Authorization.'` and records a request on the
invocation's event actions, so the client can run the consent flow. Give the
runner a credential service, such as `InMemoryCredentialService`, so the
credential survives to the next call.

## How it works

`runAsync` asks `CredentialManager.getAuthCredential`. When a credential comes
back, the tool calls `runAsyncImpl` with it. When none does, the tool asks the
client for one and returns the pending response without running your code.

`getAuthCredential` walks a fixed order:

1. It validates the configuration. An OAuth2 or OpenID Connect scheme needs a
   raw credential, an OAuth2 credential needs its `oauth2` block, and a
   declared OAuth2 flow needs its URLs.
2. An API key or HTTP credential is already usable, so a copy of it is
   returned and nothing else runs.
3. Otherwise it reads the credential service, then the client's auth response
   in session state.
4. With still nothing, a client-credentials scheme falls back to the raw
   credential. Any other scheme resolves to `undefined`, which is what makes
   the tool ask the client.
5. It exchanges the credential, or refreshes it when no exchange happened.
6. A credential that came from the client, an exchange or a refresh is saved
   through the credential service.

A service account credential is minted per call, so step 3 and step 6 skip it.
The manager copies the credential before an exchange mutates it, and saves a
copy of the auth config, so one user's token never lands on the config another
invocation reads.

## Configuration options

| Option                    | Type                                | Default                         | Description                                                                                                                                              |
| ------------------------- | ----------------------------------- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`                    | `string`                            | _required_                      | The tool name the model calls.                                                                                                                           |
| `description`             | `string`                            | _required_                      | What the tool does.                                                                                                                                      |
| `authConfig`              | `AuthConfig`                        | none                            | The scheme and raw credential. Without it, or without a scheme in it, the tool runs unauthenticated and `runAsyncImpl` receives `credential: undefined`. |
| `responseForAuthRequired` | `Record<string, unknown> \| string` | `'Pending User Authorization.'` | Returned while the client is being asked for a credential. An empty string or an empty object counts as unset.                                           |

`AuthConfig` itself carries `authScheme`, the optional `rawAuthCredential` and
`exchangedAuthCredential`, and `credentialKey`, the key the credential is
stored under.

## Limitations

- `BaseAuthenticatedTool` and `CredentialManager` are experimental. They warn
  once on first use and their APIs may change.
- Requesting a credential needs a `functionCallId`, so the pending path only
  works inside a tool call.
- Session state is not a secret store. `SessionStateCredentialService` puts
  tokens wherever session state lives.
