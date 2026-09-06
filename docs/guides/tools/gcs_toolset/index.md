# GcsToolset

Gives a model tools to read and write Google Cloud Storage objects. Reach for it
when an agent must list a bucket, read an object, or upload one, instead of
hand-writing a `FunctionTool` over `@google-cloud/storage`.

## Introduction

`GcsToolset` is a `BaseToolset`, so an `LlmAgent` accepts it wherever it accepts
a tool. It exposes five operations over objects: `list_objects`,
`get_object_metadata`, `get_object_data`, `create_object` and `delete_objects`.

A capability setting decides which of them the model can see. The default is
read-only, so a toolset built with no options exposes the three read tools and
never `create_object` or `delete_objects`. You opt into the write tools; they
are not something a misconfiguration hands out.

This is a different concern from `GcsArtifactService`, which also stores data in
Cloud Storage. The artifact service is an ADK service: the framework writes
artifacts to it and the model reaches them through the artifact tools, under
keys ADK chooses. `GcsToolset` gives the model direct access to buckets and
object names that you name, for reading data an agent was not given.

Every tool returns a record rather than throwing. A success is
`{status: 'SUCCESS', results: ...}` and a failure is
`{status: 'ERROR', error_details: '...'}`, so a failed call becomes something
the model can read and react to.

`@google-cloud/storage` is an optional peer dependency. It is loaded when the
first tool runs, so importing `@google/adk` works without it installed. Install
it before you use the toolset:

```sh
npm install @google-cloud/storage
```

## Get started

The toolset authenticates with Application Default Credentials when you give it
no credentials.

```ts
import {GcsToolset, LlmAgent} from '@google/adk';

const agent = new LlmAgent({
  name: 'gcs_agent',
  model: 'gemini-2.5-flash',
  instruction: 'Answer questions about the objects in the user bucket.',
  tools: [new GcsToolset()],
});
```

The model now sees `gcs_list_objects`, `gcs_get_object_metadata` and
`gcs_get_object_data`.

## Allow writes

Pass the read-write capability to add `gcs_create_object` and
`gcs_delete_objects`.

```ts
import {GcsCapability, GcsToolset} from '@google/adk';

const toolset = new GcsToolset({capability: GcsCapability.READ_WRITE});
```

`gcs_delete_objects` deletes permanently and there is no undo. Give a toolset
the read-write capability only when the agent's job needs it.

## Narrow the exposed tools

`toolFilter` takes a list of tool names, or a predicate over the tool and the
invocation context. A list names the tool the model sees, which carries the
prefix. A predicate reads the tool's own name, which does not.

```ts
const toolset = new GcsToolset({
  capability: GcsCapability.READ_WRITE,
  toolFilter: ['gcs_create_object', 'gcs_get_object_data'],
});
```

## Change the tool name prefix

Every tool name starts with `gcs_`. Pass `prefix` to change it, or `''` to drop
it. Use this when two toolsets would otherwise expose the same name.

```ts
const toolset = new GcsToolset({prefix: 'archive'});
// archive_get_object_data, archive_get_object_metadata, archive_list_objects
```

## Authenticate

`credentialsConfig` forwards to the Cloud Storage client. Supply a key file,
inline credentials, or an `AuthClient`; omit it for Application Default
Credentials. The scope defaults to `devstorage.full_control`.

```ts
const toolset = new GcsToolset({
  credentialsConfig: {keyFilename: '/path/to/service-account.json'},
  project: process.env.GOOGLE_CLOUD_PROJECT,
});
```

The credentials are fixed when you build the toolset. Every tool call uses the
same client, so the toolset acts as one identity. It cannot authenticate a
browsing user, unlike adk-python's `GCSToolset`, which runs an interactive OAuth
handshake through `GoogleTool`.

## Reading object content

`gcs_get_object_data` decodes the bytes as UTF-8 and reports
`encoding: 'text'`. Bytes that are not valid UTF-8 come back base64-encoded with
`encoding: 'base64'`, so a binary object still reaches the model intact.

Pass `destination_file_path` to write the object to a local file instead. The
tool then returns a confirmation message rather than the content.

## Local file paths are not sandboxed

`create_object` takes a `source_file_path` and `get_object_data` takes a
`destination_file_path`. Both come from the model, and neither is contained:
`source_file_path` uploads every file the process can read, and
`destination_file_path` writes anywhere the process can write. This matches
adk-python. Run the agent with an operating-system account that can only reach
what it should, and prefer `data` over `source_file_path` where you can.

## Release the client

`close()` releases the Cloud Storage client. A later tool call builds a new one,
so calling it early is safe.

```ts
await toolset.close();
```
