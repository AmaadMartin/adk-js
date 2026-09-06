# Event and NodeInfo

An `Event` is one entry in a session: the content exchanged, the actions that
follow from it, and the metadata saying who produced it. `NodeInfo` carries the
workflow node that emitted the event. Reach for the helpers on this page when
you build an event by hand, or when you read a stored event and need to know
which node run produced it.

## Introduction

ADK models a conversation and a workflow run as an ordered list of events. Each
event holds three kinds of information:

- **Content** — the message exchanged, as text, function calls or function
  responses.
- **Actions** — the side effects the runtime applies, such as a state delta, an
  agent transfer or an end-of-agent marker.
- **Metadata** — the author, the timestamp, and the node that emitted it.

`NodeInfo.path` is the only node field stored on the event. The path is a
sequence of segments, each `name@runId` or a bare `name`. The identity of the
node run is derived from that one string, so a stored event stays readable
without a second lookup. `adk-js` joins segments with `.` and `adk-python` joins
them with `/`; the parser accepts both, so a session written by a Python runner
reads here.

The `Session` stores the event list, and the workflow engine uses the same
events to resume a run. That is why the derivation matters: a resumed run reads
the run ids back out of the paths to tell which node runs already finished.

## Get started

Create an event with a text message. `message` is a convenience alias for
`content` that also accepts a part or a list of parts.

```ts
import {createEvent} from '@google/adk';

const event = createEvent({author: 'user', message: 'Hello, agent!'});

event.content?.parts?.[0]?.text; // 'Hello, agent!'
```

`state` is a convenience alias for `actions.stateDelta`:

```ts
import {createEvent} from '@google/adk';

const stateEvent = createEvent({
  author: 'my_agent',
  message: 'I updated the user preference.',
  state: {userTheme: 'dark'},
});

stateEvent.actions.stateDelta; // {userTheme: 'dark'}
```

`nodePath` is a convenience alias for `nodeInfo.path`. The workflow engine sets
it for you; you set it by hand only when you build an event in a test.

```ts
import {
  createEvent,
  getEventNodeName,
  getNodeInfoName,
  getNodeRunId,
  getParentNodeRunId,
} from '@google/adk';

const nodeEvent = createEvent({
  author: 'agent_node',
  nodePath: 'parentWorkflow@run-1.childNode@run-123',
});

getNodeInfoName(nodeEvent.nodeInfo); // 'childNode'
getNodeRunId(nodeEvent.nodeInfo); // 'run-123'
getParentNodeRunId(nodeEvent.nodeInfo); // 'run-1'
getEventNodeName(nodeEvent); // 'childNode'
```

## Reading and writing the message

`event.content` is where the message lives. Read it from there. To write one,
call `setEventMessage`, which accepts the same values as the `message` kwarg and
clears the content on `null` or `undefined`.

```ts
import {createEvent, setEventMessage} from '@google/adk';

const event = createEvent({author: 'user', message: 'Hello!'});

setEventMessage(event, 'Hello again!');
event.content?.parts?.[0]?.text; // 'Hello again!'

setEventMessage(event, undefined);
event.content; // undefined
```

`message` is a construction kwarg and a setter, not a field on `Event`. An
event is a plain object, and `{...event}` copies a getter's value, so a
`message` accessor would turn into a data property on every copy and would then
appear in serialized output. Serialization always uses `content`.

## Guarantees

- **`message` and `content` are mutually exclusive.** Passing both to
  `createEvent` throws an `InputValidationError` rather than letting one
  silently win.
- **A `Content` keeps its identity.** `createEvent({message: content})` and
  `setEventMessage(event, content)` store the same object, so a caller that
  holds a reference still sees its own value.
- **`createEvent` does not mutate its argument.** The convenience keys are
  destructured, not deleted from the object you passed.
- **`nodeInfo` stays absent unless you ask for it.** It is set only when you
  pass `nodeInfo` or `nodePath`, because the session layer treats its presence
  as "this event carries node provenance".
- **`longRunningToolIds` serialize deduplicated and sorted.** `adk-python`
  holds these ids in a set, so an unchanged event must serialize identically
  every time. The array on the event itself keeps the order you gave it.

## Node name and agent lifecycle

`getEventNodeName` reports the emitting node's name, except for events that
describe the agent's lifecycle rather than a node's output. It returns `''` when
`actions.endOfAgent` is `true`, and when `actions.agentState` holds at least one
key. An empty `agentState` object is not a snapshot, so the name survives it.

```ts
import {createEvent, getEventNodeName} from '@google/adk';

getEventNodeName(createEvent({nodePath: 'wf@1.review@3'})); // 'review'

getEventNodeName(
  createEvent({nodePath: 'wf@1.review@3', actions: {endOfAgent: true}}),
); // ''

getEventNodeName(
  createEvent({nodePath: 'wf@1.review@3', actions: {agentState: {step: 1}}}),
); // ''
```

## Failure modes

- A malformed path never throws. `getNodeRunId` and `getNodeInfoName` return
  `''`, and `getParentNodeRunId` returns `undefined`.
- A path with a single segment has no parent, so `getParentNodeRunId` returns
  `undefined`. It also returns `undefined` when the parent segment carries no
  run id.
- A node name may contain `@`. The parser splits at the last one, so
  `'a@b@2'` names the node `a@b` with run id `2`.
