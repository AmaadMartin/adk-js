# Authenticated tools and the credential key

A tool that calls a third-party API on the user's behalf asks for a credential
through its `AuthConfig`. ADK pauses the run to collect it, then resumes every
tool call that was waiting on the same credential key.

## Introduction

A tool that reads someone's mailbox or documents needs a credential belonging to
that person. Only the end user can grant it, and granting it means leaving the
agent for a consent screen. That round trip cannot happen inside a tool call, so
ADK turns it into an interruption: the tool calls
`Context.requestCredential(authConfig)` and returns a placeholder, and the
invocation ends carrying an `adk_request_credential` call. The application runs
the consent flow and starts a new run with the answer. `AuthPreprocessor` then
stores the credential and re-executes the waiting tool call.

`AuthConfig.credentialKey` is what makes that work for more than one tool. It
names the credential, not the call, so several tools backed by one OAuth2 client
share a key. A model turn often issues several such calls at once — list, read,
write — and each one raises its own credential request. The user answers **one**
of them. Because they share a key, one answer authorizes them all, and
`AuthPreprocessor` resumes all of them in a single pass. Give two tools
different keys and they stay independent: answering one leaves the other
pending.

Two rules bound that widening, and both matter if you are reasoning about what a
credential can reach.

- A credential is only ever stored against a request the agent itself raised,
  rebuilt from that request. A client's response supplies the credential
  material and nothing else — not the scheme, not the client identity, not the
  key.
- Only calls recorded alongside a call that was directly answered are widened
  into. An older, superseded request for the same key is not resurrected.

Branches scope all of this. A sub-agent running on `root.a@1` cannot see a
credential request raised on the sibling branch `root.b@1`, so it cannot store
against it or resume it. Events with no branch, and events on an ancestor
branch, stay visible.

## Get started

This agent has two tools behind one OAuth2 client. Both declare the same
`credentialKey`, so the user authorizes once and both calls resume.

```ts
import {
  AuthConfig,
  AuthCredentialTypes,
  Context,
  FunctionTool,
  LlmAgent,
} from '@google/adk';

const DOCUMENTS_AUTH: AuthConfig = {
  credentialKey: 'documents_api',
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
};

function documentsTool(name: string, description: string): FunctionTool {
  return new FunctionTool({
    name,
    description,
    execute: async (input: string, context?: Context) => {
      const credential = context?.getAuthResponse(DOCUMENTS_AUTH);
      if (!credential) {
        context?.requestCredential(DOCUMENTS_AUTH);
        return {status: 'awaiting authorization'};
      }
      return {token: credential.oauth2?.accessToken, input};
    },
  });
}

export const agent = new LlmAgent({
  name: 'documents_agent',
  model: 'gemini-2.5-flash',
  tools: [
    documentsTool('listFiles', 'Lists the documents in a folder.'),
    documentsTool('readFile', 'Reads one document.'),
  ],
});
```

`getAuthResponse` returns nothing on the first call, so the tool asks for the
credential and returns a placeholder. After the consent round trip the same call
runs again, this time with a credential.

## What the preprocessor guarantees

- **One answer resumes every call sharing the key.** The resume set is the
  calls directly answered, plus the calls recorded next to them that await an
  authorized key.
- **The widening does not cascade.** ADK selects the events to read before it
  widens, so a call added by the widening cannot pull in a further event.
- **A toolset credential is never a resume target.** A request whose function
  call id starts with `_adk_toolset_auth_` authorizes its key but resumes no
  call, because it belongs to tool listing rather than to a tool call.
- **The branch is a boundary.** A parallel sibling branch's requests,
  responses and calls are invisible.

## Failure modes

A credential response that ADK cannot match to a request this agent raised is
skipped with a warning, and so is a response carrying no credential material.
Neither ends the invocation: the remaining responses are still processed. A tool
whose credential never arrives keeps returning its placeholder, so make that
placeholder something the model can report.
