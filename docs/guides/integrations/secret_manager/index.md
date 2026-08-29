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

This client covers one operation: read a secret version and return its payload.
It authenticates the same three ways the rest of ADK does — the contents of a
service account key, an access token you already hold, or Application Default
Credentials. It is a plain client and not a tool, so the model never sees the
secret; your own code fetches the value and passes it to whatever needs it.

The client uses `GoogleAuth` from `google-auth-library`, which ADK already
depends on. It does not pull in `@google-cloud/secret-manager`.

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

`getSecret` takes the full resource name of a secret _version_, in the form
`projects/{project}/secrets/{secret}/versions/{version}`. Use `latest` for the
current version, or a number to pin one. The returned string is the payload
decoded as UTF-8.

## Credentials

Pass at most one credential option. The client throws if you pass both.

```ts
// The contents of a service account key file, not a path to one.
const client = new SecretManagerClient({
  serviceAccountJson: process.env.MY_SERVICE_ACCOUNT_JSON,
});

// An access token you obtained elsewhere.
const client = new SecretManagerClient({authToken: token});
```

An `authToken` is used as-is and is never refreshed, so the client stops working
when that token expires. Prefer Application Default Credentials or a service
account key, which both refresh on their own.

## Regional endpoints

Secret Manager also serves regional endpoints, which keep a secret's data inside
one region. Set `location` to send requests there.

```ts
const client = new SecretManagerClient({location: 'us-central1'});
```

The client then calls `secretmanager.us-central1.rep.googleapis.com` instead of
the global `secretmanager.googleapis.com`. The mTLS variant of the regional
endpoint is not supported.

## Errors

The constructor throws immediately if you pass both `serviceAccountJson` and
`authToken`, or if `serviceAccountJson` does not parse as a JSON object.

Everything else fails on the call. `getSecret` rejects if Application Default
Credentials cannot be resolved, and it lets Secret Manager's own errors through
unchanged — a missing secret or a denied permission arrives as the API reported
it.

```ts
try {
  const apiKey = await client.getSecret(name);
} catch (e: unknown) {
  // The secret value is never part of an error message.
}
```

Each `getSecret` call is one request. The client keeps no copy of the payload,
holds no connection open, and needs no teardown.
