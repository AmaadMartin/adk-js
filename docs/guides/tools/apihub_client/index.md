# APIHubClient

Reads the text of an OpenAPI spec that is registered in
[Google Cloud API Hub](https://cloud.google.com/apigee/docs/api-hub/what-is-api-hub).
Reach for it when your team publishes its APIs to API Hub and you want an agent
to call them, instead of copying spec files into the repository.

## Introduction

API Hub is the Google Cloud catalog of an organisation's APIs. Each API holds
versions, and each version holds specs. The spec text is the OpenAPI document
you need to build tools, but the API Hub REST surface returns it base64-encoded
and only under a full spec resource name. Getting from "the API our team
registered" to "the spec text" therefore takes up to three authenticated
requests.

`APIHubClient` performs that walk. You give it whatever name you have — an API,
a version, a spec, or the Cloud Console URL you copied from the browser — and it
returns the decoded spec text. Pass that text to `OpenAPIToolset` to get a tool
per operation.

The client is read-only. It never writes to API Hub, and it holds no state
except the cached credential.

## Get started

Enable the API Hub API on your project, then authenticate with Application
Default Credentials:

```sh
gcloud auth application-default login
```

Fetch a spec and build tools from it:

```ts
import {APIHubClient, OpenAPIToolset} from '@google/adk';

const client = new APIHubClient();

const specText = await client.getSpecContent(
  'projects/my-project/locations/us-central1/apis/my-api',
);

const toolset = new OpenAPIToolset({specStr: specText, specType: 'yaml'});
```

## Credentials

The constructor takes two optional fields, and the client uses the first one you
set:

| Option               | Use it for                                                         |
| -------------------- | ------------------------------------------------------------------ |
| `accessToken`        | Local testing, with a token from `gcloud auth print-access-token`. |
| `serviceAccountJson` | A service account key, as a JSON string.                           |
| neither              | Application Default Credentials.                                   |

```ts
const local = new APIHubClient({accessToken: process.env.GCLOUD_TOKEN});
const service = new APIHubClient({serviceAccountJson: keyFileContents});
```

When the client mints a token it asks for the `cloud-platform` scope. It builds
one `GoogleAuth` instance on the first request and reuses it, so
`google-auth-library` refreshes the token on its own schedule. An explicit
`accessToken` skips `GoogleAuth` altogether.

## What `getSpecContent` accepts

The argument is a resource path or a Cloud Console URL. A leading slash and a
trailing slash are both allowed. When the path names only an API, the client
takes the first version and then the first spec of that version.

| Argument                                           | Requests |
| -------------------------------------------------- | -------- |
| `projects/P/locations/L/apis/A`                    | 3        |
| `projects/P/locations/L/apis/A/versions/V`         | 2        |
| `projects/P/locations/L/apis/A/versions/V/specs/S` | 1        |

A Console URL works because the client reads the `projects`, `locations`,
`apis`, `versions` and `specs` segments and ignores the rest of the route. The
project may also come from the `project` query parameter:

```ts
await client.getSpecContent(
  'https://console.cloud.google.com/apigee/api-hub/locations/us-central1/apis/my-api?project=my-project',
);
```

## Failure modes

Every failure is an `Error`.

- The argument has no project, no location, or no API id. The client throws
  before it sends a request, and the message names the segment it wants.
- The API has no versions, or the version has no specs. The message names the
  resource that is empty.
- API Hub answers with a non-2xx status. The message carries the status and the
  response body.
- No credential is available, or the credential yields no token. The message
  asks you to supply a service account or an access token. When the credential
  lookup itself failed, the client keeps that failure on `error.cause`.

A spec whose `contents` field is empty returns an empty string rather than
throwing.

## Browsing a project

`listApis` returns the APIs of one project and location. `getApi` and
`getApiVersion` return one resource each, so you can walk the catalog yourself
when the first-version-first-spec default is not what you want.

```ts
const apis = await client.listApis('my-project', 'us-central1');
for (const api of apis) {
  if (!api.name) continue;
  const detail = await client.getApi(api.name);
  // detail.versions holds the version resource names.
}
```
