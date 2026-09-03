# set_model_response

Delivers an agent's structured output through a tool call, for the models that
cannot accept an output schema and tools in the same request. Reach for it
indirectly: an `LlmAgent` adds the tool for you when it needs it.

## Introduction

An `LlmAgent` with an `outputSchema` normally asks the model for a native
response schema. The API refuses that request when tools are configured too,
except on Vertex AI with a Gemini 2.0 or later model. ADK falls back to a
prompt-based workaround: it declares a tool named `set_model_response` whose
parameters _are_ the output schema, and instructs the model to answer by
calling it.

The value is in what the tool does with the call. It validates the arguments
against the output schema. A valid call is recorded and promoted to the agent's
final response. An invalid call is answered with the validation error, so the
model gets another turn to correct itself instead of the agent returning
unchecked data. Treat the arguments as untrusted: they are whatever the model
produced, and the schema you declared is what enforces them.

`createSetModelResponseTool` builds that tool. You rarely call it yourself —
`LlmAgent` does, under the condition above — but it is exported so that a
custom flow can reuse the same behaviour.

## Get started

Give the agent an output schema and at least one tool, on a model that cannot
combine the two:

```ts
import {LlmAgent, FunctionTool} from '@google/adk';
import {z} from 'zod/v4';

const agent = new LlmAgent({
  name: 'extractor',
  model: 'gemini-1.5-pro',
  outputKey: 'person',
  outputSchema: z.object({
    name: z.string().describe("A person's name"),
    age: z.number(),
    tags: z.array(z.string()).default([]),
  }),
  tools: [
    new FunctionTool({
      name: 'lookup',
      description: 'Looks a person up in the directory.',
      execute: () => 'Alice, 25',
    }),
  ],
});
```

The model calls `set_model_response({name: 'Alice', age: 25})`. The run emits
three events: the function call, the function response, and a final model
response whose text is `{"name":"Alice","age":25,"tags":[]}`. The declared
default for `tags` is applied, and `state['person']` holds the validated
object.

## What the model sees

The declaration depends on the shape of the output schema.

| Output schema                                              | Parameters                                                         |
| ---------------------------------------------------------- | ------------------------------------------------------------------ |
| An object schema                                           | one parameter per field, each carrying its description and default |
| An array of objects                                        | a single `items` parameter, typed as that array                    |
| Anything else — a primitive, a map, an array of primitives | a single `response` parameter                                      |

A field the schema declares optional stays optional in the declaration, so the
model is not told to supply it.

## Failure handling

A schema violation is data, not a fault. The tool returns

```json
{
  "error": "Validation Error found:\n<the validation error>\nRecall the set_model_response function correctly, fix the errors, and call it again with all required fields using the correct types."
}
```

and records nothing, so the agent emits no final response and the loop gives
the model another turn. Only a valid call sets
`event.actions.setModelResponse`, which is the signal the agent promotes.

Validation runs against the schema **as you supplied it**. A Zod refinement or
a custom message has no genai equivalent, so it would be lost if the converted
schema were used instead.
