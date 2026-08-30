# BaseTool custom metadata and response scheduling

`BaseTool` carries two optional members beside `name`, `description` and
`isLongRunning`: `customMetadata` and `responseScheduling`. Reach for them when
a tool needs to carry data ADK does not interpret, or to control when a live
model reacts to the tool's answer.

## Introduction

A tool declaration tells the model what a tool does. These two members tell ADK
and your own code how to treat the tool around that call.

`customMetadata` is storage. ADK never interprets it, so a tool manifest, a
deployment identifier or a routing hint survives on the tool instance for your
code to read later. `AgentRegistrySingleMCPToolset` uses it this way: it stamps
the MCP server destination id onto every tool it discovers.

`responseScheduling` changes the event a tool call produces. It stamps a
scheduling mode onto the emitted `FunctionResponse`, which tells a live model
when to react to the answer. A tool that sets neither member behaves exactly as
it did before.

## Get started

```ts
import {BaseTool, BaseToolParams} from '@google/adk';
import {FunctionDeclaration} from '@google/genai';

class InventoryTool extends BaseTool {
  override _getDeclaration(): FunctionDeclaration {
    return {name: this.name, description: this.description};
  }

  async runAsync(): Promise<unknown> {
    return {inStock: 12};
  }
}

const inventory = new InventoryTool({
  name: 'inventory',
  description: 'Looks up stock levels.',
  customMetadata: {manifestVersion: 3, owner: 'catalog'},
});

// inventory.customMetadata is {manifestVersion: 3, owner: 'catalog'}
```

## Custom metadata

The whole object must be JSON serializable, because a caller that persists a
tool manifest expects to serialize it.

`customMetadata` is not `readonly`. A tool whose constructor does not forward
it — `FunctionTool`, for one — takes it by assignment:

```ts
import {FunctionTool} from '@google/adk';

const notify = new FunctionTool({
  name: 'notify',
  description: 'Sends a notification.',
  execute: async () => ({sent: true}),
});
notify.customMetadata = {owner: 'catalog'};
```

## Response scheduling

`responseScheduling` sets when the model reacts to this tool's answer. It
applies to the Live API; a model without asynchronous function calling ignores
it. The value is the `FunctionResponseScheduling` enum from `@google/genai`:
`SILENT` feeds the answer back without starting a model turn, `WHEN_IDLE`
defers the reaction until the model is idle, and `INTERRUPT` reacts
immediately.

```ts
import {FunctionTool} from '@google/adk';
import {FunctionResponseScheduling} from '@google/genai';

const notify = new FunctionTool({
  name: 'notify',
  description: 'Sends a notification.',
  execute: async () => ({sent: true}),
});
notify.responseScheduling = FunctionResponseScheduling.SILENT;
```

The emitted `FunctionResponse` then carries `scheduling: 'SILENT'`. A tool that
sets nothing emits a response with no `scheduling` key at all, so existing
tools keep their current event shape.
