# EventarcToolset

Gives an agent one tool, `publish_message`, that publishes a CloudEvent to a
Google Cloud Eventarc Advanced message bus. Reach for it when the agent has to
tell the rest of your system that something happened, rather than answer the
user directly.

## Introduction

Eventarc Advanced routes CloudEvents from publishers to subscribers through a
_message bus_. An agent that publishes to a bus becomes one more event producer
in an event-driven architecture: it emits a typed event and the bus decides who
receives it. The agent never learns who the subscribers are, and a subscriber
never learns that an agent produced the event.

The tool is fire-and-forget. It reports whether the bus accepted the event, not
what any subscriber did with it, and it never throws — every failure comes back
as a record the model can read and act on. Use it when the agent's job ends at
"the event is on the bus". When the agent needs an answer back, call the service
directly with a normal tool instead.

The publishing client is `@google-cloud/eventarc-publishing`, an optional peer
dependency. Installing `@google/adk` does not pull it in, and the module is only
loaded the first time a publish runs, so an application that never publishes
pays nothing for this tool.

## Get started

Install the publishing SDK:

```sh
npm install @google-cloud/eventarc-publishing
```

Create a message bus, if you do not have one:

```sh
gcloud beta eventarc message-buses create my-bus \
  --location=us-central1 \
  --project=my-project
```

Give the toolset to an agent:

```ts
import {EventarcToolset, LlmAgent} from '@google/adk';

const toolset = new EventarcToolset({
  toolConfig: {projectId: 'my-project', publishTimeoutMs: 30_000},
});

const agent = new LlmAgent({
  name: 'event_publisher',
  model: 'gemini-2.5-flash',
  instruction:
    'When an order is created, publish a com.example.order.created event to ' +
    'projects/my-project/locations/us-central1/messageBuses/my-bus.',
  tools: [toolset],
});
```

The model now calls `publish_message` with a `bus`, a CloudEvent `type` and
`source`, and whatever payload and attributes it needs.

## What the model sees

`publish_message` takes the CloudEvents attributes, and nothing else. The
project, the credentials and the timeout are bound when the toolset builds the
tool, so the model can neither read nor set them.

| Field                       | Required | Default                       |
| --------------------------- | -------- | ----------------------------- |
| `bus`                       | yes      | —                             |
| `type`                      | yes      | —                             |
| `source`                    | yes      | —                             |
| `data`                      | no       | no payload                    |
| `is_base64_encoded`         | no       | `false`                       |
| `include_tracing_extension` | no       | `false`                       |
| `datacontenttype`           | no       | inferred from `data`          |
| `specversion`               | no       | `1.0`                         |
| `subject`                   | no       | omitted                       |
| `id`                        | no       | a generated UUIDv4            |
| `time`                      | no       | the current time, in RFC 3339 |
| `custom_attributes`         | no       | none                          |

`datacontenttype` is inferred from the payload: an object or array becomes
`application/json`, a string becomes `text/plain`, and decoded binary data
becomes `application/octet-stream`. Pass an empty string for `datacontenttype`
or `time` to leave that attribute off the event entirely.

Binary payloads travel as base64. Set `is_base64_encoded` to `true` and the tool
decodes the string into raw bytes before publishing.

## What it returns

The tool always returns a record, never an exception:

```json
{"status": "SUCCESS", "message_id": "9f0e5a1c-..."}
{"status": "ERROR", "error_details": "type must be a non-empty string"}
```

`message_id` is the event id — the one the caller supplied, or the UUIDv4 the
tool generated. A validation failure, a missing SDK and a rejected publish all
come back as `ERROR` with the reason in `error_details`.

## Domain-specific tools

`publish_message` asks the model for every attribute. When the application
already knows what it publishes, bind the attributes ahead of the call with
`createPublishTool`, and the model is asked only for what is left:

```ts
import {AgentProvided, EventarcToolset, OMIT} from '@google/adk';
import {z} from 'zod';

const toolset = new EventarcToolset({
  toolConfig: {projectId: 'my-project'},
});

const escalate = toolset.createPublishTool({
  name: 'report_escalation',
  description: 'Reports that a support case needs a human.',
  bus: 'projects/my-project/locations/us-central1/messageBuses/my-bus',
  ceAttributesBinding: {
    type: 'com.example.support.escalated',
    source: '//support/agent',
    subject: new AgentProvided({description: 'Short escalation reason.'}),
    time: OMIT,
  },
  payloadSchema: z.object({caseId: z.string(), priority: z.string()}),
});
```

The tool is added to the toolset and also returned, so an agent given
`tools: [toolset]` picks it up.

Each attribute takes one of four things:

| Binding                            | Meaning                                                  |
| ---------------------------------- | -------------------------------------------------------- |
| a string                           | the same value on every event                            |
| a function                         | computed per call, as `(payload, toolContext) => string` |
| `new AgentProvided({description})` | the model supplies it                                    |
| `OMIT`                             | leave the attribute off the event                        |

`AgentProvided` without a `default` becomes a required tool parameter, so the
model must supply it. With a `default` the parameter is optional.

A function binding always receives `(payload, toolContext)`, in that order. To
read only the context, name the payload and ignore it:
`(_payload, ctx) => ...`. This is where the port differs from adk-python, which
reads a lambda's parameter names to decide the order.

`type` and `source` are required and cannot be `OMIT`. `id` and `specversion`
may be bound but cannot be `OMIT`, because every CloudEvent carries them. A
custom attribute key must be lowercase alphanumeric and must not shadow a
standard attribute. `createPublishTool` checks all of this when it builds the
tool, so a misconfigured tool fails at startup rather than mid-conversation.

## Authentication

With no `credentialsConfig` the client uses Application Default Credentials,
which is what you want on Cloud Run, GKE and a developer machine running
`gcloud auth application-default login`. Supply credentials explicitly when the
deployment cannot use ADC:

```ts
import {EventarcToolset} from '@google/adk';

const toolset = new EventarcToolset({
  toolConfig: {projectId: process.env.GOOGLE_CLOUD_PROJECT},
  credentialsConfig: {keyFilename: process.env.EVENTARC_KEY_FILE},
});
```

Name at most one credential source. A config carrying both `credentials` and
`keyFilename` is rejected when the toolset is built, because Google's auth
library silently prefers one and the deployment would then publish under an
identity you did not choose. An incomplete credential body is rejected the same
way.

The whole deployment publishes as one identity. There is no per-end-user OAuth
handshake, which is where this port differs from adk-python's `GoogleTool`.

## Clients and cleanup

Each publisher client owns a gRPC channel. Clients are cached by project and
credentials, at most ten of them, for thirty minutes each; when an entry leaves
the cache its channel is closed. A publish that fails drops its client, so the
next call reconnects.

Call `close()` when the agent shuts down, and every remaining channel is closed:

```ts
await toolset.close();
```

## Tracing

Set `include_tracing_extension` to `true` and the tool copies the active
OpenTelemetry trace context — `traceparent` and `tracestate` — into the event's
attributes, so a subscriber can continue the trace. It reads the propagator the
application installed; with no propagator registered, no trace attributes are
added.

## Manual test

CI cannot publish to a real bus. To check the path by hand, set
`GOOGLE_CLOUD_PROJECT`, authenticate with
`gcloud auth application-default login`, create the bus as shown above, run the
agent snippet, and confirm the event arrives:

```sh
gcloud beta eventarc message-buses list --location=us-central1
```
