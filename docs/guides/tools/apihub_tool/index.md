# API Hub tool

`APIHubToolset` turns an API catalogued in Google Cloud API Hub into a set of
callable tools. You give it a resource name, and an agent gets one tool per
operation the API's OpenAPI specification declares.

## Introduction

An organization that catalogues its REST APIs in API Hub already has the
OpenAPI specification stored, versioned and access-controlled there. Using one
of those APIs from an agent without this toolset means fetching the
specification out of band, checking it into the repository and keeping the copy
current. The copy stops matching the API the moment somebody registers a new
specification. `APIHubToolset` removes that step: the resource name in the
catalogue is the only thing the agent needs.

The toolset does not parse the specification itself. It resolves the resource
name to a single specification and hands the text to `OpenAPIToolset`, so the
tools it produces are the same `RestApiTool` instances a local specification
produces. Everything `OpenAPIToolset` supports works the same way here,
including an authentication scheme applied to every operation. The difference is
where the specification comes from.

Reach for `OpenAPIToolset` directly when you already hold the specification, as
a file or a string. Reach for `APIHubToolset` when API Hub holds it, because the
catalogue is then the single source of truth and a specification updated there
reaches the agent on its next start.

Three classes make up the feature, and a caller usually touches one.

| Class                 | You touch it when                                                                             |
| :-------------------- | :-------------------------------------------------------------------------------------------- |
| `APIHubToolset`       | Always. It turns a resource name into tools and hands them to an agent.                       |
| `APIHubClient`        | You want the specification text itself, or you want to list what the catalogue holds.         |
| `BaseAPIHubClient`    | You are supplying the specification from somewhere other than API Hub, including from a test. |
| `SecretManagerClient` | The credential the agent needs lives in Secret Manager rather than in your configuration.     |

`APIHubToolset`, `APIHubClient` and `BaseAPIHubClient` carry the
`@experimental` decorator. Calling them logs one warning per class, and the
surface may change between minor versions.

## Get started

This agent answers questions by calling the operations of an API catalogued in
API Hub. The toolset builds its own API Hub client from the service account key,
fetches the specification during construction, and hands the generated tools to
the agent.

```ts
import {APIHubToolset, LlmAgent} from '@google/adk';

const apihubToolset = new APIHubToolset({
  apihubResourceName: 'projects/my-project/locations/us-central1/apis/my-api',
  serviceAccountJson: process.env.SERVICE_ACCOUNT_JSON,
});

export const rootAgent = new LlmAgent({
  name: 'api_hub_assistant',
  model: 'gemini-flash-latest',
  description: 'Answers questions about the catalogued API.',
  instruction: 'Answer questions by calling the catalogued API.',
  tools: [apihubToolset],
});
```

A `BaseToolset` goes into `tools` whole, so the toolset sits in the same array
as an ordinary tool. The agent sees one function declaration per operation in
the specification.

## How it works

The resource name may name an API, an API version or a single specification.
The level decides how many requests the client makes. A name pinned at the
specification level is fetched in one request. A name pinned at the version
level costs two, because the client reads the version to find its first
specification. A name pinned at the API level costs three, because the client
reads the API to find its first version first.

These four forms all resolve:

```
projects/{p}/locations/{l}/apis/{a}
projects/{p}/locations/{l}/apis/{a}/versions/{v}
projects/{p}/locations/{l}/apis/{a}/versions/{v}/specs/{s}
https://console.cloud.google.com/apigee/api-hub/projects/{p}/locations/{l}/apis/{a}?project={p}
```

The console URL is accepted because it is what a developer has in hand after
finding the API in the browser. The client reads the project from the `projects`
path segment, and falls back to the `project=` query parameter only when the
path carries no `projects` segment at all. A trailing slash is ignored.

The client takes the **first** entry at each step rather than asking which one
you meant, and API Hub decides that order. Pin the name at the specification
level when an API carries more than one version or more than one specification,
because otherwise the agent's tools can change after somebody registers a new
version.

The specification is fetched at most once per toolset instance. With
`lazyLoadSpec` left at `false` the fetch starts during construction, so the
round trip overlaps whatever else your application does while starting. A
TypeScript constructor cannot await, so a fetch that fails does not throw from
`new`: the failure surfaces from the first `getTools` or `getTool` call instead.
With `lazyLoadSpec` set to `true` nothing is fetched until one of those calls,
and concurrent calls share the single fetch rather than starting one each.

