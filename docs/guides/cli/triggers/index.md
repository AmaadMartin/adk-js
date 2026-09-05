# Pub/Sub and Eventarc triggers

Two opt-in HTTP endpoints that let an event source invoke an agent directly. A
Pub/Sub push subscription or an Eventarc CloudEvent arrives as an ordinary POST,
the server creates a session for it, runs the agent to completion and answers
`{"status": "success"}`. Reach for them when the agent's work is driven by
events — a file landing in a bucket, a row published to a topic — rather than by
a user typing.

## Introduction

The normal way into an ADK agent is `/run` or `/run_sse`: the caller already
knows a `userId` and a `sessionId`, and holds the connection open for the
events. An event source knows neither. Pub/Sub POSTs a push envelope and reads
only the status code; anything that is not 2xx makes it redeliver the message.

The trigger endpoints close that gap. Each delivery gets its own ephemeral
session, so nothing has to be created in advance, and the response carries only
the status the source acts on. Three properties follow from being on the
receiving end of a redelivering source:

- **Concurrency is bounded.** A burst of deliveries would otherwise fan out into
  as many concurrent model calls. A semaphore caps them, 10 by default.
- **A rate limit is retried in-process first.** A 429 from the model is retried
  with exponential backoff and jitter before the delivery is failed, so a short
  quota spike does not become a redelivery storm.
- **Failure is a 5xx.** Every unrecoverable error answers 500, which is what
  tells Pub/Sub and Eventarc to redeliver.

Nothing is mounted unless the operator names a source, and an unmounted path
404s. This is deliberate: a mounted endpoint accepts **unauthenticated** work
unless you also configure a verifier, so turning it on is an explicit decision.

## Get started

Serve the endpoints with `--trigger_sources`:

```bash
adk api_server --trigger_sources=pubsub,eventarc ./agents
```

Post a Pub/Sub push envelope at the app you want to run. `SGVsbG8=` is `Hello`
in base64:

```bash
curl -X POST http://localhost:8000/apps/my_agent/trigger/pubsub \
  -H 'Content-Type: application/json' \
  -d '{"message":{"data":"SGVsbG8=","messageId":"m-1"},
       "subscription":"projects/p/subscriptions/s"}'
# {"status":"success"}
```

The agent receives one user message: the JSON text
`{"data":"Hello","attributes":{}}`. `data` is the decoded payload, parsed as
JSON when it is JSON and kept as text when it is not. Parse it in the agent:

```ts
import {node, NodeContext, Workflow} from '@google/adk';

interface TriggerDelivery {
  data: unknown;
  attributes: Record<string, string | null>;
}

const describeEventNode = node(
  (_ctx: NodeContext, delivery: string) => {
    const {data, attributes} = JSON.parse(delivery) as TriggerDelivery;
    const source = attributes['ce-source'] ?? 'pub/sub';
    return `Received an event from ${source}: ${JSON.stringify(data)}`;
  },
  {name: 'describe_event_node'},
);

export const rootAgent = new Workflow({
  name: 'event_processor',
  edges: [['START', describeEventNode]],
});
```

A runnable copy of this agent, with the curl commands for both endpoints, is in
[`samples/triggers`](../../../../samples/triggers/README.md).

## The two endpoints

### `POST /apps/:appName/trigger/pubsub`

