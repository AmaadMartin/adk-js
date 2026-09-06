# GcsAdminToolset

Gives an agent five Cloud Storage bucket-administration tools, behind a
capability gate and the end user's own Google credential. Reach for it when an
agent has to inspect or manage buckets, rather than read and write objects.

## Introduction

Without this toolset a developer writes five function tools by hand and their
OAuth plumbing with them. `GcsAdminToolset` supplies both. Every tool it builds
is a `GoogleTool`, so the credential is resolved once per call and handed to the
tool body as an argument. The model never sees a credential: it is not a field
in any tool schema.

The toolset administers _buckets_. It does not read, write or delete objects.
It is also not `GcsArtifactService`, which stores an agent's artifacts in a
bucket you already own; the two share only the `@google-cloud/storage` package.

Two settings decide what an agent can do. `GcsCapability.READ_ONLY`, the
default, builds `gcs_get_bucket` and `gcs_list_buckets`.
`GcsCapability.READ_WRITE` adds `gcs_create_bucket`, `gcs_update_bucket` and
`gcs_delete_bucket`. A write tool is never _constructed_ without
`READ_WRITE`, so no prompt and no tool filter can reach one.

> `gcs_delete_bucket` deletes a bucket, and the deletion cannot be undone. Grant
> `READ_WRITE` only to an agent that needs it.

## Get started

`@google-cloud/storage` is an optional peer dependency. Install it alongside
ADK:

```bash
npm install @google/adk @google-cloud/storage
```

A read-only agent, driving the end user through an OAuth consent flow:

```ts
import {GcsAdminToolset, GcsCredentialsConfig, LlmAgent} from '@google/adk';

export const rootAgent = new LlmAgent({
  name: 'storage_admin',
  model: 'gemini-flash-latest',
  instruction: 'Answer questions about the user Cloud Storage buckets.',
  tools: [
    new GcsAdminToolset({
      credentialsConfig: new GcsCredentialsConfig({
        clientId: process.env.OAUTH_CLIENT_ID,
        clientSecret: process.env.OAUTH_CLIENT_SECRET,
      }),
    }),
  ],
});
```

The agent sees `gcs_get_bucket` and `gcs_list_buckets`. On the first call the
toolset asks the host for the user's consent and the tool returns
`User authorization is required to access Google services for gcs_get_bucket.
Please complete the authorization flow.` Once the user consents, the credential
is cached in session state under `gcs_token_cache` and the call proceeds.

To let the agent change buckets, ask for the write capability:

```ts
import {
  GcsAdminToolset,
  GcsCapability,
  GcsCredentialsConfig,
} from '@google/adk';

const toolset = new GcsAdminToolset({
  credentialsConfig: new GcsCredentialsConfig({
    clientId: process.env.OAUTH_CLIENT_ID,
    clientSecret: process.env.OAUTH_CLIENT_SECRET,
  }),
  gcsToolSettings: {capabilities: [GcsCapability.READ_WRITE]},
});
```

## Credential modes

`GcsCredentialsConfig` accepts exactly one of three modes. Any other
combination throws `InputValidationError` at construction, so a mistake shows up
when you build the agent and not on the first tool call.

| Mode                      | Options                       | What happens                                                                  |
| ------------------------- | ----------------------------- | ----------------------------------------------------------------------------- |
| OAuth2 consent            | `clientId` and `clientSecret` | The toolset runs the flow and caches the credential in session state.         |
| A credential you hold     | `credentials`                 | Used for every end user. A service account or application default credential. |
| A token the host supplies | `externalAccessTokenKey`      | The toolset reads the access token from session state under that key.         |

Every mode defaults to the `devstorage.full_control` scope when you name none.
Pass `scopes` to narrow it, but only in the OAuth2 mode: the other two carry
their own scopes already, and supplying both is rejected.

For local development the simplest mode is a credential you hold:

```ts
import {GoogleAuth} from 'google-auth-library';
import {GcsCredentialsConfig} from '@google/adk';

const credentials = await new GoogleAuth().getClient();
const credentialsConfig = new GcsCredentialsConfig({credentials});
```

Run `gcloud auth application-default login` first.

## The tools

| Tool                | Parameters                                                             | Returns                     |
| ------------------- | ---------------------------------------------------------------------- | --------------------------- |
| `gcs_get_bucket`    | `bucketName`                                                           | The bucket metadata object. |
| `gcs_list_buckets`  | `projectId`, `pageSize?`, `pageToken?`                                 | The bucket names.           |
| `gcs_create_bucket` | `projectId`, `bucketName`, `location?`                                 | A confirmation message.     |
| `gcs_update_bucket` | `bucketName`, `versioningEnabled?`, `uniformBucketLevelAccessEnabled?` | A confirmation message.     |
| `gcs_delete_bucket` | `bucketName`                                                           | A confirmation message.     |

Each returns `{status: 'SUCCESS', results}` or
`{status: 'ERROR', error_details}`. A tool never throws at the model, so a
denied permission or a missing bucket comes back as text the model can report.
The keys and the two status values match adk-python, so a transcript reads the
same in both SDKs.

`gcs_list_buckets` pages only when the model supplies a `pageSize`. Without one
it walks every page and reports no `next_page_token`. With one it reads a single
page, and includes `next_page_token` only when another page exists.

`gcs_update_bucket` patches only the flags the model supplied. With neither
flag it reads the bucket and makes no change.

## Filtering the tools

`toolFilter` takes a list of names or a predicate. The list names the
**unprefixed** operation, and the tool you get back still carries the prefix:

```ts
const toolset = new GcsAdminToolset({toolFilter: ['list_buckets']});
const tools = await toolset.getTools(); // [gcs_list_buckets]
```

This differs from `McpToolset`, whose list matches the prefixed name. The
unprefixed form is what adk-python matches, and keeping it means one filter
works against both SDKs. An empty list, like an unset filter, exposes every
tool the capabilities allow.

A predicate receives each tool and a `ReadonlyContext`. Called without a
context, `getTools()` cannot evaluate the predicate: it returns every tool and
logs a warning.

## Lifecycle

Constructing the toolset performs no I/O. `@google-cloud/storage` is imported,
and a client opened, on the first tool call. A missing package produces an
error naming the feature and the install command.

Every call builds its own client and drops it. Two end users of one agent hold
different credentials, so a cached client would serve one user's buckets to
another. `close()` therefore has nothing to release and resolves immediately.

The credential is adapted on its way to the client. `@google-cloud/storage@7`
pins `google-auth-library@^9` and ADK pins `^10`, so npm keeps two copies, and
the two report request headers differently. ADK converts between them. You do
not have to do anything about this, but it is why the object the storage client
holds is not the credential you passed in.
