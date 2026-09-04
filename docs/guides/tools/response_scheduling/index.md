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
- A per-call override. A tool sets `context.responseScheduling` while it runs to
  name the mode for that one call, and it wins over the tool-wide default.

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

Assign `context.responseScheduling` inside the tool. It applies to that call
only, and the tool returns its payload unchanged.

```ts
import {Context, FunctionTool} from '@google/adk';

async function readSensor(): Promise<{value: number; critical: boolean}> {
  return {value: 9, critical: true};
}

const watch = new FunctionTool({
  name: 'watch',
  description: 'Watches a sensor.',
  parameters: z.object({}),
  execute: async (_args, context?: Context) => {
    const reading = await readSensor();
    if (reading.critical && context) {
      context.responseScheduling = FunctionResponseScheduling.INTERRUPT;
    }
    return {reading: reading.value};
  },
  responseScheduling: FunctionResponseScheduling.SILENT,
});
```

A critical reading emits
`{functionResponse: {id, name: 'watch', response: {reading: 9}, scheduling: 'INTERRUPT'}}`.
Every other reading keeps the tool-wide `SILENT`.

`Context` is the same object an `afterToolCallback` and a plugin receive, so a
callback can set the mode for a call too.

The tool result is never inspected for a `scheduling` key. A tool whose payload
happens to contain one — `{scheduling: 'SILENT', temperature: 20}` — sends that
payload through untouched.

## The modes

| Mode                     | Effect                                                                                        |
| ------------------------ | --------------------------------------------------------------------------------------------- |
| `SILENT`                 | Add the result to the context. Do not interrupt and do not trigger generation.                |
| `WHEN_IDLE`              | Add the result to the context and prompt for output, without interrupting ongoing generation. |
| `INTERRUPT`              | Add the result to the context, interrupt ongoing generation and prompt for output.            |
| `SCHEDULING_UNSPECIFIED` | Unused.                                                                                       |

## What ADK owns

`id` and `name` on the emitted `FunctionResponse` always address the function
call being answered. A tool cannot know the call id, so ADK sets both, whatever
keys the returned payload carries.
