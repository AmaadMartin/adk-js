# Evaluation sessions and the session listing

An evaluation run stores its conversations as ordinary sessions, so they land in
the same session service your users' conversations live in. ADK reserves an id
prefix for them, and the API server hides them from the session listing. Reach
for this guide when a session you can fetch by id does not appear in the list.

## Introduction

Evaluating an agent means running it, and running it creates sessions. Those
sessions are bookkeeping: they record what the evaluator did, not what a user
said. If the API server listed them, every evaluation run would add rows to the
conversation list your dev UI shows, and a user browsing their own history would
see them.

ADK separates the two by naming. An evaluation session's id starts with
`___eval___session___`, and `GET /apps/{app}/users/{user}/sessions` drops every
session whose id carries that prefix. The prefix is a wire contract shared with
adk-python, which declares the same value as `EVAL_SESSION_ID_PREFIX`, so both
SDKs hide the same sessions from the same endpoint.

The filter applies to the listing only. Every other endpoint treats an
evaluation session as an ordinary one: you can fetch it by id, append to it, and
delete it. Nothing stops you from choosing the prefix for a session of your own,
so treat it as reserved and do not mint ids with it.

adk-js does not run evaluations yet — its eval endpoints answer `501`. Until
they land, a prefixed session reaches your session service only when something
else writes it there: an adk-python evaluation run against a shared backend, or
your own code.

## Get started

Nothing needs configuring; the API server applies the filter to every session
listing. To see it, store a prefixed session and list the user's sessions.

```ts
import {InMemorySessionService} from '@google/adk';
import {AdkApiServer} from '@google/adk-devtools';

const sessionService = new InMemorySessionService();
const server = new AdkApiServer({sessionService});
await server.start();

await sessionService.createSession({
  appName: 'my_agent',
  userId: 'u1',
  sessionId: '___eval___session___run1',
});
await sessionService.createSession({
  appName: 'my_agent',
  userId: 'u1',
  sessionId: 'chat1',
});

const listed = await fetch(`${server.url}/apps/my_agent/users/u1/sessions`);
// { sessions: [ { id: 'chat1', ... } ], page: 1, totalItems: 2, ... }
```

The evaluation session is still there when you ask for it directly:

```ts
const one = await fetch(
  `${server.url}/apps/my_agent/users/u1/sessions/___eval___session___run1`,
);
// 200, { id: '___eval___session___run1', ... }
```

## Counts are not renumbered

The response keeps the `page`, `limit`, `totalItems` and `totalPages` the
session service reported. Those numbers are counted before the filter runs, so
`totalItems` can exceed the length of `sessions` — two stored sessions and one
listed, in the example above. adk-python leaves its own counts alone in the same
way.

Page through the listing on `page` and `limit`, not on `sessions.length`, and
treat `totalItems` as "sessions stored" rather than "sessions shown".
