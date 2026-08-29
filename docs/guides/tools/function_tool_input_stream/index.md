# FunctionTool input stream

A `FunctionTool` can receive a `LiveRequestQueue` as the third argument of its
`execute` callback. Reach for it when a tool must read a real-time feed — audio,
video, or user turns that arrive while the tool still runs — instead of one
argument object fixed at call time.

## Introduction

An ordinary tool call is one-shot. The model supplies the arguments, `execute`
runs, and the tool returns a value. A live (bidirectional-streaming) session can
also give a tool its own input channel, so the tool keeps reading new data for
as long as it runs. ADK models that channel as a `LiveRequestQueue`, the same
queue type that feeds the model on the live path.

The queue travels on the invocation, not in the tool call.
`InvocationContext.activeStreamingTools` maps a tool name to an
`ActiveStreamingTool`, and that object's `stream` field holds the queue.
`FunctionTool` does the lookup for you, keyed by the tool's registered `name`,
and passes the result to `execute`. A tool therefore never reads the invocation
context itself, and never has to know the name it was registered under.

This mirrors adk-python, which injects the queue into a callback parameter named
`input_stream`. TypeScript erases parameter names at runtime, so adk-js declares
an optional positional parameter instead. A callback that declares one or two
parameters is still assignable and behaves exactly as before.

## Get started

The example below builds the invocation context by hand, sends two turns, and
closes the queue. It needs no model and no credentials.

```ts
import {
  ActiveStreamingTool,
  Context,
  createSession,
  FunctionTool,
  InvocationContext,
  LiveRequestQueue,
  PluginManager,
} from '@google/adk';
import {createUserContent} from '@google/genai';

const collectFeed = new FunctionTool({
  name: 'collect_feed',
  description: 'Collects live user turns until the stream closes.',
  execute: async (_input, _toolContext, inputStream) => {
    if (!inputStream) {
      return {error: 'collect_feed needs a live session.'};
    }
    const turns: string[] = [];
    for (;;) {
      const request = await inputStream.get();
      if (request.close) {
        break;
      }
      const text = request.content?.parts?.[0]?.text;
      if (text) {
        turns.push(text);
      }
    }
    return {turns};
  },
});

const stream = new LiveRequestQueue();
const invocationContext = new InvocationContext({
  invocationId: 'demo-invocation',
  session: createSession({id: 'demo-session', appName: 'demo'}),
  pluginManager: new PluginManager([]),
  activeStreamingTools: {collect_feed: new ActiveStreamingTool({stream})},
});

stream.sendContent(createUserContent('first'));
stream.sendContent(createUserContent('second'));
stream.close();

const result = await collectFeed.runAsync({
  args: {},
  toolContext: new Context({invocationContext}),
});
// result is {turns: ['first', 'second']}
```

## When the stream is present

`execute` receives `undefined` for `inputStream` unless all three of these hold:

- the invocation context carries `activeStreamingTools`;
- that record has an entry under the tool's `name`;
- that entry has a `stream`.

The lookup cannot throw, so the same tool runs in a live session and in an
ordinary turn. Handle `undefined` explicitly, as the example does.

The lookup key is the tool's `name`, not the name of the `execute` function. A
tool named in `ToolOptions` is found under that name even when `execute` is a
differently-named function.

`inputStream` never reaches the model. A `FunctionTool` declaration is built
from `ToolOptions.parameters`, so the stream is neither declared nor requestable
as an argument.

`LongRunningFunctionTool` extends `FunctionTool` and gets the same injection.

## Queue lifetime

The tool reads the queue but does not own it. Do not call `close()` on
`inputStream`: the code that created the queue closes it. `get()` resolves with
`{close: true}` once the queue is closed, which is the signal to stop reading.

## Current limitation

No adk-js flow populates `activeStreamingTools` yet. The consumer side described
here is complete, but the entry has to be supplied by whoever builds the
`InvocationContext`, as in the example above.
