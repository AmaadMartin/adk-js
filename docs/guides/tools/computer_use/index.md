# ComputerUseToolset

Exposes a browser or another interactive environment to a Gemini computer-use
model. Reach for it when the agent has to operate a real user interface —
clicking, typing, scrolling and navigating — rather than call an API.

## Introduction

A computer-use model does not call tools you invent. It calls a fixed set of
predefined actions (`click_at`, `type_text_at`, `navigate`, and eleven more) and
expects a screenshot back after each one. `ComputerUseToolset` implements that
contract. You supply a driver, and the toolset turns it into the tools the model
expects and attaches the `computerUse` configuration the request needs.

The driver is the part you write. `BaseComputer` declares one method per action,
so the toolset never talks to a browser itself and ADK ships no driver. Point it
at Playwright, Puppeteer, a remote sandbox, or anything else that can screenshot
a page.

Two things the toolset does for you are worth knowing before you start. It scales
the coordinates the model sends onto your real screen, so the model always works
in a 1000x1000 space. And it refuses a `navigate` to a private or link-local
address before your driver ever sees the URL, because the model chooses that URL
and a prompt can influence it.

## Get started

Implement `BaseComputer` over your browser driver, then hand it to the toolset.

```ts
import {
  BaseComputer,
  ComputerEnvironment,
  ComputerState,
  ComputerUseToolset,
  LlmAgent,
  ScreenSize,
  ScrollDirection,
} from '@google/adk';

class BrowserComputer extends BaseComputer {
  // Replace each body with the matching call on your browser driver.
  async screenSize(): Promise<ScreenSize> {
    return {width: 1280, height: 800};
  }
  async environment(): Promise<ComputerEnvironment> {
    return ComputerEnvironment.ENVIRONMENT_BROWSER;
  }
  async openWebBrowser(): Promise<ComputerState> {
    return this.capture();
  }
  async clickAt(x: number, y: number): Promise<ComputerState> {
    return this.capture();
  }
  async hoverAt(x: number, y: number): Promise<ComputerState> {
    return this.capture();
  }
  async typeTextAt(
    x: number,
    y: number,
    text: string,
    pressEnter?: boolean,
    clearBeforeTyping?: boolean,
  ): Promise<ComputerState> {
    return this.capture();
  }
  async scrollDocument(direction: ScrollDirection): Promise<ComputerState> {
    return this.capture();
  }
  async scrollAt(
    x: number,
    y: number,
    direction: ScrollDirection,
    magnitude: number,
  ): Promise<ComputerState> {
    return this.capture();
  }
  async wait(seconds: number): Promise<ComputerState> {
    return this.capture();
  }
  async goBack(): Promise<ComputerState> {
    return this.capture();
  }
  async goForward(): Promise<ComputerState> {
    return this.capture();
  }
  async search(): Promise<ComputerState> {
    return this.capture();
  }
  async navigate(url: string): Promise<ComputerState> {
    return this.capture(url);
  }
  async keyCombination(keys: string[]): Promise<ComputerState> {
    return this.capture();
  }
  async dragAndDrop(
    x: number,
    y: number,
    destinationX: number,
    destinationY: number,
  ): Promise<ComputerState> {
    return this.capture();
  }
  async currentState(): Promise<ComputerState> {
    return this.capture();
  }

  /** Returns a PNG screenshot of the page and the URL it sits on. */
  private async capture(url = 'https://example.com/'): Promise<ComputerState> {
    return {screenshot: new Uint8Array(), url};
  }
}

const agent = new LlmAgent({
  name: 'browser_agent',
  model: 'gemini-2.5-flash',
  tools: [new ComputerUseToolset({computer: new BrowserComputer()})],
});
```

The toolset registers fourteen tools on the request and appends the
`computerUse` configuration once. Every action returns the new page state, which
the toolset renders as `{image: {mimetype: 'image/png', data: <base64>}, url}`.

## Coordinates

The model works in a virtual 1000x1000 space. The toolset scales `x`, `y`,
`destination_x` and `destination_y` onto the size your `screenSize()` reports,
truncates toward zero, and clamps the result to the screen. Your driver
therefore always receives real pixel coordinates.

Pass a different space with `virtualScreenSize` on a `ComputerUseTool` if you
build one yourself. The toolset always uses the default.

## URL safety

`navigate` is the one action that takes a URL from the model, so the toolset
checks it first. It refuses a URL that is not `http` or `https`, one whose host
is `localhost`, one that resolves to a private, loopback or link-local address,
and one with a backslash in its authority. A refused call makes no DNS lookup
and no driver call, and returns:

```json
{
  "error": "navigate refused: url must be http(s) and must not target a private or link-local address.",
  "url": "<the page the browser is still on>"
}
```

Set `allowPrivateNetworkAccess: true` when the agent is meant to drive a local
development server. That skips both host checks together, so `localhost` and a
loopback address behave the same way. The scheme and backslash checks still
apply. Only use the flag against a host you control.

```ts
new ComputerUseToolset({
  computer: new BrowserComputer(),
  allowPrivateNetworkAccess: true,
});
```

The check is not a sandbox. The guard resolves the host, and then the browser
resolves it again and follows any redirect, so a DNS rebind or a `302` to a
private address still reaches the driver. Treat it as a guard against an obvious
mistake, not as a network boundary.

## Restrict the action space

`excludedPredefinedFunctions` takes the wire names of actions you do not want.
The toolset both drops those tools and tells the model about the exclusion, so
the model stops proposing them.

```ts
new ComputerUseToolset({
  computer: new BrowserComputer(),
  excludedPredefinedFunctions: ['drag_and_drop', 'key_combination'],
});
```

## Adapt one action

`ComputerUseToolset.adaptComputerUseTool` swaps one registered tool for your own
version. The adapter receives the original function and returns the replacement,
which is registered under its own name; the original name is removed. Use it to
constrain an action rather than remove it.

```ts
import {ComputerUseToolset, LlmRequest} from '@google/adk';

async function capWaitAtFiveSeconds(llmRequest: LlmRequest): Promise<void> {
  await ComputerUseToolset.adaptComputerUseTool(
    'wait',
    (original) => ({
      name: 'wait_five_seconds',
      description: 'Waits five seconds for the page to settle.',
      execute: () => original({seconds: 5}),
    }),
    llmRequest,
  );
}
```

The adapted tool keeps the original screen sizes. It also keeps the original
description and argument schema unless you supply your own, so declare
`parameters` whenever the replacement takes different arguments. The request is
left untouched if the name is not a predefined action, if no tool is registered
under it, or if the adapter returns an empty name.

## Lifecycle

The toolset owns the driver's lifecycle. It calls `initialize()` once, before
the tools are built. It calls `prepare(toolContext)` before every action, which
is where a driver that needs session state should read it. It calls `close()`
when the toolset closes. All three default to doing nothing.

## Safety confirmation

When the model attaches a `safety_decision` of `require_confirmation` to a call,
the tool does not run it. It requests confirmation with the model's explanation
as the hint and returns an error telling the model to wait. Once the user
approves, the call runs and its response carries
`safety_acknowledgement: 'true'`. Once the user declines, the call returns
`{error: 'This tool call is rejected.'}`.
