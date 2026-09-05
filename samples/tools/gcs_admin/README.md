# Cloud Storage bucket administration

An agent that inspects Cloud Storage buckets with `GcsAdminToolset`. See the
[developer guide](../../../docs/guides/tools/gcs_admin_toolset/index.md) for
the full API.

## Setup

`@google-cloud/storage` is an optional peer dependency of ADK. Install it, then
sign in:

```bash
npm install @google-cloud/storage
gcloud auth application-default login
export GEMINI_API_KEY=<your key>
```

## Run

```bash
npm run sample -- samples/tools/gcs_admin/agent.ts
```

Ask it to list the buckets in a project, or to describe one:

```
list the buckets in my-project
describe the bucket my-bucket
```

## Read-write

The sample is read-only, so it exposes `gcs_get_bucket` and
`gcs_list_buckets` only. To let the agent create, change and delete buckets,
ask for the write capability:

```ts
import {GcsCapability} from '@google/adk';

new GcsAdminToolset({
  credentialsConfig: new GcsCredentialsConfig({credentials}),
  gcsToolSettings: {capabilities: [GcsCapability.READ_WRITE]},
});
```

That adds `gcs_create_bucket`, `gcs_update_bucket` and `gcs_delete_bucket`.
Deleting a bucket cannot be undone.

## Interactive OAuth instead

To make each end user grant consent, build the credentials config from an
OAuth2 client rather than from application default credentials:

```ts
new GcsCredentialsConfig({
  clientId: process.env.OAUTH_CLIENT_ID,
  clientSecret: process.env.OAUTH_CLIENT_SECRET,
});
```

The first tool call then returns an authorization message, and the host drives
the user through the flow.
