# LiveRequestQueue

`LiveRequestQueue` is the client's side of a live (bidirectional) run. You push
a `LiveRequest` onto it, and the agent's send loop forwards that request to the
model and persists what it carries. Reach for the fields on this page when a
live client has to change session state, stream a turn in pieces, or tell the
model that its audio input has stopped.

## Introduction

A live run has two directions. The agent yields `Event`s to you, and you push
`LiveRequest`s to the agent. Only the first direction reaches the session by
itself: the `Runner` appends every event the agent yields. A request you push
never becomes an event, so the send loop persists it instead.

That split is why `LiveRequest` carries more than content. A client that only
sends audio still needs to record a preference the user just changed, and a
client that streams a long turn in pieces still needs each piece to reach the
model without ending the turn. `stateDelta`, `partial` and `audioStreamEnd`
cover those three cases.

The send loop applies them in a fixed order, so a request may combine them:

1. `stateDelta` is applied first, so it survives a request that also closes the
   connection or that carries a partial turn.
2. `close` closes the connection and ends the run.
3. One realtime signal is sent, by priority: `activityStart`, then
   `activityEnd`, then `audioStreamEnd`, then `blob`.
4. `content` is persisted as one `user` event and sent to the model.

A request carrying both `content` and `stateDelta` produces exactly one session
event, holding both. A request whose content is partial or is a function
response produces a separate content-less event for the delta, because the
content itself is not a completed user turn.

## Get started

```ts
import {
  Event,
  InMemorySessionService,
  LiveRequestQueue,
  LlmAgent,
  Runner,
} from '@google/adk';

const agent = new LlmAgent({
  name: 'live_agent',
  model: 'gemini-live-2.5-flash-native-audio',
});
const sessionService = new InMemorySessionService();
const runner = new Runner({appName: 'live_app', agent, sessionService});
const session = await sessionService.createSession({
  appName: 'live_app',
  userId: 'user',
});

const queue = new LiveRequestQueue();
queue.send({
  content: {role: 'user', parts: [{text: 'Switch me to dark mode.'}]},
  stateDelta: {theme: 'dark'},
});
queue.close();

const events: Event[] = [];
for await (const event of runner.runLive({
  userId: 'user',
  sessionId: session.id,
  liveRequestQueue: queue,
})) {
  events.push(event);
}
```

After the run, `session.state['theme']` is `'dark'`, and the session holds one
`user` event carrying both the text and the delta.

## Changing session state

Send a `stateDelta` on its own when there is nothing to say to the model:

```ts
queue.send({stateDelta: {locale: 'fr'}});
```

The send loop appends a content-less event authored by `'user'`. The session
service applies the delta the same way it applies any other event's delta, so
`temp:` keys are dropped and `app:` and `user:` prefixes keep their usual
scope.

A delta needs somewhere to go. An agent driven directly, without a `Runner` and
so without a session service on its invocation context, has no session to write
to, and the delta is dropped.

## Streaming a turn in pieces

Set `partial` to append to the current turn without completing it. The model
keeps waiting for more:

```ts
queue.sendContent(
  {role: 'user', parts: [{text: 'Book me a table '}]},
  {
    partial: true,
  },
);
queue.sendContent({role: 'user', parts: [{text: 'for four at eight.'}]});
```

Only the final, non-partial request completes the turn and is persisted as a
user event.

## Ending the audio stream

With voice activity detection enabled, the model decides when the user has
stopped speaking. `sendAudioStreamEnd()` tells it the stream stopped for another
reason — the microphone was switched off — so it can flush the audio it has
buffered:

```ts
queue.sendRealtime({mimeType: 'audio/pcm', data: audioChunk});
queue.sendAudioStreamEnd();
```

The client can reopen the stream by sending audio again.

## Failure modes

- A content carrying a `functionCall` is rejected with `User message cannot
contain function calls.`. Function calls come from the model, not the client.
- A connection that does not implement `sendActivityStart`, `sendActivityEnd`
  or `sendAudioStreamEnd` skips that signal rather than failing the run. These
  are optional members of `BaseLlmConnection`.
- `send()` on a closed queue throws `Cannot send to a closed queue.`.
