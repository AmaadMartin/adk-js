# APIHubToolset

Turns an [Apigee API Hub](https://cloud.google.com/apigee/docs/apihub/what-is-api-hub)
resource into callable REST tools. Reach for it when your APIs are already
catalogued in API Hub and you want an agent to call them without copying the
OpenAPI spec into your project.

## Introduction

`APIHubToolset` fetches an OpenAPI spec from API Hub and hands it to
`OpenAPIToolset`, which generates one `RestApiTool` per operation. The toolset
therefore solves one problem only: getting the spec. Tool generation, parameter
schemas and authentication behave exactly as they do for `OpenAPIToolset`.

Use `OpenAPIToolset` directly when you already hold the spec as a string or an
object. Use `APIHubToolset` when the spec lives in API Hub, because the catalog
stays the single source of truth: a spec published in API Hub reaches the agent
without a code change.

The toolset also derives its own identity from the spec. When you pass no `name`
or `description`, it uses the spec's `info.title` in snake_case and the spec's
`info.description`.

## Get started

Point the toolset at an API Hub resource and give it to an agent.

```ts
import {APIHubToolset, LlmAgent} from '@google/adk';

const toolset = new APIHubToolset({
  apihubResourceName: 'projects/my-project/locations/us-central1/apis/my-api',
  accessToken: process.env.API_HUB_ACCESS_TOKEN,
});

const agent = new LlmAgent({
  name: 'api_agent',
  model: 'gemini-flash-latest',
  instruction: 'Call the API tools to answer the question.',
  tools: [toolset],
});
```

For local testing, mint the access token with
`gcloud auth print-access-token`.

## Resource names

`apihubResourceName` must name an API. It may also name a version and a spec:

| Resource name                                      | Spec used                           |
| -------------------------------------------------- | ----------------------------------- |
| `projects/p/locations/l/apis/a`                    | the first spec of the first version |
| `projects/p/locations/l/apis/a/versions/v`         | the first spec of that version      |
| `projects/p/locations/l/apis/a/versions/v/specs/s` | that spec                           |

A URL copied from the API Hub console works too, including its `?project=`
query parameter.

## Credentials

The toolset needs credentials to read from API Hub, and the generated tools may
need separate credentials to call the API itself.

To read from API Hub, pass one of:

- `accessToken` — a Google access token.
- `serviceAccountJson` — a service account key, as a JSON string.
- neither — Application Default Credentials.

To call the API, pass `authScheme` and `authCredential`. The toolset forwards
both to every generated tool.

```ts
import {AuthCredentialTypes, APIHubToolset} from '@google/adk';

const toolset = new APIHubToolset({
  apihubResourceName: 'projects/my-project/locations/us-central1/apis/my-api',
  serviceAccountJson: process.env.API_HUB_SERVICE_ACCOUNT_KEY,
  authScheme: {
    type: 'oauth2',
    flows: {
      authorizationCode: {
        authorizationUrl: 'https://example.com/auth',
        tokenUrl: 'https://example.com/token',
        scopes: {read: 'Read access'},
      },
    },
  },
  authCredential: {
    authType: AuthCredentialTypes.OAUTH2,
    oauth2: {
      clientId: process.env.OAUTH_CLIENT_ID,
      clientSecret: process.env.OAUTH_CLIENT_SECRET,
    },
  },
});
```

## When the spec is fetched

By default the constructor starts the fetch, and `getTools()` awaits it. Set
`lazyLoadSpec: true` to start the fetch on the first `getTools()` call instead.

Either way the toolset fetches the spec once: concurrent `getTools()` calls
share one request. A fetch that fails is retried on the next `getTools()` call.

A constructor cannot await, so `getTools()` reports every failure — a network
error, a resource that holds no spec, or a spec that is not valid YAML. The
constructor itself never throws for those. This differs from the Python SDK,
where eager loading throws from the constructor.

## Selecting tools

`toolFilter` takes the tool names to expose, or a predicate. The toolset passes
it to `OpenAPIToolset` unchanged.

```ts
const toolset = new APIHubToolset({
  apihubResourceName: 'projects/my-project/locations/us-central1/apis/my-api',
  accessToken: process.env.API_HUB_ACCESS_TOKEN,
  toolFilter: ['list_pets'],
});
```

Tool names come from the spec's operation ids, in snake_case: an operation id
of `listPets` becomes the tool `list_pets`.

## Supplying the spec yourself

`apihubClient` replaces the built-in client. Implement `BaseAPIHubClient` to
read the spec from anywhere — a test fixture, a cache, or a private mirror.

```ts
import {APIHubToolset, BaseAPIHubClient} from '@google/adk';

class FileAPIHubClient implements BaseAPIHubClient {
  constructor(private readonly spec: string) {}

  async getSpecContent(_resourceName: string): Promise<string> {
    return this.spec;
  }
}

const toolset = new APIHubToolset({
  apihubResourceName: 'test_resource',
  apihubClient: new FileAPIHubClient(specYaml),
});
```

`apihubClient` overrides `accessToken` and `serviceAccountJson`.
