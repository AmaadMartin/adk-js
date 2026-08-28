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

`AuthConfig` pairs an `AuthScheme`, which says how the API authenticates, with
an `AuthCredential`, which holds the secret. `AuthenticatedFunctionTool` takes
one and delegates to `CredentialManager`. `AuthPreprocessor` pauses the
invocation and later resumes the waiting call, and a `BaseCredentialService`
remembers the credential between turns.

## Get started

The model only ever sees `folder`. The framework supplies `credential` as a
third argument, and the declaration the model reads comes from `parameters`.

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
    const accessToken = credential.oauth2?.accessToken;
    // Call the provider's API with accessToken here.
    return [`${folder}/report.pdf`];
  },
});

const runner = new Runner({
  appName: 'documents_app',
  agent: new LlmAgent({
    name: 'documents_agent',
    model: 'gemini-2.0-flash',
    instruction: 'Use list_documents to answer questions about the user files.',
    tools: [listDocuments],
  }),
  sessionService: new InMemorySessionService(),
  credentialService: new InMemoryCredentialService(),
});
```

Pass a `credentialService` to the `Runner`, as above. Without one the credential
lives only for the current invocation, and the next turn asks for consent again.

## The pause and resume

`CredentialManager` returns a usable raw credential, an API key or an HTTP
credential, straight away and nothing pauses. Otherwise it reads the credential
service, then the auth response in session state, then checks for a
client-credentials flow that needs no user. An authorization-code flow with
nothing stored yields nothing, and the tool pauses:

1.  The tool returns `responseForAuthRequired`, by default
    `"Pending User Authorization."`, instead of running your function. The flow
    emits one long-running function call named `adk_request_credential` and ends
    the invocation.
2.  Read `auth_config.exchangedAuthCredential.oauth2.authUri` from that call's
    arguments, send the user there, and collect the redirect.
3.  Resume with a new run whose message is a user `Content` holding a
    `FunctionResponse` named `adk_request_credential`. Its id must be the id of
    that call, not of the tool call waiting on it. Fill the answer into
    `exchangedAuthCredential.oauth2`: either `authResponseUri`, the full
    redirect URL, or `authCode`.
4.  `AuthPreprocessor` exchanges the code for a token, stores the credential
    under `temp:<credentialKey>`, and re-executes the waiting tool call.
    `CredentialManager` then saves the credential to the credential service, so
    later calls load it from there and refresh an expired token rather than
    prompting again.

The resume only works when that `FunctionResponse` is the most recent event with
content and is authored by `user`. That is the only event `AuthPreprocessor`
reads.

## Ordering

The tool resolves the credential after `FunctionTool` validates the arguments
and after the `requireConfirmation` gate. A call with invalid arguments, or one
the user rejected, never starts a consent flow. An error raised while resolving
surfaces as `Error in tool '<name>': <message>`, like any other tool failure.

## Limitations

- **Experimental.** `AuthenticatedFunctionTool`, `CredentialManager` and the
  credential exchangers warn once on first use, and their APIs may change.
- **The OAuth2 token endpoint must be public HTTPS.** `fetchOAuth2Tokens`
  refuses plain HTTP, and refuses any private, loopback or cloud-metadata
  address. A local provider cannot be used.
- **`CredentialManager` does not discover OAuth server metadata.** Give the
  scheme its authorization and token URLs. A flow that declares one without
  the URL it needs is rejected.
- **Session state is not a secret store.** `SessionStateCredentialService`
  puts tokens wherever session state lives.
