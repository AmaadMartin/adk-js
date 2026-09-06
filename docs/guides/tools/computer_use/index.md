# BaseComputer

`BaseComputer` is the interface a computer-use backend implements. It names a
fixed set of actions — click, type, scroll, navigate — that drive an interactive
system such as a web browser, and every action reports the state that follows
it. Reach for it when you want a model to operate a screen instead of calling an
API.

## Introduction

A model that operates a computer needs two things from you: a list of actions it
can take, and a picture of what happened after each one. If every backend names
those actions differently, then the prompt, the tool schema and the coordinate
convention all change when you swap a browser driver for a virtual machine.

`BaseComputer` fixes that list. The sixteen abstract members are the action set,
and each action returns a `ComputerState` holding the screenshot and the URL
after the action ran. A backend supplies the mechanism — Playwright, a remote
desktop protocol, a sandboxed virtual machine — and nothing above it changes.

The class is a contract and holds no state. adk-js ships the contract on its
own: no toolset in the library calls a `BaseComputer`, so you drive one from
your own code.

## Get started

A backend extends `BaseComputer` and implements the sixteen actions. The example
below is complete and compiles; replace each body with real driver calls.

```ts
import {
  BaseComputer,
  ComputerEnvironment,
  ComputerState,
  ScrollDirection,
} from '@google/adk';

class DemoComputer extends BaseComputer {
  private currentUrl = 'https://example.com';

  async screenSize(): Promise<[number, number]> {
    return [1920, 1080];
  }

  async environment(): Promise<ComputerEnvironment> {
    return ComputerEnvironment.ENVIRONMENT_BROWSER;
  }

  async navigate(params: {url: string}): Promise<ComputerState> {
    this.currentUrl = params.url;
    return this.currentState();
  }

  async currentState(): Promise<ComputerState> {
    return {url: this.currentUrl, screenshot: await this.capture()};
  }

  async openWebBrowser(): Promise<ComputerState> {
    return this.currentState();
  }

  async clickAt(_params: {x: number; y: number}): Promise<ComputerState> {
    return this.currentState();
  }

  async hoverAt(_params: {x: number; y: number}): Promise<ComputerState> {
    return this.currentState();
  }

  async typeTextAt(_params: {
    x: number;
    y: number;
    text: string;
    pressEnter?: boolean;
    clearBeforeTyping?: boolean;
  }): Promise<ComputerState> {
    return this.currentState();
  }

  async scrollDocument(_params: {
    direction: ScrollDirection;
  }): Promise<ComputerState> {
    return this.currentState();
  }

  async scrollAt(_params: {
    x: number;
    y: number;
    direction: ScrollDirection;
    magnitude: number;
  }): Promise<ComputerState> {
    return this.currentState();
  }

  async wait(_params: {seconds: number}): Promise<ComputerState> {
    return this.currentState();
  }

  async goBack(): Promise<ComputerState> {
    return this.currentState();
  }

  async goForward(): Promise<ComputerState> {
    return this.currentState();
  }

  async search(): Promise<ComputerState> {
    return this.navigate({url: 'https://www.google.com'});
  }

  async keyCombination(_params: {keys: string[]}): Promise<ComputerState> {
    return this.currentState();
  }

  async dragAndDrop(_params: {
    x: number;
    y: number;
    destinationX: number;
    destinationY: number;
  }): Promise<ComputerState> {
    return this.currentState();
  }

  private async capture(): Promise<Uint8Array> {
    return new Uint8Array();
  }
}
```

TypeScript rejects a subclass that omits an action, so an incomplete backend
fails the type check rather than failing at run time.

## Coordinates

Every `x`, `y`, `destinationX` and `destinationY` value is an absolute pixel
coordinate, already scaled to the width and height of the screen your
`screenSize()` reports. A backend uses these values as they arrive. It must not
rescale them, because the caller has scaled them already.

`BaseComputer` validates nothing. It has no constructor, holds no state and
throws nothing. A caller that accepts coordinates from a model is the place to
clamp them to the screen.

## Lifecycle

Three hooks default to no-ops, so a backend overrides only the ones it needs.

| Hook               | When you call it               | What to put in it                                                                                                          |
| ------------------ | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `initialize()`     | Once, before the first action. | Launch the browser or the virtual machine.                                                                                 |
| `prepare(context)` | Before each tool invocation.   | Set up session-level resources, such as a sandbox or an access token. Use `context.state` to keep them across invocations. |
| `close()`          | Once, when you are done.       | Release everything `initialize()` acquired.                                                                                |

`prepare()` receives the `Context` that a tool invocation already carries, which
is how a backend reads and writes session state.

## ComputerState

Both properties of `ComputerState` are optional.

| Property     | Type         | Meaning                            |
| ------------ | ------------ | ---------------------------------- |
| `screenshot` | `Uint8Array` | The current screen, in PNG format. |
| `url`        | `string`     | The URL of the webpage on display. |

A backend that controls an environment with no URL omits `url`, and one that
cannot capture the screen omits `screenshot`. The bytes stay raw here: a caller
that puts a screenshot on the wire encodes it itself.

## Environments

`ComputerEnvironment` names the kind of environment a backend controls.
`ENVIRONMENT_BROWSER` is a web browser. `ENVIRONMENT_UNSPECIFIED` means the
backend did not say, and a caller treats it as a browser.
