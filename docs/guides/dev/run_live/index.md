# /run_live

`/run_live` is the WebSocket endpoint of the ADK development server. It carries
a bidirectional live conversation with an agent: the client streams audio or
text in, and the server streams events back. Reach for it when you build a
voice or push-to-talk front end, or when you drive a JS agent from the ADK
development UI in its live mode.

## Introduction

The development server offers three ways to run an agent. `/run` answers with
the complete event list when the turn ends. `/run_sse` streams the events of one
turn over Server-Sent Events, but the request body is fixed when the turn
starts. Neither lets the client speak while the model speaks.

`/run_live` adds that. The socket stays open for the whole conversation. Each
inbound frame is a `LiveRequest`, so the client sends new content, raw audio, or
activity signals at any moment. Each outbound frame is one `Event`, serialized
exactly as `/run_sse` serializes it. Under the hood the endpoint drives
`Runner.runLive` over a single `LiveRequestQueue`.

The query contract matches the adk-python endpoint of the same name, parameter
names included. One client therefore drives either server. That is why the
parameters are snake_case while the rest of this SDK is camelCase.

The endpoint never creates a session. Create the session over HTTP first, then
connect. A `session_id` that names nothing is refused, so a typo cannot start a
new conversation you did not ask for.

## Get started

Start a server and create a session:

```sh
npx adk api_server ./agents --port 8000

curl -X POST http://localhost:8000/apps/myApp/users/u1/sessions/s1 \
     -H 'Content-Type: application/json' -d '{}'
```

Then connect and exchange frames. This example uses the `ws` package:

```ts
import {Event} from '@google/adk';
import {WebSocket} from 'ws';

const query = 'app_name=myApp&user_id=u1&session_id=s1&modalities=TEXT';
const socket = new WebSocket(`ws://localhost:8000/run_live?${query}`);

socket.on('open', () => {
  socket.send(
    JSON.stringify({content: {role: 'user', parts: [{text: 'hello'}]}}),
  );
});

socket.on('message', (data) => {
  const event = JSON.parse(data.toString()) as Event;
  console.log(event.author, event.content?.parts?.[0]?.text);
});

socket.on('close', (code, reason) => {
  console.log('closed', code, reason.toString());
});
```

Send audio with a `blob` frame instead:

```ts
socket.send(
  JSON.stringify({
    blob: {mimeType: 'audio/pcm;rate=16000', data: chunk.toString('base64')},
  }),
);
```

## Query parameters

| Parameter                   | Type                          | Required | Default |
| --------------------------- | ----------------------------- | -------- | ------- |
| `app_name`                  | string                        | yes      | —       |
| `user_id`                   | string                        | yes      | —       |
| `session_id`                | string                        | yes      | —       |
| `modalities`                | `TEXT` or `AUDIO`, repeatable | no       | `AUDIO` |
| `proactive_audio`           | boolean                       | no       | unset   |
| `enable_affective_dialog`   | boolean                       | no       | unset   |
| `enable_session_resumption` | boolean                       | no       | unset   |
| `save_live_blob`            | boolean                       | no       | unset   |
| `explicit_vad_signal`       | boolean                       | no       | unset   |

Repeat `modalities` to ask for more than one:
`&modalities=TEXT&modalities=AUDIO`. A boolean accepts `true`, `false`, `1` and
`0`, in any case.

`modalities`, `proactive_audio` and `enable_affective_dialog` reach the run
config as `responseModalities`, `proactivity.proactiveAudio` and
`enableAffectiveDialog`. The last three parameters are validated and then
ignored: `RunConfig` has no field for them yet. The development UI sends them,
so refusing them would break it.

## Inbound frames

Each inbound frame is one JSON `LiveRequest`. It must be an object carrying at
least one of `content`, `blob`, `activityStart`, `activityEnd` or `close`, and
`close` must be a boolean. Only that envelope is checked; the payloads go to the
model client, which validates them.

A frame that fails the check is logged and dropped, and the socket stays open.
Send a correct frame after a bad one and the conversation continues.

## Close codes

| Code | Meaning                                                          |
| ---- | ---------------------------------------------------------------- |
| 1002 | The session does not exist.                                      |
| 1008 | The origin is not allowed, or the query is missing or malformed. |
| 1011 | The live run failed. The reason carries the error message.       |

The handshake completes before these checks run, so the client always observes
the code. A close reason is at most 123 bytes, the limit a WebSocket close frame
imposes. A longer reason is cut at a character boundary, never inside a UTF-8
sequence.

## Origin policy

A WebSocket handshake is exempt from the same-origin policy, so a browser page
can open a socket to your development server whatever its origin. The endpoint
therefore checks the `Origin` header itself:

- A request with no `Origin` header is allowed. Command-line clients and SDKs
  send none.
- With `--allow_origins <origin>`, the value `*` allows everything and any other
  value must match exactly.
- Without `--allow_origins`, only a loopback origin is allowed: `localhost`,
  any address in `127.0.0.0/8`, or `::1`.

The last rule is what stops an arbitrary page the developer visits from driving
their agent.

## Lifetime

The server creates one `LiveRequestQueue` per connection and closes it on every
exit path. A client disconnect ends the run: the server aborts it, closes the
queue, and does not report an error. Stopping the server closes every live
socket first, so `AdkApiServer.stop()` settles even while a conversation is
open.
