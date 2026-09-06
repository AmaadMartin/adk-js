# Output schema with tools

An `LlmAgent` that sets `outputSchema` returns a structured answer instead of
free text. Most models deliver that answer natively, through a response schema
on the request. Some models refuse a response schema and tools in the same
request, so ADK asks for the answer as a tool call instead. Reach for this page
when your agent has both an `outputSchema` and `tools`, and you need to know
what the run emits.

## Introduction

`canUseOutputSchemaWithTools` decides which path a run takes. It returns true
only on the Vertex AI variant with a Gemini 2.0 or later model. On that path the
basic request processor sets `config.responseSchema`, the model answers with
JSON text, and nothing on this page applies.

Everywhere else the model cannot hold both. `OutputSchemaRequestProcessor` then
declares a tool named `set_model_response` whose parameters are your output
schema, and appends one instruction telling the model to deliver its final
answer through that tool. The model calls the tool like any other; ADK checks
the arguments against the schema, and only an answer that satisfies the schema
becomes the agent's result. A rejected answer comes back to the model as an
error, so it gets another turn to correct itself.

The processor runs last in the agent's request-processor list, after the tool
filter, so the tool it declares is never filtered away. A `task`-mode agent is
left alone, because it already returns its structured result through
`finish_task`.

## Get started

Nothing needs enabling. Declare an `outputSchema` and at least one tool:

```ts
import {
  FunctionTool,
  InMemorySessionService,
  LlmAgent,
  Runner,
} from '@google/adk';
import {z} from 'zod';

const lookupPopulation = new FunctionTool({
  name: 'lookup_population',
  description: 'Returns the population of a city.',
  parameters: z.object({city: z.string()}),
  execute: ({city}) => (city === 'Paris' ? 2_100_000 : 0),
});

const agent = new LlmAgent({
  name: 'city_reporter',
  model: 'gemini-2.5-flash',
  outputSchema: z.object({city: z.string(), population: z.number()}),
  outputKey: 'report',
  tools: [lookupPopulation],
});

const runner = new Runner({
  appName: 'city_app',
  agent,
  sessionService: new InMemorySessionService(),
});
```

## What the run emits

A successful answer produces three events, in this order:

1. the model event carrying the `set_model_response` function call;
2. the function-response event, whose `actions.setModelResponse` holds the
   checked answer;
3. a model event whose only text part is the answer as JSON.

The third event is an ordinary final response, so a consumer that reads the
run's last text sees the answer without knowing a tool round-trip happened.
`outputKey`, when set, receives the parsed object from that event.

A rejected answer produces only the first two events. The function response
carries `{error: 'Validation Error found: ...'}` and
`actions.setModelResponse` stays unset, so the run continues and the model
answers again.

An ordinary tool call is unaffected: it produces the model event and the
function-response event, and the run continues as usual.

## Reading the answer

`getStructuredModelResponse` reads the checked answer off a function-response
event, and returns `undefined` for every other event, including a rejected
`set_model_response` call:

```ts
import {getStructuredModelResponse} from '@google/adk';

for await (const event of runner.runAsync({
  userId: 'user',
  sessionId,
  newMessage: {role: 'user', parts: [{text: 'Report on Paris.'}]},
})) {
  const answer = getStructuredModelResponse(event);
  if (answer !== undefined) {
    // `answer` is the JSON the final event will carry.
  }
}
```

## Limits

The tool declares the output schema as its parameters unchanged. adk-python
wraps a non-object schema, a list for example, in a generated `items` or
`response` parameter; this port does not. Use an object schema on this path.

The model chooses when to call `set_model_response`. ADK does not force the
call, so an agent whose instruction competes with the appended one may answer
in plain text instead. That text is stored under `outputKey` unparsed if it is
not valid JSON.
