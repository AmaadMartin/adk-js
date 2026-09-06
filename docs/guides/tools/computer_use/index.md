# BaseComputer

`BaseComputer` is the interface an agent uses to drive a computer environment,
such as a web browser. You implement it once for your automation stack, and the
computer-use tooling calls it.

## Introduction

A computer-use agent needs two things from you: a way to perform an action, and
a way to see the result. `BaseComputer` defines both. Every action resolves to a
`ComputerState`, which carries an optional PNG screenshot and an optional
current URL, so one call both acts and reports.

The class separates the parts you must supply from the parts you may ignore.
Sixteen members are abstract: `screenSize`, `environment`, and the fourteen
browser actions. Three lifecycle hooks are concrete and do nothing by default,
so you override only the ones your implementation needs:

- `prepare(context)` runs before each tool invocation. Use it for per-session
  resources, and persist them through `context.state`.
- `initialize()` runs once, before first use.
- `close()` releases resources.

`BaseComputer` is the counterpart of adk-python's
`google.adk.tools.computer_use.base_computer.BaseComputer`. It is
`@experimental`, so its shape can change.

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
