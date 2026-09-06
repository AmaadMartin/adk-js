# Gemini request and response logging

At the `DEBUG` log level the `Gemini` model prints the request it sends and the
response it receives. Reach for it when a model answers in a way you did not
expect and you need to see the exact system instruction, config, contents and
function declarations that went out.

## Introduction

An agent builds a request from many sources: the agent's instruction, the
session history, the tools it resolved, and the run config. By the time the
request reaches `Gemini.generateContentAsync` it is hard to tell which of those
produced the field you are looking at. The debug log prints the assembled
request in one block, so you can compare what you configured with what the
model actually received.

The log never prints `httpOptions`. That object holds `headers`, which commonly
carries an `Authorization` bearer token, and `baseUrl`, which carries the
credential itself when you point the client at a signed endpoint or an
authenticating proxy. The whole object is dropped, not selected fields, so a
field a future SDK version adds cannot leak either. The request that goes to
the API is unchanged; only the log omits the options.

Building the log costs a full serialization of the config and the contents.
Above `DEBUG` the model does not build the string at all.

## Get started

Set the log level before you run the agent:

```ts
import {Gemini, LogLevel, setLogLevel} from '@google/adk';

setLogLevel(LogLevel.DEBUG);

const model = new Gemini({model: 'gemini-2.5-flash'});

for await (const response of model.generateContentAsync({
  contents: [{role: 'user', parts: [{text: 'hello'}]}],
  liveConnectConfig: {},
  toolsDict: {},
})) {
  // handle the response
}
```

The model then emits one `LLM Request:` block per call and one `LLM Response:`
block per response. A streaming call emits one response block per chunk.

## What the blocks contain

`LLM Request:` has four sections, separated by dashed rules:

| Section            | Content                                     |
| ------------------ | ------------------------------------------- |
| System Instruction | `config.systemInstruction`, verbatim        |
| Config             | the rest of `config`, without `httpOptions` |
| Contents           | one JSON line per `Content`                 |
| Functions          | one line per function declaration           |

The declarations of the first tool that has them move to the Functions section,
so the Config section stays readable. Every other tool stays in the Config
section. The bytes of an inline blob are dropped from the Contents section; the
MIME type and the display name stay.

`LLM Response:` has three sections: the text of the first candidate with the
reasoning parts left out, the function calls, and the raw response as JSON.

## Failure modes

A config that cannot be serialized, such as one holding a circular schema,
prints `<error building config log>` for that section. The call still proceeds.
The builder does not fall back to a raw dump, because that would print the
credentials the exclusion exists to hide.

Two request errors are raised before any call reaches the API:

- `Gemini requests require a model name.` — neither the request nor the model
  instance supplies a non-blank model name.
- `Transparent session resumption is only supported for Vertex AI backend.
Please use Vertex AI backend.` — a live `connect` asked for
  `sessionResumption.transparent` on the Gemini API backend, which rejects it.
  Construct the model with `vertexai: true` to use transparent resumption.

## Custom loggers

`setLogger` accepts any object that implements `Logger`. Implement the optional
`isEnabledFor` member to let the model skip building a log your logger would
discard:

```ts
import {Logger, LogLevel, setLogger} from '@google/adk';

const lines: string[] = [];
const collectingLogger: Logger = {
  setLogLevel: () => {},
  isEnabledFor: (level) => level >= LogLevel.INFO,
  log: (level, ...args) => lines.push(`${LogLevel[level]} ${args.join(' ')}`),
  debug: () => {},
  info: (...args) => lines.push(`INFO ${args.join(' ')}`),
  warn: (...args) => lines.push(`WARN ${args.join(' ')}`),
  error: (...args) => lines.push(`ERROR ${args.join(' ')}`),
};

setLogger(collectingLogger);
```

A logger that omits `isEnabledFor` receives every message, so an existing custom
logger keeps working.
