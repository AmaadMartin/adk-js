# SetModelResponseTool

`SetModelResponseTool` lets an agent return structured output on a model that
cannot accept an output schema and tools in the same request. The output schema
becomes the parameters of a `set_model_response` tool, and the tool validates
what the model puts in it.

## Introduction

A Gemini 2.0 or later model on Vertex AI accepts a response schema and tools
together, so ADK sets the response schema and the model answers in JSON. Every
other combination rejects that request. `canUseOutputSchemaWithTools` in
`core/src/utils/output_schema_utils.ts` is the predicate that decides. When it
returns false, the answer has to come back as a function call instead.

`SetModelResponseTool` is the tool for that call. A function call is
model-generated text, so its arguments can violate the schema the model was
given. The tool validates them, and on failure it returns an error naming the
bad fields rather than throwing. The model reads that error as an ordinary
function response and calls again, so a malformed answer costs one extra turn
instead of ending the turn with bad data.

You do not construct the tool. `LlmAgent` adds it whenever the agent has both
an `outputSchema` and at least one tool, and the model cannot take the two
together. The tool publishes the validated answer on
`event.actions.setModelResponse`, and the agent promotes that value into its
final model event, which is also what fills `outputKey`.

## Get started

Give the agent an output schema and a tool. Nothing else is needed.

```ts
import {FunctionTool, LlmAgent} from '@google/adk';
import {z} from 'zod/v4';

const lookupTool = new FunctionTool({
  name: 'lookup',
  description: 'Looks a person up by name.',
  execute: () => ({age: 25, city: 'Seattle'}),
});

const agent = new LlmAgent({
  name: 'extractor',
  model: 'gemini-1.5-pro',
  tools: [lookupTool],
  outputKey: 'person',
  outputSchema: z.object({
    name: z.string().describe("A person's name"),
    age: z.number().describe("A person's age"),
    tags: z.array(z.string()).default([]),
  }),
});
```

The model calls `lookup`, then calls `set_model_response({name, age})`. The
agent's last event carries the validated object as JSON text, and `outputKey`
receives the validated value. `tags` may be absent, because a field with a
default is not advertised to the model as required.

## What the model sees

The tool's parameters follow the shape of the output schema.

| Output schema                                                 | Parameters                             |
| ------------------------------------------------------------- | -------------------------------------- |
| An object schema                                              | One parameter per field                |
| An array of objects                                           | A single required `items` parameter    |
| Anything else (an array of primitives, a record, a primitive) | A single required `response` parameter |

Field descriptions and defaults reach the declaration, at the top level and
inside nested objects and array items, so the model sees the same guidance a
native response schema would give it. A field carrying a default is not
advertised as required.

The declaration also follows the API variant, which
`getGoogleLlmVariant()` derives from the environment:

- On Vertex AI it carries `response: {type: STRING}`.
- On the Gemini API it carries no response schema, and every `format` keyword
  the Gemini API rejects is dropped from the parameters. A `z.email()` field
  loses `format: 'email'`; a `z.iso.datetime()` field keeps `format:
'date-time'`.

## Validation and retry

The tool validates the arguments against the schema as you supplied it, not the
converted form, so Zod refinements and defaults are enforced. On success it
strips the `null` and `undefined` fields from the result, which is what
adk-python's `model_dump(exclude_none=True)` does. The entries of an array are
all kept, including nulls.

On failure the tool publishes nothing and returns an error payload:

```
{
  error: 'Validation Error found:\nage: Invalid input: expected number, received string\nRecall the set_model_response function correctly, fix the errors, and call it again with all required fields using the correct types.'
}
```

Each line before the retry sentence is one failing field, written as
`path: message`. A failure inside an array element keeps its index, so the first
element's `id` field reads `0.id`.

Because the value is published only on success, a failed call leaves the agent
loop running and the model gets another turn.

## Limits

An output schema that is neither an object nor an array of objects is **not**
validated. Its value arrives under the `response` parameter and is returned and
published exactly as the model sent it. This matches adk-python, which reads
`args.get('response')` with no validation for those schemas.

A schema written as a genai `Schema` is validated only when it can be compiled
to a validator. `parseWithSchema` returns such a value unchecked rather than
rejecting it, so a schema using constructs Zod cannot express is passed through.
