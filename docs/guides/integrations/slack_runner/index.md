# SlackRunner

`SlackRunner` puts an ADK agent behind a Slack bot. It answers mentions and
direct messages over [Socket Mode](https://api.slack.com/apis/connections/socket),
and keeps one ADK session per Slack thread. Reach for it when you already have
a working `Runner` and want Slack to be its front end.

## Introduction

A Slack bot needs three things an agent does not provide: an event
subscription, a way to decide which messages deserve an answer, and a place to
put the conversation history. `SlackRunner` supplies all three. It registers
`app_mention` and `message` listeners on a Slack Bolt app you construct, drops
the events a bot must not answer, and maps each Slack thread onto one ADK
session so the agent keeps the thread's context.

It wraps a `Runner`; it does not replace one. You keep control of the agent,
the session service and the artifact service, because you build the `Runner`
yourself. You also keep control of the Slack app, so any other Bolt listener,
middleware or receiver you register still works.

`SlackRunner` ships in `@google/adk-integrations` rather than `@google/adk`,
because `@slack/bolt` requires the Express v5 typings while the core package
pins v4. `@slack/bolt` is an optional peer dependency of that package, and
`SlackRunner` imports it for its types only, so it adds nothing to your bundle
until you install Bolt and pass an app.

## Get started

Install the packages:

```bash
npm install @google/adk @google/adk-integrations @slack/bolt
```

### Configure the Slack app

Create an app in the [Slack API dashboard](https://api.slack.com/apps), then:

1. Under **Socket Mode**, enable Socket Mode. Slack asks you to generate an
   app-level token, which starts with `xapp-`. Give it the `connections:write`
   scope.
2. Under **OAuth & Permissions**, add these bot token scopes:
   `app_mentions:read` to receive mentions, `chat:write` to post, and
   `im:history` to answer direct messages. Add `groups:history` or
   `channels:history` if the bot must answer threads in private or public
   channels.
3. Under **Event Subscriptions**, enable events and subscribe the bot to
   `app_mention` and `message.im`.
4. Install the app to your workspace. That gives you the bot token, which
   starts with `xoxb-`.

### Run the agent

```typescript
import {InMemoryRunner, LlmAgent} from '@google/adk';
import {SlackRunner} from '@google/adk-integrations';
import {App} from '@slack/bolt';

const agent = new LlmAgent({
  name: 'slack_agent',
  model: 'gemini-2.5-flash',
  instruction:
    'You are a helpful Slack bot powered by Google ADK. Be concise and friendly.',
});

const slackApp = new App({
  token: process.env.SLACK_BOT_TOKEN,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN,
});

await new SlackRunner({
  runner: new InMemoryRunner({agent, appName: 'slack_app'}),
  slackApp,
}).start();
```

Both tokens go to the Bolt app, never to `SlackRunner`. Bolt binds the
app-level token when you construct the app, so `start()` takes no argument.
Calling `start()` a second time throws, because a second connection would
orphan the first.

## Which events get an answer

Every `app_mention` gets an answer. A `message` event gets one only when all of
these hold:

- it carries no subtype, so it is a plain message rather than an edit, a join
  notice or a file share;
- it has neither `bot_id` nor `bot_profile`, which stops the bot answering
  itself and looping;
- it is a direct message (`channel_type` is `im`) or a reply inside a thread.

An event with no text or no user is dropped without any Slack call.

## Sessions

The session id is the channel id and the thread timestamp, joined by a hyphen:
`C0123456789-1699999999.000100`. The thread timestamp is the event's
`thread_ts` when the message is a threaded reply, and its own `ts` otherwise.
So a mention starts a new session, and every reply in that thread continues it.
A direct message thread behaves the same way.

`SlackRunner` creates the session before the first run, through the runner's
session service, so the first message in a thread does not fail with
`Session not found`.

## What the bot posts

`SlackRunner` posts `_Thinking..._` into the thread as soon as it accepts an
event, so a slow agent still looks alive. It then edits that placeholder in
place with the first text the agent produces. Later text parts arrive as new
replies in the same thread. If the run produced no text at all, the
placeholder is deleted rather than left behind.

If the run throws, the thread gets `Sorry, I encountered an error: ` followed
by the error message, and the runner writes one line through the ADK logger.
The placeholder is reused for that message when it is still there.
