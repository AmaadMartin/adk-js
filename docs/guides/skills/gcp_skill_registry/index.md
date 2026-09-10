# GCPSkillRegistry

`GCPSkillRegistry` fetches a skill, and searches the skill catalogue, over the
Google Cloud Agent Registry API. Reach for it when the skills an agent may use
are published to a project rather than checked into the repository beside the
agent.

## Introduction

A `SkillToolset` normally holds the skills you hand it. A registry replaces
that fixed set with a lookup: `search_skills` asks the catalogue what exists,
and `load_skill` fetches one by name. `GCPSkillRegistry` is the
`SkillRegistry` implementation for a catalogue hosted in Google Cloud.

The registry owns the transport and nothing else. It resolves credentials,
selects the host, sends the requests, and hands the downloaded zip archive to
the same `loadSkillFromZipBuffer` that a local skill directory goes through. So
a skill from the registry is validated exactly like a local one: the zip-slip
guard, the `SKILL.md` requirement and the frontmatter schema all apply.

Nothing happens in the constructor except configuration. Credentials are
resolved on the first request, and the client certificate at most once per
registry. A registry you build but never call costs no network and no
subprocess.

## Get started

```ts
import {GCPSkillRegistry, LlmAgent, SkillToolset} from '@google/adk';

const registry = new GCPSkillRegistry({
  projectId: 'my-project',
  location: 'us-central1',
});

export const rootAgent = new LlmAgent({
  name: 'skill_registry_agent',
  model: 'gemini-flash-latest',
  instruction: 'Use search_skills to find skills, and load_skill to load one.',
  tools: [new SkillToolset([], {registry})],
});
```

You can also call the registry directly:

```ts
const skill = await registry.getSkill('my-skill');
const hits = await registry.searchSkills('data analysis');
```

`getSkill` resolves a `Skill`. `searchSkills` resolves a `Frontmatter[]`, which
carries only the name and the description of each hit — enough for a model to
decide what to load.

## Configuration

An option wins over the environment:

| Setting     | Option        | Environment                     |
| ----------- | ------------- | ------------------------------- |
| Project     | `projectId`   | `GOOGLE_CLOUD_PROJECT`          |
| Location    | `location`    | `GOOGLE_CLOUD_LOCATION`         |
| Credentials | `credentials` | Application default credentials |

The project and the location have no default. When neither source supplies
both, the constructor throws `project_id and location must be specified or set
via environment variables.` rather than building a registry that cannot address
anything. A `client` carries its own, so it exempts a caller from this rule.

`credentials` takes a `google-auth-library` `AuthClient`. Without it the
registry calls `GoogleAuth().getClient()` on the first request, and reports a
failure as `Failed to get default Google Cloud credentials: <cause>`.

Every request carries a bearer token, `x-goog-user-project`, and the ADK client
labels on `x-goog-api-client` and `user-agent`. The quota project is the one
the credentials name, falling back to the configured project.

### Endpoint

The default host is `https://agentregistry.googleapis.com/v1alpha`.
`AGENT_REGISTRY_ENDPOINT` replaces it outright, which is how you point an agent
at a staging deployment:

```sh
export AGENT_REGISTRY_ENDPOINT=https://staging.endpoint.com
```

The override applies to both calls `getSkill` makes, including the revision
download.

### Mutual TLS

Two variables select the mutual-TLS host
`https://agentregistry.mtls.googleapis.com/v1alpha`:

- `GOOGLE_API_USE_MTLS_ENDPOINT` is `auto`, `always` or `never`. It defaults to
  `auto`, and an unrecognised value warns and reads as `auto`.
- `GOOGLE_API_USE_CLIENT_CERTIFICATE` is `true` or `false`. Under `auto` the
  registry picks the mutual-TLS host only when this is `true` and the machine
  has a certificate to present. Asking for a certificate you do not have would
  otherwise send every request to a host that rejects a connection presenting
  nothing. `always` skips that availability check.

With `GOOGLE_API_USE_CLIENT_CERTIFICATE=true` the registry also loads the
SecureConnect context-aware certificate from
`~/.secureConnect/context_aware_metadata.json` and presents it on the
connection. The certificate, the key and the passphrase stay in memory. A
certificate that fails to load warns, and the registry connects without one.

`AGENT_REGISTRY_ENDPOINT` is read first, so it overrides the mutual-TLS host
too.

### Vertex AI client

A `client` option switches the registry to the Vertex AI `v1beta1` skills
collection, which `adk-python` does not offer:

```ts
import {Client} from '@google-cloud/vertexai';

const registry = new GCPSkillRegistry({
  client: new Client({project: 'my-project', location: 'us-central1'}),
});
```

The client carries its own project, location and credentials, so none of the
settings above apply to it, and neither does the mutual-TLS host selection.
Prefer the default: the Agent Registry API is the transport both SDKs call.

## Fetching a skill

`getSkill(name)` makes two requests. The first reads the skill resource and its
`defaultRevision`; the second downloads that revision with `alt=media` and gets
the zip archive.

A skill whose resource names no `defaultRevision` fails with `Skill '<name>'
does not contain default revision.` — there is nothing to download.

### Name validation

A skill name usually arrives from a model-issued tool call, and it is
interpolated into a request URL. `getSkill` therefore rejects a name that is
not a single lowercase kebab-case or snake_case segment, before it sends
anything:

```ts
// Throws. No request is made.
await registry.getSkill('my-skill/../other-skill');
```

The message names the rule: `Invalid skill name '<name>': name must be
lowercase kebab-case (a-z, 0-9, hyphens) or snake_case (a-z, 0-9,
underscores), with no leading, trailing, or consecutive delimiters.`

## Searching the catalogue

`searchSkills(query)` sends the query as `search_string` and reads the `skills`
array of the response. The last `/`-separated segment of each entry's `name` is
the skill name.

A hit the client cannot represent is skipped, not raised. The catalogue may
hold an entry whose name breaks the frontmatter rules — a dotted first-party
name, capitals, a name over 64 characters — or an entry with no description.
Each one is logged with `logger.warn` and dropped, and the remaining hits are
still returned. You do not control what the catalogue holds, so one bad entry
must not end discovery for every other.

## Errors

| Condition                          | Message                                                                       |
| ---------------------------------- | ----------------------------------------------------------------------------- |
| No project or location             | `project_id and location must be specified or set via environment variables.` |
| Invalid skill name                 | `Invalid skill name '<name>': …`                                              |
| No `defaultRevision`               | `Skill '<name>' does not contain default revision.`                           |
| Credentials unavailable            | `Failed to get default Google Cloud credentials: <cause>`                     |
| Non-2xx response                   | `API request failed with status <status>: <body>`                             |
| Anything else the transport throws | `API request failed: <cause>`                                                 |

All of them are a plain `Error`.
