# Tool connection map

Records which parameters a set of tools shares, and which tool creates or
consumes each one. Reach for it when you simulate an environment and a
simulated tool must return an identifier that a later tool call will accept.

## Introduction

Tools in one toolset are rarely independent. `create_ticket` returns a
`ticket_id`, and `get_ticket` expects that same `ticket_id` back. A simulator
that invents a fresh identifier per call breaks the second tool, because the
value it mocks never matches the value it handed out.

A tool connection map names those shared values. Each entry is a
`StatefulParameter`:

- `parameterName` is the shared value, such as `ticket_id`.
- `creatingTools` are the tools that generate it.
- `consumingTools` are the tools that take it as input.

The map holds no state itself. It is a plain description that a simulator reads
to decide whether a call mutates the environment, and which key it writes.

Three functions build one. `createStatefulParameter` and
`createToolConnectionMap` are the constructors: you pass camelCase fields, and
each returns a validated, fresh object. `parseToolConnectionMap` is the other
direction: it takes the document a model produced, with snake_case keys, and
validates it into the same shape.

## Get started

```ts
import {createStatefulParameter, createToolConnectionMap} from '@google/adk';

const map = createToolConnectionMap({
  statefulParameters: [
    createStatefulParameter({
      parameterName: 'ticket_id',
      creatingTools: ['create_ticket'],
      consumingTools: ['get_ticket', 'close_ticket'],
    }),
  ],
});

map.statefulParameters[0].parameterName; // 'ticket_id'
```

A nested factory call is optional. `createToolConnectionMap` also accepts plain
objects and validates them the same way:

```ts
const sameMap = createToolConnectionMap({
  statefulParameters: [
    {
      parameterName: 'ticket_id',
      creatingTools: ['create_ticket'],
      consumingTools: ['get_ticket', 'close_ticket'],
    },
  ],
});
```

Every field is required. There are no defaults, and no field is optional.

## An empty map is valid

A toolset whose tools share nothing has no stateful parameters:

```ts
createToolConnectionMap({statefulParameters: []}).statefulParameters;
// []
```

adk-python sets no minimum length either, and its analyzer returns an empty map
when it cannot read a model's reply.

## Reading a map a model produced

`parseToolConnectionMap` takes a decoded JSON document, not raw text. The
caller owns the decode, which is what adk-python's analyzer does, so you keep
control of how a malformed reply is handled:

```ts
import {parseToolConnectionMap} from '@google/adk';

const responseText =
  '{"stateful_parameters": [{"parameter_name": "ticket_id",' +
  ' "creating_tools": ["create_ticket"], "consuming_tools": ["get_ticket"]}]}';

const map = parseToolConnectionMap(JSON.parse(responseText));

map.statefulParameters[0].creatingTools; // ['create_ticket']
```

The wire keys stay snake_case. They are `stateful_parameters`,
`parameter_name`, `creating_tools` and `consuming_tools`, because adk-python's
analyzer prompt fixes those names in the reply it asks a model for. The
in-process fields are camelCase, which is the adk-js convention. The parse is
the boundary between the two.

## An unknown key is dropped

Every entry point drops a key it does not know, which is what a plain pydantic
model does. A language model may add a field the prompt never asked for, and
one extra field is not a reason to lose the whole map. A dropped key never
reaches the returned object:

```ts
parseToolConnectionMap({
  stateful_parameters: [
    {
      parameter_name: 'ticket_id',
      creating_tools: ['create_ticket'],
      consuming_tools: ['get_ticket'],
      confidence: 0.9,
    },
  ],
});
// {statefulParameters: [{parameterName: 'ticket_id', ...}]} — no confidence
```

A missing or wrong-typed field is still an error, and both entry points throw
`InputValidationError`. Because every field is required, a misspelled field
name still fails: it leaves the field it meant to set missing. That is how a
factory rejects the wire spelling, which only the parse understands:

```ts
createToolConnectionMap(JSON.parse('{"stateful_parameters": []}'));
// InputValidationError: Invalid ToolConnectionMap: ✖ Invalid input:
// expected array, received undefined → at statefulParameters
```

## Turning the feature off

The map is gated by the experimental `ENVIRONMENT_SIMULATION` feature, which is
on by default. Both factories throw when it is off:

```ts
import {
  FeatureName,
  createToolConnectionMap,
  overrideFeatureEnabled,
} from '@google/adk';

overrideFeatureEnabled(FeatureName.ENVIRONMENT_SIMULATION, false);

createToolConnectionMap({statefulParameters: []});
// Error: Feature ENVIRONMENT_SIMULATION is not enabled.
```

`parseToolConnectionMap` is not gated, and keeps working with the feature off.
That asymmetry matches adk-python: its `@experimental` decorator wraps
`__init__`, and `model_validate` builds through pydantic's core validator
instead.

The environment variable `ADK_DISABLE_ENVIRONMENT_SIMULATION` works from
outside the process:

```bash
ADK_DISABLE_ENVIRONMENT_SIMULATION=true node app.js
```

Pass `undefined` as the second argument to `overrideFeatureEnabled` to clear an
override.
