# BaseComputer and ComputerUseToolset

`BaseComputer` is the interface an agent uses to drive a computer environment,
such as a web browser. You implement it once for your automation stack.
`ComputerUseToolset` exposes that implementation to a Gemini computer-use model.
Reach for the pair when the agent has to operate a real user interface —
clicking, typing, scrolling and navigating — rather than call an API.

## Introduction

A computer-use model does not call tools you invent. It calls a fixed set of
predefined actions (`click_at`, `type_text_at`, `navigate`, and eleven more) and
expects a screenshot back after each one. `ComputerUseToolset` implements that
contract. You supply a driver, and the toolset turns it into the tools the model
expects and attaches the `computerUse` configuration the request needs.

The driver is the part you write, and `BaseComputer` is its interface. Every
action resolves to a `ComputerState`, which carries an optional PNG screenshot
and an optional current URL, so one call both acts and reports. The toolset
never talks to a browser itself and ADK ships no driver. Point it at Playwright,
Puppeteer, a remote sandbox, or anything else that can screenshot a page.

The class separates the parts you must supply from the parts you may ignore.
Sixteen members are abstract: `screenSize`, `environment`, and the fourteen
browser actions. Three lifecycle hooks are concrete and do nothing by default,
so you override only the ones your implementation needs:

- `prepare(context)` runs before each tool invocation. Use it for per-session
  resources, and persist them through `context.state`.
- `initialize()` runs once, before first use.
- `close()` releases resources.

Two things the toolset does for you are worth knowing before you start. It
scales the coordinates the model sends onto your real screen, so the model
always works in a 1000x1000 space. And it refuses a `navigate` to a private or
link-local address before your driver ever sees the URL, because the model
chooses that URL and a prompt can influence it.

`BaseComputer` is the counterpart of adk-python's
`google.adk.tools.computer_use.base_computer.BaseComputer`. Both classes are
`@experimental`, so their shape can change.

## Get started

Every action ends the same way: perform it, then report the new state. A single
`currentState()` helper keeps that shape in one place.

```ts
import {
  BaseComputer,
  ComputerEnvironment,
  ComputerState,
  ScrollDirection,
} from '@google/adk';

/** Whatever browser automation library you already use. */
interface BrowserDriver {
  readonly url: string;
  click(x: number, y: number): Promise<void>;
  hover(x: number, y: number): Promise<void>;
  type(x: number, y: number, text: string, enter: boolean): Promise<void>;
  scroll(direction: ScrollDirection, magnitude: number): Promise<void>;
  press(keys: string[]): Promise<void>;
  drag(x: number, y: number, toX: number, toY: number): Promise<void>;
  open(url: string): Promise<void>;
  history(step: -1 | 1): Promise<void>;
  screenshot(): Promise<Uint8Array>;
}

class BrowserComputer extends BaseComputer {
  constructor(private readonly driver: BrowserDriver) {
    super();
  }

  async screenSize(): Promise<[number, number]> {
    return [1920, 1080];
  }

  async environment(): Promise<ComputerEnvironment> {
    return ComputerEnvironment.ENVIRONMENT_BROWSER;
  }

  async currentState(): Promise<ComputerState> {
    return {url: this.driver.url, screenshot: await this.driver.screenshot()};
  }

  async openWebBrowser(): Promise<ComputerState> {
    await this.driver.open('https://example.com');
    return this.currentState();
  }

  async clickAt(params: {x: number; y: number}): Promise<ComputerState> {
    await this.driver.click(params.x, params.y);
    return this.currentState();
  }

  async hoverAt(params: {x: number; y: number}): Promise<ComputerState> {
    await this.driver.hover(params.x, params.y);
    return this.currentState();
  }

  async typeTextAt(params: {
    x: number;
    y: number;
    text: string;
    pressEnter?: boolean;
    clearBeforeTyping?: boolean;
  }): Promise<ComputerState> {
    await this.driver.type(
      params.x,
      params.y,
      params.text,
      params.pressEnter ?? true,
    );
    return this.currentState();
  }

  async scrollDocument(params: {
    direction: ScrollDirection;
  }): Promise<ComputerState> {
    await this.driver.scroll(params.direction, 1);
    return this.currentState();
  }

  async scrollAt(params: {
    x: number;
    y: number;
    direction: ScrollDirection;
    magnitude: number;
  }): Promise<ComputerState> {
    await this.driver.scroll(params.direction, params.magnitude);
    return this.currentState();
  }

  async wait(params: {seconds: number}): Promise<ComputerState> {
    await new Promise((resolve) => setTimeout(resolve, params.seconds * 1000));
    return this.currentState();
  }

  async goBack(): Promise<ComputerState> {
    await this.driver.history(-1);
    return this.currentState();
  }

  async goForward(): Promise<ComputerState> {
    await this.driver.history(1);
    return this.currentState();
  }

  async search(): Promise<ComputerState> {
    await this.driver.open('https://www.google.com');
    return this.currentState();
  }

  async navigate(params: {url: string}): Promise<ComputerState> {
    await this.driver.open(params.url);
    return this.currentState();
  }

  async keyCombination(params: {keys: string[]}): Promise<ComputerState> {
    await this.driver.press(params.keys);
    return this.currentState();
  }

  async dragAndDrop(params: {
    x: number;
    y: number;
    destinationX: number;
    destinationY: number;
  }): Promise<ComputerState> {
    await this.driver.drag(
      params.x,
      params.y,
      params.destinationX,
      params.destinationY,
    );
    return this.currentState();
  }
}
```