`name` and `description` are filled in from the specification's `info` block the
first time it is parsed, and only where you left them unset. `name` is the title
converted to snake case, and `unnamed` when the specification carries no title.
The fill-in happens at parse time, so reading `toolset.name` before the first
`getTools` call on a lazily loaded toolset returns the empty string.

`getTool(name)` returns one tool out of the set `getTools` returns, so
`toolFilter` governs it too.

## Configuration options

`APIHubToolsetOptions` covers fetching the specification and generating the
tools. `apihubResourceName` is the only required field, because everything else
has a usable default or serves a specific setup.

| Option               | Type                        | Default                       | Description                                                    |
| :------------------- | :-------------------------- | :---------------------------- | :------------------------------------------------------------- |
| `apihubResourceName` | `string`                    | required                      | The API Hub resource name, or a console URL.                   |
| `accessToken`        | `string`                    | —                             | A Google access token for the client the toolset builds.       |
| `serviceAccountJson` | `string`                    | —                             | A service account key, as a JSON string, for that same client. |
| `name`               | `string`                    | the specification title       | The toolset name.                                              |
| `description`        | `string`                    | the specification description | The toolset description.                                       |
| `lazyLoadSpec`       | `boolean`                   | `false`                       | Fetch on first use instead of during construction.             |
| `authScheme`         | `AuthScheme`                | —                             | An authentication scheme applied to every generated tool.      |
| `authCredential`     | `AuthCredential`            | —                             | An authentication credential applied to every generated tool.  |
| `apihubClient`       | `BaseAPIHubClient`          | a new `APIHubClient`          | The client that reads the specification.                       |
| `toolFilter`         | `ToolPredicate \| string[]` | `[]`                          | Selects which tools `getTools` returns.                        |
| `prefix`             | `string`                    | —                             | Prepended to every generated tool name.                        |

`accessToken` and `serviceAccountJson` configure the client the toolset builds
for itself, so both are ignored when you pass `apihubClient`. `accessToken` wins
over `serviceAccountJson` when both are set, which makes a token from
`gcloud auth print-access-token` a local override that does not require removing
the service account key from your configuration.

`authScheme` and `authCredential` are about the catalogued API, not about API
Hub. They reach every generated tool, so use them when the API behind the
specification needs a credential the specification does not carry.

`toolFilter` accepts either a list of tool names or a predicate. A list is
matched against the final tool name, so it includes `prefix` when you set one. A
predicate receives a `ReadonlyContext`, which lets the selection depend on the
session, and it is consulted only when `getTools` receives a context.

`prefix` is passed through to the generated tools, so the name in `toolFilter`,
the name `getTool` takes and the name the model calls are all the prefixed form.
Use it when one agent holds two toolsets whose specifications declare operations
of the same name.

### Reading the specification directly

`APIHubClient` is what the toolset uses, and it is useful on its own when you
want the text rather than the tools. Both of its options are optional, and the
constructor takes no arguments in the common case.

| Option               | Type     | Default | Description                                     |
| :------------------- | :------- | :------ | :---------------------------------------------- |
| `accessToken`        | `string` | —       | A bearer token, sent verbatim.                  |
| `serviceAccountJson` | `string` | —       | Service account key material, as a JSON string. |

The three credential modes have a precedence. `accessToken` is sent unchanged,
without contacting an authorization server, and a token from
`gcloud auth print-access-token` expires after about an hour. Otherwise
`serviceAccountJson` is parsed and used to sign, with the
`https://www.googleapis.com/auth/cloud-platform` scope. When neither is set the
client uses Application Default Credentials, which covers a Cloud Run service, a
Compute Engine instance and a developer machine that has run
`gcloud auth application-default login`.

The credential is resolved on first use and reused, so key material that does
not parse produces `Invalid service account JSON:` from the first request rather
than from the constructor. `google-auth-library` refreshes the token it holds,
so a long-lived client keeps working with no refresh handling in your code.

`listApis`, `getApi` and `getApiVersion` expose the three API Hub reads
directly, for an application that wants to discover what is registered before it
picks a name. `listApis` returns an empty array when the project holds no APIs,
so an empty catalogue is not an error.

```ts
import {APIHubClient} from '@google/adk';

const client = new APIHubClient();

// Every API registered in the project and location.
const apis = await client.listApis('my-project', 'us-central1');

// The specification text of one of them.
const specStr = await client.getSpecContent(
  'projects/my-project/locations/us-central1/apis/my-api',
);
```

