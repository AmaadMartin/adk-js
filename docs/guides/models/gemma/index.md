# Gemma

`Gemma` runs an ADK agent on a Gemma 3 model through the Gemini API (Google AI
Studio). Reach for it when you want Gemma 3 behind the same `LlmAgent` code
that runs Gemini, including the tool calling that Gemma 3 has no native support
for.

## Introduction

Gemma 3 differs from Gemini in two ways that break an ordinary agent. It has no
function calling, so the API rejects a request that declares tools. It has no
system instruction channel either, so an instruction sent that way is lost.

`Gemma` is a `Gemini` subclass that closes both gaps in the prompt instead of
in the API. Before each request it writes the tool declarations into the
instruction text, rewrites the function calls and results already in the
history as text, and moves the whole instruction into a leading `user` turn. On
the way back it reads a function call out of the model's text and hands the
rest of ADK an ordinary `functionCall` part. Your agent code does not change.

Gemma 4 and later call functions natively, so they need none of this. `Gemini`
claims `gemma-4.*` and `Gemma` claims the rest of `gemma-*`, which is what the
registry resolves a model name through:

```ts
import {LLMRegistry} from '@google/adk';

LLMRegistry.resolve('gemma-3-27b-it'); // Gemma
LLMRegistry.resolve('gemma-4-31b-it'); // Gemini
```

`Gemma` supports the Gemini API only. It never selects Vertex AI, whatever the
environment says.

## Get started

Set `GOOGLE_GENAI_API_KEY`, `GOOGLE_API_KEY` or `GEMINI_API_KEY` to a key from
Google AI Studio, then name a Gemma 3 model:

```ts
import {FunctionTool, Gemma, InMemoryRunner, LlmAgent} from '@google/adk';
import {z} from 'zod';

const getWeather = new FunctionTool({
  name: 'get_weather',
  description: 'Returns the weather for a city.',
  parameters: z.object({city: z.string().describe('The city to look up.')}),
  execute: ({city}) => `It is 15C and cloudy in ${city}.`,
});

const agent = new LlmAgent({
  name: 'assistant',
  model: new Gemma({model: 'gemma-3-27b-it'}),
  instruction: 'You are a concise assistant.',
  tools: [getWeather],
});

const runner = new InMemoryRunner({agent, appName: 'gemma_app'});
const session = await runner.sessionService.createSession({
  appName: 'gemma_app',
  userId: 'u1',
});

let answer = '';
for await (const event of runner.runAsync({
  userId: 'u1',
  sessionId: session.id,
  newMessage: {role: 'user', parts: [{text: 'What is the weather in Paris?'}]},
})) {
  answer += event.content?.parts?.[0]?.text ?? '';
}
```

`model` defaults to `gemma-3-27b-it`. For agentic use `gemma-3-27b-it` or
`gemma-3-12b-it`; the smaller sizes follow the JSON format less reliably. The
model list is at https://ai.google.dev/gemma/docs/core/ .

The constructor takes the same parameters as `Gemini`, and throws when it finds
no API key.

## What the model receives

A request that declares one tool reaches the API as a single `user` turn ahead
of the conversation, and with no tools attached:

```
You have access to the following functions:
[{"name":"get_weather","description":"Returns the weather for a city.","parameters":{...}}
]
When you call a function, you MUST respond in the format of: {"name": function name, "parameters": dictionary of argument name and its value}
When you call a function, you MUST NOT include any other text in the response.
```

A tool result from an earlier turn arrives as text in the same stream:

```
Invoking tool `get_weather` produced: `{"temp": "15C"}`.
```

An instruction that already leads the history is not added twice, so a
preserved conversation does not accumulate copies of it.

## What comes back

A response whose single text part decodes to a function call becomes a
`functionCall` part. All of these decode:

- a bare object, `{"name": "get_weather", "parameters": {"city": "Paris"}}`;
- the same object in a ` ```json ` or ` ```tool_code ` fenced block;
- an object embedded in a sentence, in which case the last object in the text
  wins;
- `function` in place of `name`, and `args` in place of `parameters`.

Anything else stays text. A response that is not JSON, or is JSON of another
shape, is logged at debug level and passed through unchanged, so a malformed
answer never fails the run.

Two responses are never parsed: a partial streaming chunk, and the
turn-complete marker. A Gemma 3 function call is therefore recovered from a
complete response only.

## Check it against a live model

The tests use a mocked client, so a real endpoint is worth one manual run.
Export an API key, point an agent with one tool at `gemma-3-27b-it` as above,
and ask a question the tool answers. The agent must receive a structured tool
call and the tool must run; raw JSON in the final text means the response
parser did not recognise the model's format.