Then hand the driver to the toolset, and the toolset to an agent.

```ts
import {ComputerUseToolset, LlmAgent} from '@google/adk';

const agent = new LlmAgent({
  name: 'browser_agent',
  model: 'gemini-2.5-flash',
  tools: [new ComputerUseToolset({computer: new BrowserComputer(driver)})],
});
```

The toolset registers fourteen tools on the request and appends the
`computerUse` configuration once. Every action returns the new page state, which
the toolset renders as `{image: {mimetype: 'image/png', data: <base64>}, url}`.

## The contract you accept

These rules are not enforced by the type system. Read them before you implement
the actions.

**Coordinates are absolute pixels.** The `x`, `y`, `destinationX` and
`destinationY` values arrive already scaled to the screen width and height that
`screenSize()` reports. Never rescale them.

**An omitted flag means `true`.** `typeTextAt` takes optional `pressEnter` and
`clearBeforeTyping` flags. When the caller omits either one, press ENTER after
typing and clear the existing content before typing. adk-python declares these
defaults in the base signature. TypeScript cannot give an abstract method a
default, so honouring them is your responsibility.

**Screenshots are raw PNG bytes.** `ComputerState.screenshot` is a
`Uint8Array`, not a base64 string. The consumer decides the encoding.

## ComputerState

Every action resolves to a `ComputerState`. Both properties are optional.

| Property     | Type         | Meaning                            |
| ------------ | ------------ | ---------------------------------- |
| `screenshot` | `Uint8Array` | The current screen, in PNG format. |
| `url`        | `string`     | The URL of the webpage on display. |

An implementation that drives an environment with no URL omits `url`. One that
cannot capture the screen omits `screenshot`.

## Environments

`ComputerEnvironment` names the kind of environment an implementation drives.
`ENVIRONMENT_BROWSER` is a web browser. `ENVIRONMENT_UNSPECIFIED` means the
implementation did not say, and a caller treats it as a browser.

## Coordinates

The model works in a virtual 1000x1000 space. The toolset scales `x`, `y`,
`destination_x` and `destination_y` onto the size your `screenSize()` reports,
truncates toward zero, and clamps the result to the screen. Your driver
therefore always receives real pixel coordinates.

`screenSize()` returns a `[width, height]` tuple, as adk-python does. The
toolset converts it to the named `ScreenSize` that `ComputerUseTool` takes.

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
  computer: new BrowserComputer(driver),
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
  computer: new BrowserComputer(driver),
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

| Hook               | When the toolset calls it      | What to put in it                                                                                                          |
| ------------------ | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `initialize()`     | Once, before the first action. | Launch the browser or the virtual machine.                                                                                 |
| `prepare(context)` | Before each tool invocation.   | Set up session-level resources, such as a sandbox or an access token. Use `context.state` to keep them across invocations. |
| `close()`          | Once, when the toolset closes. | Release everything `initialize()` acquired.                                                                                |

A driver you call yourself, without a toolset, follows the same order.

## Safety confirmation

When the model attaches a `safety_decision` of `require_confirmation` to a call,
the tool does not run it. It requests confirmation with the model's explanation
as the hint and returns an error telling the model to wait. Once the user
approves, the call runs and its response carries
`safety_acknowledgement: 'true'`. Once the user declines, the call returns
`{error: 'This tool call is rejected.'}`.
