# Slack Integration

The ADK Slack integration provides a `SlackRunner` to deploy your agents on
Slack using [Socket Mode](https://api.slack.com/apis/connections/socket).

## Prerequisites

`SlackRunner` ships in `@google/adk-integrations`. `@slack/bolt` is an
optional peer dependency, so install both:

```bash
npm install @google/adk-integrations @slack/bolt
```

## Slack App Configuration

To use the `SlackRunner`, set up a Slack App in the
[Slack API Dashboard](https://api.slack.com/apps).

### 1. Enable Socket Mode

In your app settings, go to **Socket Mode** and toggle **Enable Socket Mode**
to `on`. You are prompted to generate an **App-Level Token** (it starts with
`xapp-`). Give it the `connections:write` scope.

### 2. Configure Scopes

Go to **OAuth & Permissions** and add these **Bot Token Scopes**:

- `app_mentions:read`: to receive mention events.
- `chat:write`: to send messages.
- `im:history`: to answer in direct messages.
- `groups:history` (optional): to answer in private channels.
- `channels:history` (optional): to answer in public channels.

### 3. Subscribe to Events

Go to **Event Subscriptions**:

- Toggle **Enable Events** to `on`.
- Under **Subscribe to bot events**, add:
  - `app_mention`: to answer when somebody mentions the bot.
  - `message.im`: to answer in direct messages.

### 4. Install the App to a Workspace

Install the app to your workspace to get the **Bot User OAuth Token** (it
starts with `xoxb-`).

## Usage

```typescript
import {InMemorySessionService, LlmAgent, Runner} from '@google/adk';
import {SlackRunner} from '@google/adk-integrations';
import {App} from '@slack/bolt';

const agent = new LlmAgent({name: 'slack_agent', model: 'gemini-2.5-flash'});
const sessionService = new InMemorySessionService();
const runner = new Runner({appName: 'slack_agent', agent, sessionService});

// Bolt builds its default HTTP receiver during construction and rejects a
// missing signing secret, even though Socket Mode never uses one.
const slackApp = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
});

// SlackRunner does not create sessions, so create one for each conversation
// you want answered, keyed the way the runner keys it.
await sessionService.getOrCreateSession({
  appName: 'slack_agent',
  userId: 'U01234567',
  sessionId: 'C01234567-1700000000.123456',
});

const slackRunner = new SlackRunner({runner, slackApp});
await slackRunner.start(process.env.SLACK_APP_TOKEN!);
```

Call `slackRunner.stop()` to close the connection.

## Session Management

The `SlackRunner` derives a session id from the conversation:

- **Direct messages**: the channel id and the message timestamp.
- **Threaded conversations**: the channel id and `thread_ts`, the timestamp of
  the parent message, so the thread keeps its context.
- **App mentions**: if the mention is not in a thread, the message timestamp
  (`ts`) is used with the channel id.

The caller creates the session. `Runner.runAsync` throws
`Session not found: <id>` when the session does not exist, and the runner shows
that error in the thread. Create the session before the first message of a
conversation, or use a session service that provisions one for you.

For the message flow and the failure modes, see the
[SlackRunner guide](../../../docs/guides/integrations/slack_runner/index.md).
