# GcsAdminToolset

Gives an agent tools for administering Cloud Storage buckets: it can read one
bucket's metadata, list the buckets of a project, and — when you allow it —
create, reconfigure and delete a bucket. Reach for it when the agent answers
questions about the shape of your storage, rather than about the objects
inside it.

## Introduction

Bucket administration is a small, well-bounded API, which makes it a good fit
for a toolset the model calls directly. The risk is not that the model cannot
use it; the risk is that it uses too much of it. Deleting a bucket cannot be
undone, and creating one starts a bill.

So the toolset is gated twice. A capability setting decides which tools exist
at all, and the default exposes only the two that read. The three that change a
bucket are absent unless you ask for them, and when present each one asks the
user to approve the call before it runs. An agent you configured for questions
therefore cannot be talked into a deletion, because the tool is not in its
schema.

The objects inside a bucket are a separate concern and are not part of this
toolset: no tool here reads, writes or deletes an object.

The Cloud Storage SDK is an optional peer dependency. Install
`@google-cloud/storage` alongside `@google/adk`; an application that does not
use these tools never downloads it. It is loaded on the first tool call, so
building an agent with the toolset costs nothing until a tool runs.

The tools the model sees are `gcs_get_bucket`, `gcs_list_buckets`,
`gcs_create_bucket`, `gcs_update_bucket` and `gcs_delete_bucket`.

## Get started

```bash
npm install @google/adk @google-cloud/storage
```

```ts
import {GcsAdminToolset, LlmAgent} from '@google/adk';

const agent = new LlmAgent({
  name: 'gcs_admin_agent',
  model: 'gemini-2.5-flash',
  instruction: "Answer questions about the project's Cloud Storage buckets.",
  tools: [
    new GcsAdminToolset({
      credentialsConfig: {applicationDefaultCredentials: true},
    }),
  ],
});
```

That agent can read buckets and list them. It cannot change one.

## Allowing the write tools

`capabilities` decides which tools the toolset builds.

```ts
import {GcsAdminToolset, GcsCapabilities} from '@google/adk';

const toolset = new GcsAdminToolset({
  credentialsConfig: {applicationDefaultCredentials: true},
  gcsToolSettings: {capabilities: [GcsCapabilities.READ_WRITE]},
});
```

`READ_ONLY` is the default and exposes two tools. `READ_WRITE` exposes all
five. An empty array exposes none, which is a way to disable the toolset
without removing it from the agent.

`gcs_create_bucket`, `gcs_update_bucket` and `gcs_delete_bucket` each set
`requireConfirmation`, so an `LlmAgent` turn pauses and asks the user to
approve the call. There is no option that turns this off.

## Choosing the credentials

`GcsCredentialsConfig` names one of two ways to authenticate, and exactly one
of them must be set.

Application Default Credentials authenticate every end user as the agent's own
identity. Use this when the agent runs on Google Cloud and its service account
already reaches the buckets:

```ts
const toolset = new GcsAdminToolset({
  credentialsConfig: {applicationDefaultCredentials: true},
});
```

An OAuth client sends each end user through the authorization-code flow, so the
agent reads only the buckets that user can reach:

```ts
const toolset = new GcsAdminToolset({
  credentialsConfig: {
    clientId: process.env['GOOGLE_OAUTH_CLIENT_ID'],
    clientSecret: process.env['GOOGLE_OAUTH_CLIENT_SECRET'],
  },
});
```

With an OAuth client the first tool call asks the user for consent and answers
with `User authorization is required to access Google services for
<tool name>. Please complete the authorization flow.` Once the user has
consented, the resolved token is cached in that user's session state under
`gcs_token_cache`, which no other toolset shares.

The flow must return a refresh token. `@google-cloud/storage` builds its own
auth client from the credentials it is given, and it cannot be given a bare
access token, so a consent that grants no offline access fails with a message
saying so.

A Cloud Storage client is built for one tool call and never cached, because the
credentials belong to one end user. Sharing a client would authenticate the
next user's call as the previous user.

## The tools

| Tool                | Arguments                                                                              | Answers with                                                          |
| ------------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `gcs_get_bucket`    | `bucket_name`                                                                          | the bucket's raw API metadata                                         |
| `gcs_list_buckets`  | `project_id`, optional `page_size` and `page_token`                                    | the bucket names, and a `next_page_token` when a bounded page has one |
| `gcs_create_bucket` | `project_id`, `bucket_name`, optional `location`                                       | a confirmation naming the bucket the API created                      |
| `gcs_update_bucket` | `bucket_name`, optional `versioning_enabled` and `uniform_bucket_level_access_enabled` | a confirmation naming the bucket                                      |
| `gcs_delete_bucket` | `bucket_name`                                                                          | a confirmation naming the bucket                                      |

Argument names are `snake_case`, matching what adk-python declares to the
model, so a prompt or an agent configuration written against one SDK works
against the other.

`gcs_list_buckets` without a `page_size` lists every bucket in the project,
following the pages itself. With a `page_size` it returns that one page, and
reports `next_page_token` only when there is a further page.

`gcs_update_bucket` sends only the settings you named. Called with neither, it
makes no API call and still reports success.

## Results and failures

Every tool answers with a `GcsToolResult` and never throws:

```ts
type GcsToolResult<T extends object = object> =
  | ({status: 'SUCCESS'} & T)
  | {status: 'ERROR'; error_details: string};
```

A rejected API call, a bucket that does not exist and a missing
`@google-cloud/storage` all arrive as `{status: 'ERROR', error_details}`, so
the model can read the reason and tell the user, rather than the turn ending in
an exception. The keys are `snake_case` because they cross the model boundary
and match what adk-python emits.

Configuration mistakes are the exception: a `credentialsConfig` that names no
credential source, or both of them, throws from the constructor, because it is
a bug in the program rather than something the model can act on.

## Filtering the tools

`toolFilter` narrows what the model sees, on top of the capability gate. It
matches the prefixed tool name:

```ts
const toolset = new GcsAdminToolset({
  credentialsConfig: {applicationDefaultCredentials: true},
  toolFilter: ['gcs_list_buckets'],
});
```

adk-python filters on the bare name, so a filter ported from Python needs the
prefix added: `tool_filter=['list_buckets']` becomes
`toolFilter: ['gcs_list_buckets']`. An empty array means no filter.
