# Tool response scheduling

Controls when the model reacts to a tool result on a Live API session. Reach for
it when a tool reports something the model must see but must not answer, or
something urgent enough to cut into speech the model is already generating.

## Introduction

In a Live session the model is generating audio or text while your tools run. A
function response normally prompts the model to react to it. That is the right
default for a tool the user just asked about, and the wrong default for a tool
that reports in the background: a sensor poll that returns "nothing changed"
should not make the model start talking.

`FunctionResponse.scheduling` is the Live API field that decides this. ADK
exposes it in two layers:

- A tool-wide default, `responseScheduling` on the tool. Every result from that
  tool carries it.
- A per-call override. A tool that returns a `FunctionResponse` names the mode
  for that one call, and it wins over the tool-wide default.

A tool that sets neither leaves the field unset, and the server default applies.

The Live API reads `scheduling` only for declarations marked `NON_BLOCKING`.
ADK marks the declaration for you when the tool sets `responseScheduling`, so
the tool-wide default is enough to make the field take effect. Models that do
not support asynchronous function calling ignore the field. It has no effect on
`generateContent` requests.

## Get started

Give the tool a default mode. Every result it produces lands silently.

```ts
import {FunctionTool} from '@google/adk';
import {FunctionResponseScheduling} from '@google/genai';
import {z} from 'zod';

const logEvent = new FunctionTool({
  name: 'logEvent',
  description: 'Records an event.',
  parameters: z.object({message: z.string()}),
  execute: async ({message}) => ({recorded: message}),
  responseScheduling: FunctionResponseScheduling.SILENT,
});
```

The emitted part is
`{functionResponse: {id, name: 'logEvent', response: {recorded: '...'}, scheduling: 'SILENT'}}`.

## Override the mode for one call

Return a `FunctionResponse` instead of a plain payload. Its `response` becomes
the payload and its `scheduling` applies to that call only.

```ts
async function readSensor(): Promise<{value: number; critical: boolean}> {
  return {value: 9, critical: true};
}

const watch = new FunctionTool({
  name: 'watch',
  description: 'Watches a sensor.',
  parameters: z.object({}),
  execute: async () => {
    const reading = await readSensor();
    return reading.critical
      ? {
          response: {reading: reading.value},
          scheduling: FunctionResponseScheduling.INTERRUPT,
        }
      : {reading: reading.value};
  },
  responseScheduling: FunctionResponseScheduling.SILENT,
});
```

A critical reading emits
`{functionResponse: {id, name: 'watch', response: {reading: 9}, scheduling: 'INTERRUPT'}}`.
Every other reading keeps the tool-wide `SILENT`.

A response an `afterToolCallback` or a plugin substitutes goes through the same
path, so a callback can return a `FunctionResponse` too.

## The modes

| Mode                     | Effect                                                                                        |
| ------------------------ | --------------------------------------------------------------------------------------------- |
| `SILENT`                 | Add the result to the context. Do not interrupt and do not trigger generation.                |
| `WHEN_IDLE`              | Add the result to the context and prompt for output, without interrupting ongoing generation. |
| `INTERRUPT`              | Add the result to the context, interrupt ongoing generation and prompt for output.            |
| `SCHEDULING_UNSPECIFIED` | Unused.                                                                                       |

## What ADK owns

`id` and `name` on the emitted `FunctionResponse` always address the function
call being answered. A tool cannot know the call id, so ADK overwrites both,
whatever the returned object puts there.

## When a returned object counts as an override

Every field of `FunctionResponse` is optional, so an object shape alone cannot
tell an override from an ordinary payload. ADK treats a returned object as an
override only when both hold:

- `scheduling` names a member of `FunctionResponseScheduling`.
- The object carries no key outside `willContinue`, `scheduling`, `parts`,
  `id`, `name` and `response`.

Anything else is an ordinary payload and lands nested under `response`. So
`{scheduling: 'SILENT', temperature: 20}` is a weather reading, not an
override, and a tool that already returns `{response: ...}` keeps working
unchanged.

`willContinue` and `parts` on a returned `FunctionResponse` are ignored.
