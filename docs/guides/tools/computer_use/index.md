# ComputerUseToolset

Lets an agent drive a browser. You supply the driver; the toolset exposes it to
the model as the predefined Gemini computer-use functions, scales the
coordinates the model produces onto your real screen, and refuses a `navigate`
to a host that is not publicly routable.

## Introduction

A computer-use model does not call ordinary function declarations. It calls a
fixed action space — `click_at`, `type_text_at`, `navigate` and eleven others —
that the API declares itself once the request carries a `Tool.computerUse`
config. `ComputerUseToolset` attaches that config and registers each action, so
a function call the model sends back reaches your driver.

Reach for it when the task needs a real browser: a site with no API, a flow
behind a login, a form a person would fill in. Reach for a normal `FunctionTool`
when an API exists — it is faster, cheaper and deterministic.

Two things the toolset does that a hand-rolled set of tools would not. The model
works in a virtual 1000x1000 coordinate space, so its output does not depend on
your display; the toolset maps each coordinate onto the real screen and clamps
it. And `navigate` is the one action that turns a model-authored string into a
request from inside your network, so the toolset vets the url before the driver
sees it.

## Get started

Implement `BaseComputer` over the browser you use, then hand it to the toolset.

```ts
import {
  BaseComputer,
  ComputerEnvironment,
  ComputerState,
  ComputerUseToolset,
  LlmAgent,
} from '@google/adk';

/** Whatever your browser library gives you. */
interface BrowserPage {
  click(x: number, y: number): Promise<void>;
  screenshot(): Promise<Uint8Array>;
  url(): string;
}

class MyBrowser extends BaseComputer {
  constructor(private readonly page: BrowserPage) {
    super();
  }

  async screenSize(): Promise<[number, number]> {
    return [1920, 1080];
  }

  async environment(): Promise<ComputerEnvironment> {
    return ComputerEnvironment.ENVIRONMENT_BROWSER;
  }

  async clickAt(args: {x: number; y: number}): Promise<ComputerState> {
    await this.page.click(args.x, args.y);
    return this.currentState();
  }

  async currentState(): Promise<ComputerState> {
    return {screenshot: await this.page.screenshot(), url: this.page.url()};
  }

  // Implement the twelve remaining actions the same way. They are listed in
  // the table below; the class does not compile until all of them are there.
}

const agent = new LlmAgent({
  name: 'browser_agent',
  model: 'gemini-2.5-computer-use-preview-10-2025',
  tools: [new ComputerUseToolset({computer: new MyBrowser(page)})],
});
```

Every action returns a `ComputerState`: the PNG screenshot the model looks at
next, and the url it is on. The toolset base64-encodes the screenshot and sends
`{image: {mimetype: 'image/png', data}, url}` back to the model.

## The action space

Fourteen actions, named as the API names them. Each maps to one `BaseComputer`
method:

| Action             | Method           | Arguments                                              |
| ------------------ | ---------------- | ------------------------------------------------------ |
| `open_web_browser` | `openWebBrowser` |                                                        |
| `click_at`         | `clickAt`        | `x`, `y`                                               |
| `hover_at`         | `hoverAt`        | `x`, `y`                                               |
| `type_text_at`     | `typeTextAt`     | `x`, `y`, `text`, `press_enter`, `clear_before_typing` |
| `scroll_document`  | `scrollDocument` | `direction`                                            |
| `scroll_at`        | `scrollAt`       | `x`, `y`, `direction`, `magnitude`                     |
| `wait`             | `wait`           | `seconds`                                              |
| `go_back`          | `goBack`         |                                                        |
| `go_forward`       | `goForward`      |                                                        |
| `search`           | `search`         |                                                        |
| `navigate`         | `navigate`       | `url`                                                  |
| `key_combination`  | `keyCombination` | `keys`                                                 |
| `drag_and_drop`    | `dragAndDrop`    | `x`, `y`, `destination_x`, `destination_y`             |
| `current_state`    | `currentState`   |                                                        |

`press_enter` and `clear_before_typing` default to `true`.

Drop an action you do not want the model to use. The names also reach the API,
which stops declaring them:

```ts
new ComputerUseToolset({
  computer: new MyBrowser(),
  excludedPredefinedFunctions: ['drag_and_drop'],
});
```

## Coordinates

The model produces coordinates in a 1000x1000 space. The toolset maps each one
onto the real screen with `trunc(value / 1000 * size)` and clamps it to
`[0, size - 1]`. On a 1920x1080 screen, `x=500` becomes `960` and `x=1000`
becomes `1919`. Your driver always receives pixels.

## The navigate guard

`navigate` refuses a url and returns `{error, url}` — where `url` is the page
the browser is still on — when any of these hold:

- the value is not a string, or the url is malformed;
- the scheme is not `http` or `https`;
- the authority contains a backslash, because url parsers disagree about which
  host `http://example.com\@169.254.169.254/` names;
- the host is `localhost` or `*.localhost`;
- the host resolves to an address that is not globally routable — private,
  loopback, link-local, shared, reserved or multicast.

The shape checks are decided before any DNS lookup. To drive a local
development server, opt in:

```ts
new ComputerUseToolset({
  computer: new MyBrowser(),
  allowPrivateNetworkAccess: true, // permits http://localhost:3000/
});
```

That skips the host and address checks entirely, including the lookup. It does
not relax the scheme check: `file:///etc/passwd` is still refused.

The guard vets the host this process resolves. It does not pin the connection
the driver then makes, so a name that resolves twice can resolve differently the
second time.

## Safety confirmation

The model marks an action it considers risky with an out-of-band
`safety_decision`. When it asks for confirmation, the toolset requests approval
instead of acting, and returns an error telling the model to wait. The action
runs on the next turn once the user approves, and its response then carries
`safety_acknowledgement: 'true'`. If the user rejects it, the action never runs.

## Lifecycle

`getTools()` calls `initialize()` once, then `screenSize()`. The toolset
memoizes both, so concurrent callers still initialize one time.

`prepare(context)` runs before every action. Override it to bind
session-scoped resources — a sandbox handle, a token — from `context.state`,
which keeps the driver decoupled from the tool context.

`close()` closes the driver. `Runner` calls it when an invocation finishes.

An error your driver throws propagates to the caller. The toolset logs it and
rethrows; it does not turn it into a response for the model.
