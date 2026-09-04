# Event and NodeInfo

`Event` is the unit of a conversation or a workflow run: it carries the content
exchanged, the actions the agent took, and the metadata that says who produced
it. `NodeInfo` records which workflow node produced it. Reach for the helpers
below when you build an event by hand, or when you read an event out of a
session and need to know where it came from.

## Introduction

ADK models a conversation as a sequence of events. A session stores them, the
runner emits them, and the workflow engine routes on them. One event holds
three kinds of information:

- **Content** — the message: text, function calls, function responses.
- **Actions** — the side effects: a state delta, an agent transfer, a
  checkpointed node state.
- **Metadata** — the author, the timestamp, and the node that emitted it.

Events are plain objects, not class instances. `createEvent` builds one and
module-level functions read it, so an event survives a spread or a JSON
round-trip without losing behaviour.

## Get started

`createEvent` accepts `message` as a shorter alias for `content`. It converts a
string, a part, or a list of parts to `Content` with the `user` role.

```ts
import {createEvent, getEventMessage} from '@google/adk';

const event = createEvent({author: 'user', message: 'Hello, agent!'});

getEventMessage(event)?.parts?.[0].text; // 'Hello, agent!'
```

`message` and `content` are mutually exclusive. Passing both throws an
`InputValidationError`.

### Carry a state delta

`state` is an alias for `actions.stateDelta`, the state the session applies
when it appends the event.

```ts
import {createEvent} from '@google/adk';

const event = createEvent({
  author: 'my_agent',
  message: 'I updated the theme.',
  state: {userTheme: 'dark'},
});

event.actions.stateDelta; // {userTheme: 'dark'}
```

### Read the emitting node

`nodePath` is an alias for `nodeInfo.path`. A path is a chain of
`nodeName@runId` segments joined with `.`, and the accessors parse it.

> [!NOTE]
> The workflow engine fills `nodeInfo` in. Read it, but do not build or edit it
> in application code.

```ts
import {
  createEvent,
  getNodeName,
  getNodeRunId,
  getParentNodeRunId,
} from '@google/adk';

const event = createEvent({author: 'agent', nodePath: 'wf@1.review@3'});

getNodeName(event); // 'review'
getNodeRunId(event.nodeInfo); // '3'
getParentNodeRunId(event.nodeInfo); // '1'
```

`getNodeName` returns `''` for an event that carries a node state snapshot
(`actions.agentState`) or that marks the end of an agent
(`actions.endOfAgent`), because such an event belongs to the workflow rather
than to one node.

## Update the message after construction

`getEventMessage` returns `event.content` itself, not a copy.
`setEventMessage` writes it, and clears it when you pass `undefined`.

```ts
import {createEvent, getEventMessage, setEventMessage} from '@google/adk';

const event = createEvent({author: 'agent'});

setEventMessage(event, 'first draft');
getEventMessage(event)?.parts?.[0].text; // 'first draft'

setEventMessage(event, undefined);
event.content; // undefined
```

## Deterministic long-running tool ids

`longRunningToolIds` marks the function calls that finish later than the turn
that started them. `createEvent` stores the ids deduplicated and sorted, so the
same event always serializes to the same bytes. A client that diffs serialized
events then sees an unchanged event as unchanged.

```ts
import {createEvent} from '@google/adk';

createEvent({longRunningToolIds: ['zzz', 'aaa', 'aaa']}).longRunningToolIds;
// ['aaa', 'zzz']
```

## Notes and limits

- `message`, `state` and `nodePath` are construction options only. They never
  become properties of the event, and never appear in a serialized event.
- The node path separator is `.` in adk-js and `/` in adk-python. The run id
  separator `@` is the same in both.
- `isolationScope` is internal. Do not read or set it.
