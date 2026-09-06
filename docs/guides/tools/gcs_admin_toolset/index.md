# GcsAdminToolset

`GcsAdminToolset` gives an agent five tools that administer Google Cloud Storage buckets. Reach for it when the agent has to answer questions about the buckets in a project, or has to create, reconfigure and delete them.

## Introduction

ADK already talks to Cloud Storage through `GcsArtifactService`, but that service works on objects inside one bucket that you configured, and the model never calls it. This toolset is the other half: it works on the buckets themselves, and the model calls it directly.

Bucket administration is destructive, so the toolset is gated. A toolset built with no settings exposes the two read tools only. The three tools that change a bucket exist only when the settings carry `GcsCapability.READ_WRITE`. A read-only toolset never builds them, so no later configuration can reach them.

| Tool the model sees | Capability              |
| ------------------- | ----------------------- |
| `gcs_get_bucket`    | read-only or read-write |
| `gcs_list_buckets`  | read-only or read-write |
| `gcs_create_bucket` | read-write              |
| `gcs_update_bucket` | read-write              |
| `gcs_delete_bucket` | read-write              |

The tools are experimental, and the class logs a warning that says so.

## Get started

The Cloud Storage client is an optional peer dependency, so install it first:

```
npm install @google-cloud/storage
```

A read-only toolset needs no arguments. It uses Application Default Credentials:

```ts
import {GcsAdminToolset, LlmAgent} from '@google/adk';

const agent = new LlmAgent({
  name: 'storage_reader',
  model: 'gemini-2.5-flash',
  tools: [new GcsAdminToolset()],
});
```

## Allow the agent to change a bucket

Pass the write capability, and set the credentials with `storageOptions`:

```ts
import {GcsAdminToolset, GcsCapability, LlmAgent} from '@google/adk';

const admin = new GcsAdminToolset({
  settings: {capabilities: [GcsCapability.READ_WRITE]},
  storageOptions: {keyFilename: process.env.GCS_KEY_FILE},
});

const agent = new LlmAgent({
  name: 'storage_admin',
  model: 'gemini-2.5-flash',
  tools: [admin],
});
```

`storageOptions` is the `StorageOptions` object of `@google-cloud/storage`, so it carries `credentials`, `authClient` or `keyFilename`. Omit it to use Application Default Credentials. ADK tags every request with the user agent `adk-gcs-tool google-adk/<version>`.

A `projectId` in `storageOptions` does not confine the agent: `gcs_list_buckets` and `gcs_create_bucket` take `project_id` as an argument and the model chooses it, so the credentials decide which projects the agent can reach. Give the agent credentials scoped to the projects it is meant to administer.

`gcs_delete_bucket` deletes a bucket permanently. The capability list is the only gate on it, so give an agent the write capability only when it is meant to have it.

The tools accept a bucket name of lowercase letters, digits, dots, underscores and hyphens, starting with a letter or a digit. Any other name reports `ERROR` and sends no request, because the storage client puts the name into the request path unescaped.

## Expose a subset of the tools

`toolFilter` takes the tool names the model sees, so each one carries the `gcs_` prefix:

```ts
const admin = new GcsAdminToolset({
  settings: {capabilities: [GcsCapability.READ_WRITE]},
  toolFilter: ['gcs_get_bucket', 'gcs_list_buckets', 'gcs_create_bucket'],
});
```

A filter cannot add a tool the capabilities did not build. A predicate filter is also accepted, and ADK skips it and logs a warning when `getTools()` runs without a `ReadonlyContext`.

If you come from adk-python, note that its `tool_filter` matches the unprefixed name, because its framework adds the prefix after the filter runs. adk-js filters after prefixing, as `MCPToolset` does.

## What a tool returns

A tool never throws. It returns a `SUCCESS` object with its payload in `results`:

```json
{"status": "SUCCESS", "results": ["bucket-one", "bucket-two"]}
```

A failed call returns the reason instead, so the model can read it and react:

```json
{"status": "ERROR", "error_details": "bucket is not empty"}
```

`gcs_get_bucket` returns the bucket resource as the API returned it, with no fields renamed or dropped. `gcs_list_buckets` returns bucket names. Give it a `page_size` to get one page, and it adds a `next_page_token` when a further page follows; without a `page_size` it returns every bucket in the project.