### Reading a credential from Secret Manager

`SecretManagerClient` reads one secret version and returns its payload as a
string. Reach for it when the credential an agent needs lives in Secret Manager
rather than in your configuration files.

| Option               | Type     | Default | Description                                                  |
| :------------------- | :------- | :------ | :----------------------------------------------------------- |
| `serviceAccountJson` | `string` | —       | The contents of a service account JSON keyfile, as a string. |
| `authToken`          | `string` | —       | An existing Google Cloud OAuth 2.0 access token.             |

```ts
import {APIHubToolset, SecretManagerClient} from '@google/adk';

const secrets = new SecretManagerClient();
const serviceAccountJson = await secrets.getSecret(
  'projects/my-project/secrets/apihub-reader/versions/latest',
);

const toolset = new APIHubToolset({
  apihubResourceName: 'projects/my-project/locations/us-central1/apis/my-api',
  serviceAccountJson,
});
```

`resourceName` is a **version** resource name, in the form
`projects/*/secrets/*/versions/*`. The `versions/latest` suffix reads the most
recent enabled version, which is what a rotation needs in order to take effect
without a code change. Pin a numeric version when one specific value must stay
in use.

The two credential options are mutually exclusive: supplying both throws from
the constructor, because the client cannot tell which identity you meant and
picking one silently would sign your requests as something you did not choose.
Supplying neither selects Application Default Credentials. Everything else is
deferred, so a credential problem surfaces from the first `getSecret` call and
not from the constructor.

The value `getSecret` returns is credential material. Keep it out of log lines,
artifacts and model prompts, because anything an agent writes down can reach a
transcript or a bug report. Pass the value straight to the component that needs
it.

## Advanced applications

Supplying `apihubClient` is how the toolset runs without API Hub at all.
`BaseAPIHubClient` declares one method, so an object literal satisfies it, and a
specification held in a string, a file or a private catalogue reaches the
toolset the same way.

```ts
import {APIHubToolset, BaseAPIHubClient} from '@google/adk';
import {readFileSync} from 'node:fs';

const myOpenApiSpec = readFileSync('./my-api.yaml', 'utf-8');

const bundledSpecClient: BaseAPIHubClient = {
  getSpecContent: async () => myOpenApiSpec,
};

const toolset = new APIHubToolset({
  apihubResourceName: 'projects/p/locations/l/apis/my-api',
  apihubClient: bundledSpecClient,
});
```

Extend the class instead when the substitute needs state of its own, such as a
map of specifications keyed by resource name:

```ts
import {BaseAPIHubClient} from '@google/adk';

class BundledSpecClient extends BaseAPIHubClient {
  constructor(private readonly specs: Record<string, string>) {
    super();
  }

  override async getSpecContent(resourceName: string): Promise<string> {
    const spec = this.specs[resourceName];
    if (spec === undefined) {
      throw new Error(`No bundled spec for ${resourceName}`);
    }
    return spec;
  }
}
```

`apihubResourceName` stays required either way, because the client decides what
to do with it. A client that ignores it, as the first one does, still receives
it.

## Limitations

API Hub is not a public endpoint. The endpoints the client calls answer
`403 SERVICE_DISABLED` until API Hub is provisioned in a host project and at
least one API is registered, so the client cannot be tried against a live
service without that setup. The sample below substitutes the client for that
reason.

`getTools` and `getTool` return `BaseTool`, not the `RestApiTool` the
specification produced, because that is what `OpenAPIToolset.getTools` is typed
to return. Use the tools through the `BaseTool` surface, or hold your own
`OpenAPIToolset` when you need the narrower type.

The toolset does not retry. A fetch that fails leaves the toolset in its failed
state, and every later `getTools` call rejects with the same error rather than
trying again. Build a new toolset to retry, or put the retry in your own
`BaseAPIHubClient`.

A malformed specification propagates the YAML parse error unchanged. An empty
specification is not an error: it yields no tools.

`SecretManagerClient` reads secret versions only. Creating, updating, disabling
and destroying secrets belong in the deployment tooling that manages the secret
rather than in the agent that consumes it.

## Related samples

- [`samples/tools/apihub_tool/`](../../../../samples/tools/apihub_tool/README.md) - A resource name becoming two tools that call the public GitHub REST API, with the catalogue client substituted.
- [Tool samples](../../../../samples/tools/README.md) - The category the sample lives in, and what CI does and does not run for it.
