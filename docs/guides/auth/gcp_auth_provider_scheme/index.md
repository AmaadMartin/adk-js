# GcpAuthProviderScheme

`GcpAuthProviderScheme` names a Google Cloud auth provider resource inside an
`AuthConfig`. Reach for it when a toolset calls a third-party API and you want
Google Cloud to run the OAuth flow instead of writing one yourself.

## Introduction

An `AuthConfig` carries an `AuthScheme`. The OpenAPI 3.0 schemes describe an
OAuth flow field by field: the endpoints, the grant type, the scopes. A Google
Cloud auth provider needs none of that, because the flow already lives in the
provider resource. All ADK has to carry is the resource name.

`CustomAuthScheme` is the base for a scheme outside the OpenAPI 3.0 set. It
declares a single `type` field, and each extending interface fixes that field to
its own literal. `AuthScheme` admits any such scheme, so a
`GcpAuthProviderScheme` goes into an `AuthConfig` directly:

```ts
import {AuthConfig, GcpAuthProviderScheme} from '@google/adk';

const authScheme: GcpAuthProviderScheme = {
  type: 'gcpAuthProviderScheme',
  name: 'projects/my-project/locations/global/authProviders/jira',
};

const authConfig: AuthConfig = {authScheme, credentialKey: 'jira'};
```

The scheme is a description, not a client. `GcpAuthProvider` is the piece that
reads it and returns a credential — see
[GcpAuthProvider and Agent Identity credentials](../gcp_agent_identity/index.md).
`AgentRegistry.getMcpToolset` also builds a scheme in this shape when a registry
binding names an auth provider.

## Get started

The `type` literal and the resource `name` are the whole minimum. This is a
two-legged configuration: the agent acts as itself, and no user consents to
anything.

```ts
import {GcpAuthProviderScheme} from '@google/adk';

const twoLegged: GcpAuthProviderScheme = {
  type: 'gcpAuthProviderScheme',
  name: 'projects/my-project/locations/global/authProviders/spotify-2lo',
};
```

Add `scopes` and `continueUri` for a three-legged configuration, where the agent
acts on behalf of a user who grants consent:

```ts
import {GcpAuthProviderScheme} from '@google/adk';

const threeLegged: GcpAuthProviderScheme = {
  type: 'gcpAuthProviderScheme',
  name: 'projects/my-project/locations/global/authProviders/spotify-3lo',
  scopes: ['user-read-private'],
  continueUri: 'https://my-agent.example.com/auth/continue',
};
```

## Fields

| Field         | Required | Meaning                                        |
| ------------- | -------- | ---------------------------------------------- |
| `type`        | yes      | Always `'gcpAuthProviderScheme'`.              |
| `name`        | yes      | The auth provider resource to use.             |
| `scopes`      | no       | The OAuth2 scopes to request.                  |
| `continueUri` | no       | Where the user lands after consent. See below. |

The `type` literal is the discriminator. It is also the key you register the
provider under, so it must match on both sides:

```ts
import {AuthProviderRegistry, GcpAuthProvider} from '@google/adk';

const registry = new AuthProviderRegistry();
registry.register('gcpAuthProviderScheme', new GcpAuthProvider());
```

## What continueUri is for

`continueUri` is a redirect URI, and it is not the standard OAuth2 one. It
re-authenticates the user to prevent a phishing attack, and it finalises the
managed OAuth flow. The Google-hosted OAuth2 redirect URI sends the user on to
it. The agent includes the URI in every three-legged request it sends to the
upstream Agent Identity Credentials service.

You host the URI, not Google. Serve it wherever the agent client's web server
runs. A two-legged configuration never redirects a user, so it does not need
one.

## Differences from adk-python

The Python class is a pydantic model and this is a TypeScript interface, so two
things do not carry over.

`type` has no default. Python's `GcpAuthProviderScheme(name=...)` fills the
literal in; here every construction site writes it.

Python's model config sets `extra="allow"`, which keeps fields the model does
not declare. The interface drops them, because preserving them would need an
index signature that turns off type checking for every consumer.
