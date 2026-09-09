# Importing a session

The ADK API server can create a session that already holds a conversation.
`POST /apps/{appName}/users/{userId}/sessions` takes an optional `events` array
and appends each entry to the new session. Reach for it when you want an agent
to continue a conversation that happened somewhere else.

## Introduction

A session created through the API server is normally empty, so the only way to
give an agent history is to run every turn through the server. That does not
work when the history came from elsewhere: an exported transcript, a
conversation another runtime recorded, or a fixture you want the dev UI to open
on.

`events` closes that gap. The server normalizes each entry into an ADK `Event`,
appends it in the order you sent it, and returns the session with the events on
it. From that point the session is an ordinary session: `POST /run` against its
id runs the agent with the imported turns in its history.

Imported events are the client's own record of a conversation, so the server
does not accept everything an `Event` can carry. Three kinds of field belong to
the ADK runtime and no client may supply them:

- `longRunningToolIds`, which marks a tool call the runtime is still waiting on.
- `actions`, which carries state deltas, artifact deltas and confirmation
  requests. It must be at its defaults.
- The control-plane function calls ADK raises to ask a human to approve, to
  authenticate, or to answer — `adk_request_confirmation`,
  `adk_request_credential` and `adk_request_input`.

Ordinary tool calls and their responses pass on purpose, so a conversation that
used tools can be restored whole. The server checks every event before it
creates the session, so a rejected import leaves nothing behind.

## Get started

Start the API server against your agents directory:

```shell
npx @google/adk-devtools api_server ./agents --port 8000
```

Create a session seeded with two turns:

```shell
curl -X POST localhost:8000/apps/agent/users/u1/sessions \
  -H 'Content-Type: application/json' \
  -d '{
    "state": {"topic": "weather"},
    "events": [
      {
        "author": "user",
        "content": {"role": "user", "parts": [{"text": "I live in New York."}]}
      },
      {
        "author": "agent",
        "content": {"role": "model", "parts": [{"text": "Noted."}]}
      }
    ]
  }'
```

The response is the created session, with both events on it and an `id` you can
pass to `POST /run`.

The same request from TypeScript:

```ts
const response = await fetch(
  'http://localhost:8000/apps/agent/users/u1/sessions',
  {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({
      state: {topic: 'weather'},
      events: [
        {
          author: 'user',
          content: {role: 'user', parts: [{text: 'I live in New York.'}]},
        },
        {
          author: 'agent',
          content: {role: 'model', parts: [{text: 'Noted.'}]},
        },
      ],
    }),
  },
);

const session = await response.json();
```

## What the server fills in

Every entry is a partial event. The server supplies the fields you leave out:
a random `id`, an empty `invocationId`, the current time as `timestamp`, and a
default `actions`. Only `content` and `author` are worth sending for a plain
conversational turn.

An event marked `partial: true` is a streaming fragment, and `appendEvent`
drops it. The session is created, but that event is not stored.

## Failure modes

A rejected event answers `400` and creates no session:

```json
{
  "error": "Session initialization event 0 cannot include ADK protocol function calls."
}
```

The number is the zero-based position of the first offending event in the array
you sent. The rest of the message names what it carried: `long-running tool
IDs`, `event actions`, or `ADK protocol function calls`. An `events` value that
is not an array answers `400` with `events must be an array.`

The endpoint keeps its old behaviour when you send no `events`, and
`POST /apps/{appName}/users/{userId}/sessions/{sessionId}` does not accept
events at all.
