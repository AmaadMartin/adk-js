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

Pass the write capability, and pin the project and the credentials with `storageOptions`:

```ts
import {GcsAdminToolset, GcsCapability, LlmAgent} from '@google/adk';

const admin = new GcsAdminToolset({
  settings: {capabilities: [GcsCapability.READ_WRITE]},
  storageOptions: {projectId: 'my-project'},
});

const agent = new LlmAgent({
  name: 'storage_admin',
  model: 'gemini-2.5-flash',
  tools: [admin],
});
```

`storageOptions` is the `StorageOptions` object of `@google-cloud/storage`, so it carries `projectId`, `credentials`, `authClient` or `keyFilename`. Omit it to use Application Default Credentials. ADK tags every request with the user agent `adk-gcs-tool google-adk/<version>`.

`gcs_delete_bucket` deletes a bucket permanently. The capability list is the only gate on it, so give an agent the write capability only when it is meant to have it.

## Expose a subset of the tools

`toolFilter` takes the tool names without the `gcs_` prefix, which is what the same filter takes in adk-python:

```ts
const admin = new GcsAdminToolset({
  settings: {capabilities: [GcsCapability.READ_WRITE]},
  toolFilter: ['get_bucket', 'list_buckets', 'create_bucket'],
});
```

A filter cannot add a tool the capabilities did not build. A predicate filter is also accepted; it receives the tool with the prefix, as the model sees it, and ADK skips it and logs a warning when `getTools()` runs without a `ReadonlyContext`.

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
