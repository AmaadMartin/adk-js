# AuthConfig and authenticated tools

A tool that calls a third-party API on the user's behalf declares an
`AuthConfig`. ADK pauses the run to collect the credential, then resumes the
same tool call once it arrives.

## Introduction

A tool that reads someone's calendar, mailbox, or documents needs a credential
belonging to that person. Only the end user can grant it, and granting it means
leaving the agent: opening a consent screen and coming back with a redirect.
That round trip cannot happen inside a tool call, so ADK models it as an
interruption. The tool declares what it needs and returns a placeholder, and the
invocation ends carrying a request for credentials. The application runs the
consent flow and starts a new run with the answer, and ADK re-executes the tool
call that was waiting.

Two types describe what is needed, and `AuthConfig` pairs them:

- `AuthScheme` says how the API expects to be authenticated. It is a union of
  `SecuritySchemeObject` from `openapi-types` (`apiKey`, `http`, `oauth2`,
  `openIdConnect`) and `OpenIdConnectWithConfig`.
- `AuthCredential` is the secret. `authType` picks the shape (`API_KEY`,
  `HTTP`, `OAUTH2`, `OPEN_ID_CONNECT`, `SERVICE_ACCOUNT`) and the matching
  field (`apiKey`, `http`, `oauth2`, `serviceAccount`) holds it.

`AuthenticatedFunctionTool` takes an `AuthConfig` and delegates to
`CredentialManager`. The `AuthPreprocessor` in the LLM flow pauses the
invocation and later resumes the waiting call, and a `BaseCredentialService`
remembers the credential between turns.

## Get started

This agent has one tool that needs an OAuth2 access token. The model only ever
sees `folder`: the framework supplies `credential` as a third argument, and the
declaration it builds comes from the `parameters` schema.

```ts
import {
  AuthConfig,
  AuthCredentialTypes,
  AuthenticatedFunctionTool,
  InMemoryCredentialService,
  InMemorySessionService,
  LlmAgent,
  Runner,
} from '@google/adk';
import {z} from 'zod/v4';

const authConfig: AuthConfig = {
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
      redirectUri: 'http://localhost:8080/callback',
    },
  },
  credentialKey: 'documents_api',
};

const listDocuments = new AuthenticatedFunctionTool({
  name: 'list_documents',
  description: 'Lists the documents in a folder.',
  parameters: z.object({folder: z.string()}),
  authConfig,
  execute: async ({folder}, toolContext, credential) => {
    const accessToken = credential?.oauth2?.accessToken;
    // Call the provider's API with accessToken here.
    return [`${folder}/report.pdf`];
  },
});

const agent = new LlmAgent({
  name: 'documents_agent',
  model: 'gemini-2.0-flash',
  instruction: 'Use list_documents to answer questions about the user files.',
  tools: [listDocuments],
});

const runner = new Runner({
  appName: 'documents_app',
  agent,
  sessionService: new InMemorySessionService(),
  credentialService: new InMemoryCredentialService(),
});
```

Pass a `credentialService` to the `Runner`, as above. Without one the credential
lives only for the current invocation and the next turn asks for consent again.

## How it works

1.  The tool asks `CredentialManager.getAuthCredential`. A raw credential that
    is already usable, an API key or an HTTP credential, comes back as a copy
    and nothing pauses. Otherwise the manager reads the credential service, then
    the auth response in session state, then checks whether the scheme is a
    client-credentials flow that needs no user. An authorization-code flow with
    nothing stored yields nothing.
2.  With no credential the tool calls `requestCredential` and returns
    `responseForAuthRequired`, by default the string
    `"Pending User Authorization."`, instead of running your function.
    `AuthHandler` builds the authorization URL for OAuth2 and OpenID Connect
    schemes and writes it to `exchangedAuthCredential.oauth2.authUri`, with a
    `state`.
3.  The flow emits one long-running function call named
    `adk_request_credential` per request. Its arguments are `function_call_id`,
    the waiting tool call, and `auth_config`, the config from step 2. The flow
    then ends the invocation, which is what pauses the run.
4.  Your application reads `authConfig.exchangedAuthCredential.oauth2.authUri`,
    sends the user there, and collects the redirect.
5.  You resume with a new run whose message is a user `Content` holding a
    `FunctionResponse` named `adk_request_credential`. Its id must be the id of
    that call, not of the tool call waiting on it. Its response is the config
    with the answer filled into `exchangedAuthCredential`: either
    `authResponseUri`, the full redirect URL including the code, or `authCode`.
6.  `AuthPreprocessor` matches the response to its request, exchanges the
    authorization code for a token, stores the credential under
    `temp:<credentialKey>` in session state, and re-executes the waiting tool
    call.
7.  On that re-execution `CredentialManager` finds the credential in state and
    saves it to the credential service under `credentialKey`. Later calls load
    it from there, and refresh an expired OAuth2 token rather than prompting
    again.

The resume only works when the `FunctionResponse` is the most recent event with
content and is authored by `user`. That is the only event `AuthPreprocessor`
reads.

## Ordering

`AuthenticatedFunctionTool` resolves the credential after `FunctionTool`
validates the arguments and after the `requireConfirmation` gate. A call with
invalid arguments, or one the user rejected, never starts a consent flow. An
error raised while resolving the credential surfaces as
`Error in tool '<name>': <message>`, like any other tool failure.

## Configuration options

| Option                                                                      | Type                                | Default                         | Description                                                                                                                                                        |
| --------------------------------------------------------------------------- | ----------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `execute`                                                                   | `AuthenticatedToolExecuteFunction`  | _required_                      | Runs once a credential is available. The third argument is the credential.                                                                                         |
| `authConfig`                                                                | `AuthConfig`                        | none                            | What the tool authenticates with. Without it the tool runs the function straight away, the credential argument is `undefined`, and the constructor logs a warning. |
| `responseForAuthRequired`                                                   | `Record<string, unknown> \| string` | `"Pending User Authorization."` | What the tool returns while it waits for the client.                                                                                                               |
| `name`, `description`, `parameters`, `isLongRunning`, `requireConfirmation` | see `ToolOptions`                   | as `FunctionTool`               | Unchanged.                                                                                                                                                         |

`AuthConfig` fields:

| Field                     | Type             | Default    | Description                                                                                                                                                                                                |
| ------------------------- | ---------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `authScheme`              | `AuthScheme`     | _required_ | How the API authenticates. For an authorization-code flow it carries the authorization and token URLs and the scopes.                                                                                      |
| `rawAuthCredential`       | `AuthCredential` | none       | What you configured, such as an OAuth client id and secret. Required for `oauth2` and `openIdConnect` schemes. For an API key or an HTTP credential it is the credential itself, and no consent is needed. |
| `exchangedAuthCredential` | `AuthCredential` | none       | The working copy ADK and the client fill in. Leave it unset when you build the config.                                                                                                                     |
| `credentialKey`           | `string`         | _required_ | The key the credential is stored under, scoped to the app and the user.                                                                                                                                    |

## Limitations

- **Experimental.** `AuthenticatedFunctionTool`, `CredentialManager` and the
  credential exchangers are experimental. They warn once on first use and
  their APIs may change.
- **The OAuth2 token endpoint must be public HTTPS.**
  `fetchOAuth2Tokens` refuses a plain HTTP endpoint, and refuses any private,
  loopback or cloud-metadata address. A local provider cannot be used.
- **`CredentialManager` does not discover OAuth server metadata.** Give the
  scheme its authorization and token URLs; a flow that declares one without
  the URL it needs is rejected.
- **Session state is not a secret store.** `SessionStateCredentialService`
  puts tokens wherever session state lives.