Takes a [Pub/Sub push
envelope](https://cloud.google.com/pubsub/docs/push#receive_push). `message` is
required; `message.data` is base64 and `message.attributes` is forwarded as-is.
Extra envelope fields such as `orderingKey` and `deliveryAttempt` are accepted
and ignored.

### `POST /apps/:appName/trigger/eventarc`

Takes a [CloudEvent](https://cloud.google.com/eventarc/docs/cloudevents) in
either content mode:

- **Structured mode.** The body carries `data` plus the CloudEvents attributes.
  `attributes` becomes the four `ce-*` values, read from the body first and the
  request headers second.
- **Binary mode**, which is Eventarc's default. The attributes arrive as `ce-*`
  headers and the body is the event data. When that data is a Pub/Sub wrapper
  (`{"message": {"data": "..."}}`), the wrapper's own attributes are used and
  the `ce-*` headers are not merged in.

The Eventarc endpoint never fails a delivery because a payload would not decode:
it forwards the raw value instead. Only the Pub/Sub endpoint answers 400.

## The user id

Both endpoints derive the session's user id from the delivery metadata: the
subscription for Pub/Sub, the source for Eventarc. Whitespace and surrounding
slashes are removed and remaining slashes become `--`, so
`//pubsub.googleapis.com/projects/p/topics/t` becomes
`pubsub.googleapis.com--projects--p--topics--t`. With no usable metadata the id
is `pubsub-caller` or `eventarc-caller`.

## Authentication

Configure it, or the deployment platform is the only thing controlling access.

Cloud Run and Eventarc sign push deliveries with a Google OIDC identity token
whose audience is the receiving service. Verify it by naming that audience:

```bash
adk api_server --trigger_sources=pubsub \
  --trigger_oidc_audience=https://my-service.example.run.app \
  --trigger_oidc_service_accounts=pusher@project.iam.gserviceaccount.com ./agents
```

`--trigger_oidc_service_accounts` restricts callers to those addresses, and
requires `--trigger_oidc_audience`. Without it any token valid for the audience
is accepted.

Verification runs before the body is read, so an unauthenticated request answers
401 or 403 rather than 422.

To verify something else, pass your own function to `AdkApiServer`. Throw an
`HttpError` to choose the status:

```ts
import {AdkApiServer, HttpError} from '@google/adk-devtools';

const server = new AdkApiServer({
  agentsDir: './agents',
  triggerSources: ['pubsub'],
  triggerAuthVerifier: (req) => {
    if (req.get('authorization') !== `Bearer ${process.env['TRIGGER_TOKEN']}`) {
      throw new HttpError(403, 'Forbidden');
    }
  },
});
await server.start();
```

The function may be synchronous or asynchronous. Anything it throws that is not
an `HttpError` is treated as a server fault and answers 500.

A custom verifier replaces the OIDC one, so `triggerOidcServiceAccounts` no
longer restricts anything. The server warns at startup when both are set.

Nothing about the token reaches the log. A verification failure is logged by
its error class alone, because the underlying library builds the raw token and
the decoded claims into its own messages.

## Responses

| Condition                                                      | Status                      |
| -------------------------------------------------------------- | --------------------------- |
| The agent ran                                                  | 200 `{"status": "success"}` |
| No token, a non-bearer scheme, or a token that does not verify | 401                         |
| The token principal is not in the allowlist                    | 403                         |
| The body does not match the schema                             | 422                         |
| `message.data` is not decodable base64 (Pub/Sub only)          | 400                         |
| Retries were exhausted on a rate limit                         | 500                         |
| The agent failed for any other reason                          | 500                         |
| The source was not enabled                                     | 404                         |

An error body is `{"error": "<message>"}`.

## Tuning

Four environment variables, read when the server is constructed:

| Variable                       | Default | Meaning                                                     |
| ------------------------------ | ------- | ----------------------------------------------------------- |
| `ADK_TRIGGER_MAX_CONCURRENT`   | 10      | Concurrent agent invocations across all trigger requests    |
| `ADK_TRIGGER_MAX_RETRIES`      | 3       | Retries of a transient failure, on top of the first attempt |
| `ADK_TRIGGER_RETRY_BASE_DELAY` | 1.0     | Backoff base delay, in seconds                              |
| `ADK_TRIGGER_RETRY_MAX_DELAY`  | 30.0    | Backoff cap, in seconds                                     |

A value that is not a number falls back to the default.
`ADK_TRIGGER_MAX_CONCURRENT` must also be a positive integer: the server
refuses to start on anything else, rather than serving with a semaphore that
admits nobody. The delay for attempt `n` is `min(base * 2**n, max)` plus up to
50% jitter. A failure that is not a rate limit is never retried.
