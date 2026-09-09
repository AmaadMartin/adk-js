# PubSubToolset

Lets an agent publish to a Cloud Pub/Sub topic and read a subscription: three
tools that publish a message, pull the messages waiting on a subscription, and
acknowledge them. Reach for it when the agent has to emit work onto a queue, or
explain what is sitting in one.

## Introduction

An agent that talks to Pub/Sub otherwise needs a hand-written tool per
operation. `PubSubToolset` supplies the three, so the agent describes what it
wants and the model picks the call.

The tools mirror `google.adk.tools.pubsub` in adk-python, down to the argument
and result field names, so a prompt written against one SDK behaves the same
against the other. Two of them write: `publish_message` puts a message on a
topic, and `acknowledge_messages` removes messages from a subscription
permanently. `pull_messages` with `auto_ack: true` does both at once.

`@google-cloud/pubsub` is an optional peer dependency. Most agents never touch
Pub/Sub, so importing `@google/adk` does not pull it in; the toolset loads it on
the first tool call. Install it yourself:

```sh
npm install @google-cloud/pubsub
```

The tools are reachable only from the `@google/adk/tools/pubsub` subpath. The
main `@google/adk` barrel does not re-export them, so a bundler following that
barrel never reaches the peer.

## Get started

```ts
import {LlmAgent} from '@google/adk';
import {PubSubToolset} from '@google/adk/tools/pubsub';

const agent = new LlmAgent({
  name: 'pubsub_agent',
  model: 'gemini-2.5-flash',
  instruction:
    'Publish events to Pub/Sub and read the messages waiting on a' +
    ' subscription.',
  tools: [
    new PubSubToolset({
      credentialsConfig: {},
      pubsubToolConfig: {projectId: 'my-project'},
    }),
  ],
});
```

An empty `credentialsConfig` uses Application Default Credentials, so the
agent runs as whatever identity the environment provides.

To try it against a real project:

```sh
gcloud pubsub topics create adk-demo
gcloud pubsub subscriptions create adk-demo-sub --topic adk-demo
```

Then ask the agent to publish a message to
`projects/my-project/topics/adk-demo` and pull it back from
`projects/my-project/subscriptions/adk-demo-sub`.

## The tools

| Tool                   | Does                                          |
| ---------------------- | --------------------------------------------- |
| `publish_message`      | publishes one message to a topic              |
| `pull_messages`        | pulls the messages waiting on a subscription  |
| `acknowledge_messages` | acknowledges messages, removing them for good |

These are the names the model sees, and they match adk-python.

`publish_message` takes `topic_name`, `message`, optional `attributes` and an
optional `ordering_key`. The ordering key is sent with the message, and the
topic delivers messages that share one in the order it received them. The tool
answers with `{"message_id": "..."}`.

`pull_messages` takes `subscription_name`, `max_messages` (default 1) and
`auto_ack` (default false). It answers with `{"messages": [...]}`, where each
entry carries `message_id`, `data`, `attributes`, `ordering_key`,
`publish_time` and `ack_id`. `publish_time` is RFC 3339. `data` is the message
body as UTF-8 text, or its base64 encoding when the bytes are not valid UTF-8.

`acknowledge_messages` takes `subscription_name` and `ack_ids`, and answers with
`{"status": "SUCCESS"}`.

A failure never raises. Every tool answers with
`{"status": "ERROR", "error_details": "..."}` instead, so the model reads a
Pub/Sub permission error as an answer and can explain it. `publish_message` and
`pull_messages` carry no `status` field when they succeed, which follows
adk-python.

## Configuration

```ts
new PubSubToolset({
  credentialsConfig: {},
  pubsubToolConfig: {projectId: 'my-project'},
  toolFilter: ['pull_messages', 'acknowledge_messages'],
});
```

`toolFilter` selects the tools the agent sees. Leave it out for all of them; an
empty array exposes none. A name the toolset does not own is ignored.

`pubsubToolConfig.projectId` names the project the tools work in. Leave it out
to let the client infer it from the environment or the credentials. The topic
and subscription arguments are full resource names either way, so the project id
only affects client construction.

## Credentials

`credentialsConfig` is required, and reaches the Pub/Sub client as data. It
names one identity for every end user, or one identity per end user.

Application Default Credentials, which is the environment's identity:

```ts
new PubSubToolset({credentialsConfig: {}});
```

A service account, named inline or by key file:

```ts
new PubSubToolset({
  credentialsConfig: {keyFilename: process.env.PUBSUB_KEY_FILE},
});
```

An OAuth client pair, so each end user authorizes the agent against their own
Pub/Sub access through the authorization-code flow:

```ts
new PubSubToolset({
  credentialsConfig: {
    clientId: process.env.OAUTH_CLIENT_ID,
    clientSecret: process.env.OAUTH_CLIENT_SECRET,
  },
});
```

The flow needs one round trip. The first tool call answers with the `ERROR`
envelope saying authorization is required, and asks the runner for the
credential. Once the user authorizes, the grant is cached in that user's own
session state, so two users never share one. The grant must carry a refresh
token: the Pub/Sub client mints its own access tokens and cannot present one
it was handed. Request offline access, or the tool reports that as an `ERROR`.

Naming a service account and an OAuth pair together, or half an OAuth pair,
throws from the `PubSubToolset` constructor. Scopes default to
`PUBSUB_DEFAULT_SCOPES`, the single scope
`https://www.googleapis.com/auth/pubsub`.

The toolset does not take an auth client object. `@google-cloud/pubsub` types
that field against the copy of `google-auth-library` that `google-gax` pins,
which is a different major version from the one adk-js depends on, and two
copies of that package are not interchangeable.

## Clients and cleanup

The toolset caches one publisher client and one subscriber client per
credential and project. A cached client is reused for 30 minutes, and the
publisher cache holds at most 10 clients, evicting the least recently used.
Both bounds match adk-python.

Each client owns a gRPC channel, so call `close()` on the toolset to release
them, or let the agent server close it at the end of its lifecycle. Calling
`close()` twice is safe.
