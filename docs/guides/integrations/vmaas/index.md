# AgentEngineSandboxComputer

`AgentEngineSandboxComputer` drives a Chrome browser that runs inside a Vertex
AI Agent Engine Computer Use Sandbox. Reach for it when an agent has to browse
the web and you do not want a browser on the machine that serves the agent.

## Introduction

A computer-use agent needs a browser it can click, type into and screenshot. A
browser on the serving host makes that host stateful: it has to be sized for
Chrome, it cannot be scaled down mid-conversation, and two server instances hold
two different browsers.

This class puts the browser in the sandbox service instead. It creates an agent
engine and a sandbox on first use, and it writes the engine name, the sandbox
name and the access token into session state. Any instance that later resumes
the session reads those four keys and reaches the same browser. The keys are the
ones adk-python writes, so a session started by either SDK resolves to the same
resources:

| Key                        | What it holds                                 |
| -------------------------- | --------------------------------------------- |
| `_vmaas_agent_engine_name` | The reasoning engine the sandbox lives under. |
| `_vmaas_sandbox_name`      | The sandbox resource name.                    |
| `_vmaas_access_token`      | The token the sandbox requests carry.         |
| `_vmaas_token_expiry`      | When that token expires, in seconds.          |

The class implements `BaseComputer`, so every action returns a `ComputerState`
holding the screenshot and the URL captured after the action ran.

`@google-cloud/vertexai@1.12.0` exposes no method to mint a sandbox access token
and no method to send a command to a sandbox. Your application supplies both, as
`accessTokenProvider` and `sendCommand`. Everything else — creating the engine,
creating the sandbox, sharing them, refreshing the token — the class does.

## Get started

Give the computer the two transports, bind session state with `prepare()`, then
drive the browser. `mintSandboxToken` and `callSandbox` are the two functions
you write; the next section gives their types.

```ts
import {
  AccessTokenProvider,
  AgentEngineSandboxComputer,
  Context,
  SandboxCommandSender,
} from '@google/adk';

declare const mintSandboxToken: AccessTokenProvider;
declare const callSandbox: SandboxCommandSender;

const computer = new AgentEngineSandboxComputer({
  projectId: process.env.GOOGLE_CLOUD_PROJECT,
  serviceAccountEmail: process.env.SANDBOX_SERVICE_ACCOUNT,
  accessTokenProvider: mintSandboxToken,
  sendCommand: callSandbox,
});

export async function browse(context: Context): Promise<void> {
  await computer.prepare(context);
  await computer.navigate({url: 'https://example.com'});
  const state = await computer.clickAt({x: 100, y: 200});
  // state.screenshot holds PNG bytes, state.url the page the browser is on.
}
```

`prepare()` must run before any action. An action called before it fails with a
`SandboxError` carrying `SandboxErrorCode.SESSION_STATE_NOT_BOUND`, rather than
silently losing the sandbox at the end of the invocation.

## The two transports

`accessTokenProvider` mints a token for one sandbox:

```ts
type AccessTokenProvider = (params: {
  sandboxName: string;
  serviceAccountEmail?: string;
  timeoutSeconds: number;
}) => Promise<string>;
```

`sendCommand` carries one request to the sandbox and returns its body:

```ts
type SandboxCommandSender = (params: {
  httpMethod: 'GET' | 'POST';
  path: string;
  accessToken: string;
  sandbox: SandboxEnvironment;
  requestBody?: SandboxJson;
}) => Promise<{body?: string} | undefined>;
```

The computer asks for three paths: `cdp` for one Chrome DevTools Protocol
command, `cdps` for a batch of them, and `tabs` for the open tabs. A sandbox that
does not serve `cdps` makes the client send each command to `cdp` in turn, so a
transport only has to carry the request it is given.

Either transport being absent fails with
`SandboxErrorCode.TRANSPORT_NOT_CONFIGURED`, and it fails before anything is
created in your project.

## Choosing the sandbox

With no sandbox option the computer creates one, asking for a computer use
environment. Three options change that:

- `sandboxName` drives a sandbox you already own. Nothing is created, and the
  name is never written to session state.
- `sandboxTemplateName` builds the created sandbox from a template.
- `sandboxSnapshotName` restores the created sandbox from a snapshot.

Each of those names embeds the reasoning engine that owns it, and the computer
reads the engine out of the first one you set — `sandboxName`, then
`sandboxTemplateName`, then `sandboxSnapshotName`. That is what puts a created
sandbox under the engine that owns its template, which the backend requires.
`sandboxTtlSeconds` sets how long a created sandbox lives, one hour by default.

## Tokens and failures

A cached token is reused until it is within 60 seconds of expiring, and a new
one is asked to live for an hour. When minting fails, the computer drops the
shared token, sets the shared expiry to zero and tries once more; a second
failure reaches the caller. A token the backend has revoked therefore costs one
failed action rather than every action in the session.

`close()` does not delete the sandbox. The sandbox service deletes it when its
time to live expires, and until then an agent that restarts resumes the same
browser.

## Running it against a real project

The unit tests drive fake transports, so no test in this repository talks to
Vertex AI. To try it for real you need a Google Cloud project with the Vertex AI
API enabled, and a service account with `roles/iam.serviceAccountTokenCreator`
that your `accessTokenProvider` mints tokens for. Then call `navigate()` and read
`state.screenshot`: a PNG of the page you asked for means the whole path works.
