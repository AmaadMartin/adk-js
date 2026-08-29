# SecretManagerClient

`SecretManagerClient` reads a secret version out of Google Cloud Secret Manager.
Reach for it when an agent needs a credential at runtime — a third-party API key,
a database password — and you do not want that value in an environment variable
or a checked-in file.

## Introduction

An agent that calls a paid API needs the key for it. Putting the key in `.env`
spreads it across every machine that runs the agent, and rotating it means
redeploying. Secret Manager holds the value once, controls who may read it with
IAM, and versions it, so rotation is a new version rather than a new deployment.

This is a plain client, not a tool, so the model never sees the secret. Your own
code fetches the value and passes it to whatever needs it. It authenticates the
same three ways the rest of ADK does, and it adds no dependency: it uses
`GoogleAuth` from `google-auth-library`, which ADK already requires, rather than
`@google-cloud/secret-manager`.

## Get started

Grant your identity the `secretmanager.versions.access` permission on the
secret, then read it. With no options, the client uses Application Default
Credentials.

```ts
import {SecretManagerClient} from '@google/adk';

const client = new SecretManagerClient();

const apiKey = await client.getSecret(
  'projects/my-project/secrets/my-api-key/versions/latest',
);
```

## Choosing a credential

Pass at most one of `serviceAccountJson` and `authToken`; the constructor throws
if you pass both.

```ts
const client = new SecretManagerClient({authToken: token});
```

Prefer Application Default Credentials or a service account key for anything
long-running. An `authToken` is used as-is and is never refreshed, so the client
stops working when that token expires.

## Regional endpoints

Secret Manager also serves regional endpoints, which keep a secret's data inside
one region.

```ts
const client = new SecretManagerClient({location: 'us-central1'});
```

The client then calls `secretmanager.us-central1.rep.googleapis.com` instead of
the global `secretmanager.googleapis.com`.

## Failure modes

The constructor throws on a bad configuration: both credential options at once,
or a `serviceAccountJson` that does not parse.

Everything else fails on the call, including a failure to resolve Application
Default Credentials. Python's client resolves those credentials when you
construct it, so if you are porting code from `adk-python`, expect that error one
step later here — a constructor cannot await. Secret Manager's own errors, such
as a missing secret or a denied permission, reach you unchanged.
