# SlackRunner

`SlackRunner` puts an ADK agent into a Slack workspace. It wraps a `Runner` and
a [Bolt for JavaScript](https://docs.slack.dev/tools/bolt-js/) `App`, listens
for the two events a conversational bot needs, and writes the agent's answer
back into the channel or thread. Reach for it when you want an agent to answer
Slack messages and you do not want to write the event loop yourself.

## Introduction

Driving an agent from Slack looks simple and is not. You have to subscribe to
the right events, ignore the messages your own bot posted or the bot answers
itself in a loop, decide which Slack conversation maps onto which ADK session,
and keep the user informed while the model is still thinking. `SlackRunner`
does those four things and nothing else.

It sits above `Runner` rather than replacing it. You build the `Runner` — with
your agent, your session service and your plugins — and `SlackRunner` calls
`runAsync` on it once per incoming message. Everything a `Runner` gives you,
including session state and artifacts, works unchanged.

It is a thin adapter, so the pieces stay separate. Bolt owns the connection and
authentication. `Runner` owns the agent. `SlackRunner` owns only the mapping
between a Slack conversation and an ADK session, and the shape of the reply.

## Get started

The [module README](../../../../integrations/src/slack/README.md) owns the install command, the
Slack app setup and a runnable example. Start there and come back here for how
the runner behaves once it is connected.

One thing that README does not say: `start()` dials out to Slack over Socket
Mode, so the process needs no public URL and no inbound webhook route.

## Which messages the agent answers

Constructing a `SlackRunner` registers two listeners on the Bolt app.

- `app_mention` is always answered.
- `message` is answered only when it is a direct message (`channel_type` is
  `im`) or a reply inside a thread (`thread_ts` is present).

A `message` carrying `bot_id` or `bot_profile` is ignored. Without that guard
the agent's own posts come back as events and it answers itself.

Nothing else is handled. Slash commands, Block Kit interactions and assistant
threads are not supported.

## Sessions

One Slack thread maps onto one ADK session, and the caller creates it. The
README's Session Management section gives the keying rules and what happens
when the session is missing.

## What the user sees

The agent's reply arrives in three steps:

1. The runner posts `_Thinking..._` in the thread and keeps its timestamp.
2. The first text part the run produces replaces that placeholder, through
   `chat.update`. The user sees the placeholder turn into the answer.
3. Every later text part is posted as a new message in the same thread.

If the run finishes without producing any text, the placeholder is deleted
rather than left behind.

## Failure modes

A throw anywhere in the run is caught, logged through the ADK logger, and shown
to the user as `Sorry, I encountered an error: <message>`. Where it goes
depends on how far the reply got. If the placeholder is still on screen, the
error replaces it. If the first answer already consumed it, the error is a new
message, so the answer is not overwritten.

A failure while reporting the error is not caught again. It propagates to
Bolt's own error handling, which is the only place that can still surface it.

`start()` throws if the runner is already started, because Bolt's Socket Mode
client would otherwise drop the first connection and leave it open with nothing
able to close it. `stop()` closes the connection and does nothing if there is
none; after it, `start()` is allowed again.

If `@slack/bolt` is not installed, `start()` throws an error naming
`SlackRunner` and the `npm install` command. The rest of the module loads
without the package, so importing `@google/adk-integrations` never requires it.
