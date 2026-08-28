# ComputerUseToolset

`ComputerUseToolset` lets an agent drive a browser or another interactive
environment. You implement `BaseComputer` against the driver you already have —
Playwright, a remote sandbox, a device farm — and the toolset turns it into the
Gemini computer-use action space. Reach for it when the task is "operate this
application for me" rather than "call this API".

## Introduction

A computer-use model does not call your tools by name. It emits one of a fixed
set of predefined functions — `click_at`, `type_text_at`, `navigate` and eleven
others — and expects the runtime to perform them. The model also works in a
fixed virtual screen of 1000x1000, so its output does not depend on the display
it is driving.

That leaves three jobs, and the toolset does all three:

- It scales every coordinate from the virtual screen onto your real screen, so
  your driver only ever sees absolute pixels.
- It attaches `Tool.computerUse` to the outgoing request. The API populates the
  predefined function declarations from that config, so the tools do not declare
  themselves.
- It enforces the confirmation gate. When the model marks an action as risky,
  the action does not run until a human approves it.

This is different from a normal `FunctionTool`. There you choose the name, the
schema and the semantics. Here the wire contract is fixed by the model, and your
only job is to perform the action. It is also different from a
`BuiltInCodeExecutor`-style server-side tool: the actions run in your process,
against your driver, so you own the blast radius.

## Get started

Implement the abstract surface, then hand the driver to the toolset. `myDriver`
below stands for whatever library you already drive the environment with.

```ts
import {
  BaseComputer,
  ComputerEnvironment,
  ComputerState,
  ComputerUseToolset,
  LlmAgent,
} from '@google/adk';

class MyComputer extends BaseComputer {
  async screenSize(): Promise<[number, number]> {
    return [1920, 1080];
  }

  async environment(): Promise<ComputerEnvironment> {
    return ComputerEnvironment.ENVIRONMENT_BROWSER;
  }

  async clickAt(params: {x: number; y: number}): Promise<ComputerState> {
    await myDriver.click(params.x, params.y);
    return {screenshot: await myDriver.png(), url: myDriver.url()};
  }

  // ... the remaining actions
}

const agent = new LlmAgent({
  name: 'browser_agent',
  model: 'gemini-2.5-computer-use-preview-10-2025',
  tools: [new ComputerUseToolset({computer: new MyComputer()})],
});
```

Every action returns a `ComputerState`. Populate `screenshot` with PNG bytes and
`url` with the page the driver is on; the toolset base64-encodes the screenshot
into the payload the model reads.

## Coordinates

The model addresses a 1000x1000 screen. `ComputerUseTool` scales each coordinate
onto the real screen and clamps it into range, so 500 on a 1920x1080 display
arrives as 960 for `x` and 540 for `y`, and 1000 arrives as 1919 and 1079. Only
`x`, `y`, `destination_x` and `destination_y` are scaled; every other argument
reaches your driver unchanged.

Pass `virtualScreenSize` to `ComputerUseTool` if you need a different virtual
space. The default is `[1000, 1000]`.

## Restricting the action space

`excludedPredefinedFunctions` withholds actions from the model. The names are
the wire names, and they are also forwarded to the API, so the model is told
about the restriction rather than merely failing when it tries.

```ts
new ComputerUseToolset({
  computer: new MyComputer(),
  excludedPredefinedFunctions: ['drag_and_drop'],
});
```

## The navigate guard

`navigate` is the one action where a model-supplied string becomes a request
from inside your network. By default the toolset refuses any url that is not
`http` or `https`, and any url whose host is `localhost`-style or resolves to an
address that is not globally routable — private, loopback, link-local, CGNAT,
reserved or multicast.

A refused url does not reach your driver. The model gets an error and the page
it was already on:

```ts
{
  error: 'navigate refused: url must be http(s) and must not target a private or link-local address.',
  url: 'https://the-page-you-were-on.example.com/',
}
```

Set `allowPrivateNetworkAccess: true` to drive a local dev server. That skips
the hostname and address checks entirely — no DNS lookup happens — but the
scheme check still applies.

```ts
new ComputerUseToolset({
  computer: new MyComputer(),
  allowPrivateNetworkAccess: true,
});
```

The address check is a pre-flight lookup. Your driver resolves the name again
when it connects, so a residual DNS-rebinding window remains. Closing it needs
connection-level IP pinning inside your driver.

## The safety gate

When the model decides an action needs human approval it attaches a
`safety_decision` of `require_confirmation`. The tool then records a
confirmation request, sets `skipSummarization`, and returns an error instead of
running the action:

```ts
{
  error: 'This tool call requires confirmation, please approve or reject.';
}
```

Once a human approves, the action runs and its response carries
`safety_acknowledgement: 'true'`. A rejection returns
`{error: 'This tool call is rejected.'}` and the action never runs.

## Lifecycle

`getTools()` calls `initialize()` exactly once, even when callers race, and
returns the same tool instances afterwards. `close()` on the toolset closes the
computer. `prepare(context)` runs before every action, which is where a driver
binds per-session resources such as a sandbox handle.

## Adapting an action

`adaptComputerUseTool` swaps a registered action for a variant, for example to
bake in a fixed argument. Read the screen sizes off the original so the
replacement scales coordinates the same way.

```ts
await ComputerUseToolset.adaptComputerUseTool({
  name: 'wait',
  llmRequest,
  adapt: (tool) =>
    new ComputerUseTool({
      name: 'wait_5_seconds',
      description: 'Waits five seconds.',
      parameters: z.object({}),
      screenSize: tool.screenSize,
      virtualScreenSize: tool.virtualScreenSize,
      invoke: () => computer.wait({seconds: 5}),
    }),
});
```

An unknown action name, or one that is not registered on the request, is a
no-op: the call logs a warning and changes nothing.
