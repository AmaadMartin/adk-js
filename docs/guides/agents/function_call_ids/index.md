# Function call ids in request contents

Every LLM request an `LlmAgent` sends replays the session history. This guide
explains how the framework decides whether a tool call keeps its id on the way
out, and how it repairs a history whose compaction summary swallowed a call.
Read it when you plug in a non-Gemini model, or when a compacted session raises
`No function call event found for function responses ids`.

## Introduction

A model asks for a tool by emitting a function call. When the model gives that
call no id, ADK assigns one prefixed `adk-` so it can match the result to the
call inside the framework. That id is a local invention, and the providers
disagree about whether they want it back.

Gemini's `generateContent` rejects a client-supplied id, so ADK strips every
`adk-` id from the contents it sends. The other protocols do the opposite.
Anthropic pairs a `tool_use` block with its `tool_result` block by id, and the
OpenAI-compatible endpoints pair `tool_calls[].id` with `tool_call_id`. Strip
the id there and the provider cannot tell which result answers which call: it
errors, or the model repeats the call it already made.

`BaseLlm.pairsToolCallsById` is how a model states which side it is on. It
defaults to `true`, because every tool-calling protocol other than Gemini
`generateContent` pairs by id. `Gemini` narrows it to `useInteractionsApi`, so a
plain Gemini agent keeps today's behaviour and a Gemini agent on the
Interactions API keeps its ids. `RoutedLlm` returns `true` only when every
candidate agrees, because the router picks the serving model after the contents
are already built.

Compaction is the second half of the story. A compaction summary replaces a run
of events with one text summary. It can swallow a `functionCall` whose
`functionResponse` arrives afterwards — a long-running tool is called, the turn
is compacted while the tool is still pending, then the real result is posted
back. The surviving response then has no call to pair with, and building the
request throws. `ContentRequestProcessor` re-injects the original call event,
taken from the pre-compaction event list, immediately before the response that
needs it.

Both behaviours are applied by `ContentRequestProcessor`, so an agent gets them
without configuring anything.

## Get started

A model that pairs by id needs no extra wiring. Any `BaseLlm` subclass inherits
the `true` default:

```ts
import {BaseLlm, BaseLlmConnection, LlmRequest, LlmResponse} from '@google/adk';

class MyProviderLlm extends BaseLlm {
  async *generateContentAsync(
    llmRequest: LlmRequest,
    stream?: boolean,
  ): AsyncGenerator<LlmResponse, void> {
    // Call your provider here. llmRequest.contents still carries the adk- ids.
  }

  async connect(llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error('Live is not supported by this provider.');
  }
}

const model = new MyProviderLlm({model: 'my-provider/some-model'});
model.pairsToolCallsById; // true
```

A Gemini model reports the protocol it is configured for. Both constructors
below read the API key from the environment:

```ts
import {Gemini} from '@google/adk';

new Gemini({model: 'gemini-2.5-flash'}).pairsToolCallsById; // false
new Gemini({model: 'gemini-2.5-flash', useInteractionsApi: true})
  .pairsToolCallsById; // true
```

Override the getter when a subclass serves a different protocol than its parent:

```ts
class MyGeminiProxy extends Gemini {
  override get pairsToolCallsById(): boolean {
    return true;
  }
}
```

## Guarantees

- Only `adk-` prefixed ids are affected. An id the model itself supplied is
  never stripped.
- The session events are never modified. Contents are deep-copied before any id
  is removed, so a request built with the ids stripped leaves the stored events
  intact for the next request.
- Recovery costs one scan of the events on the common path, and returns the
  event list unchanged when no response is orphaned.
- A recovered call event is re-injected whole, not trimmed to the resumed call.
  A parallel call carries its thought signature on the first part only, and
  trimming would lose it.
- A recovered call still passes the branch and isolation-scope filters, so
  recovery cannot show an agent an event it was not allowed to see.

## Failure modes

A response whose call is absent from the pre-compaction events cannot be
recovered. That is unchanged behaviour: building the request throws
`No function call event found for function responses ids: <id>`. It means the
call event was never in the session, not that compaction removed it.

An agent that resolves to no model at all, or whose model cannot be built,
falls back to stripping the ids. `ContentRequestProcessor` does not raise that
error; the flow reports it when it calls the model.
