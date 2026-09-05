# Agent Engine sandbox computer

`AgentEngineSandboxComputer` drives a browser that runs inside a Vertex AI
Agent Engine Computer Use Sandbox. Reach for it when an agent must operate a
real browser and you do not want that browser on the machine running the agent.

## Introduction

A `BaseComputer` gives a caller fourteen browser actions — click, type, scroll,
navigate, and so on — and returns the screen state after each one. ADK ships
the abstraction; it does not ship the browser. `AgentEngineSandboxComputer` is
the implementation backed by a hosted browser, so the pages the agent visits
never touch the host, and the browser survives an agent restart.

The computer provisions what it needs on the first action. It creates an agent
engine and a sandbox environment, or reuses ones you already own. It then
writes the engine name, the sandbox name and the access token into session
state, under the same four keys adk-python uses:

| Key                        | Holds                                      |
| -------------------------- | ------------------------------------------ |
| `_vmaas_agent_engine_name` | The agent engine the sandbox lives under.  |
| `_vmaas_sandbox_name`      | The sandbox environment being driven.      |
| `_vmaas_access_token`      | The token authenticating sandbox requests. |
| `_vmaas_token_expiry`      | When that token expires, in seconds.       |

Because the names live in session state and not in the object, a second
invocation and a second agent server instance reach the same browser. The keys
are byte-identical to adk-python's, so a session written by either SDK resolves
to the same sandbox.

`close()` deliberately leaves the sandbox running. The sandbox service deletes
it when its time to live expires, and leaving it alive is what lets an agent
that restarts inside that window resume the same pages.

### The two transport seams

`@google-cloud/vertexai@1.12.0` exposes no sandbox `generateAccessToken` and no
sandbox `sendCommand`. adk-python reaches both through its Vertex AI client.
Until the JavaScript SDK ships them, you supply them:

- `accessTokenProvider` mints an access token for a sandbox.
- `sendCommand` carries one HTTP request to the sandbox.

An action taken without the matching seam throws a `SandboxError` whose `code`
is `SandboxErrorCode.SDK_TRANSPORT_UNAVAILABLE` and whose message names the
missing method.

## Get started

```ts
import {
  AgentEngineSandboxComputer,
  type AccessTokenProvider,
  type Context,
  type SandboxCommandSender,
} from '@google/adk';

// Supply these two yourself; see "The two transport seams" above.
declare const mintSandboxToken: AccessTokenProvider;
declare const callSandbox: SandboxCommandSender;

const computer = new AgentEngineSandboxComputer({
  projectId: process.env.GOOGLE_CLOUD_PROJECT,
  serviceAccountEmail: process.env.VMAAS_SERVICE_ACCOUNT,
  accessTokenProvider: mintSandboxToken,
  sendCommand: callSandbox,
});

/** Drives the browser for one invocation. `context` is its tool context. */
export async function browse(context: Context) {
  await computer.prepare(context);
  const state = await computer.navigate({url: 'https://example.com'});
  return {screenshot: state.screenshot, url: state.url};
}
```

`prepare()` binds the session state, so call it before the first action of
every invocation. An action taken before it throws a `SandboxError` with the
code `SESSION_STATE_NOT_BOUND`.

## Choosing the sandbox

Pass nothing and the computer creates an agent engine and a sandbox with a
computer use environment. Pass one of the three resource names to change that:

```ts
// Drive a sandbox you already own.
new AgentEngineSandboxComputer({
  sandboxName:
    'projects/p/locations/us-central1/reasoningEngines/123/sandboxEnvironments/456',
});

// Create a sandbox from a template, which starts faster.
new AgentEngineSandboxComputer({
  sandboxTemplateName:
    'projects/p/locations/us-central1/reasoningEngines/123/sandboxEnvironmentTemplates/789',
});

// Restore a sandbox from a snapshot.
new AgentEngineSandboxComputer({
  sandboxSnapshotName:
    'projects/p/locations/us-central1/reasoningEngines/123/sandboxEnvironmentSnapshots/789',
});
```

The agent engine is read from whichever name you supplied, because the backend
requires the sandbox to live under the engine that owns its template or
snapshot. `sandboxName` wins over `sandboxTemplateName`, which wins over
`sandboxSnapshotName`.

`sandboxTtlSeconds` sets how long a created sandbox lives; it defaults to one
hour. `searchEngineUrl` sets the page `search()` navigates to; it defaults to
`https://www.google.com`.

## What the computer guarantees

- **Every action reports the state after it.** Each action runs, then takes a
  screenshot and reads the active tab's URL.
- **The token is replaced before it expires.** A cached token is reused while
  more than 60 seconds remain on it. A failed token request clears the cache
  and is retried once; a second failure propagates.
- **A navigating page does not fail a read.** A screenshot or URL read that
  fails with a destroyed execution context, or with a navigation error, is
  retried up to three times, half a second apart. Any other failure is raised
  at once.
- **A sandbox without the batch path still works.** Multi-command actions post
  to the batch path first, and fall back to running the commands one at a time.
- **The screen is 1280 by 720 pixels.** `scrollDocument()` scrolls at its
  centre.

## Failure codes

`SandboxError.code` is one of:

| Code                            | Raised when                                     |
| ------------------------------- | ----------------------------------------------- |
| `SDK_TRANSPORT_UNAVAILABLE`     | An action needs a seam the caller did not pass. |
| `SESSION_STATE_NOT_BOUND`       | An action ran before `prepare()`.               |
| `AGENT_ENGINE_CREATE_TIMED_OUT` | Engine creation did not finish in time.         |
| `AGENT_ENGINE_NAME_MISSING`     | Engine creation returned no resource name.      |
| `SANDBOX_NAME_MISSING`          | Sandbox creation returned no resource name.     |
| `SCREENSHOT_DATA_MISSING`       | The screenshot response carried no image data.  |

Use `isSandboxError(e)` to narrow a caught value before reading `code`.
