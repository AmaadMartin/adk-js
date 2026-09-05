# Cloud Storage bucket administration

An agent that inspects Cloud Storage buckets with `GcsAdminToolset`. It is
read-only. The
[developer guide](../../../docs/guides/tools/gcs_admin_toolset/index.md)
explains the API, the credential modes and how to make it read-write.

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
