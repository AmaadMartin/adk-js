# ComputerUseTool

`ComputerUseTool` wraps one computer control function — a click, a scroll, a
drag — so a Gemini computer-use model can drive a real screen. Reach for it
when you already have a browser driver and you want the model to operate it.

## Introduction

A computer-use model does not know the size of your display. It addresses a
fixed virtual screen, 1000x1000 by default, so the same model output works on a
laptop and on a 4K monitor. Something has to map that virtual point onto a real
pixel. `ComputerUseTool` is that layer.

It does three things around your driver function.

1. It scales `x`, `y`, `destination_x` and `destination_y` from the virtual
   space onto `screenSize`, and clamps each one into `[0, dimension - 1]`.
2. It holds back an action the model flagged as unsafe until a human approves
   it. The model attaches a `safety_decision` to the call for this.
3. It converts a `ComputerState` result — a PNG screenshot plus the current url
   — into the payload the model reads back.

It is a `FunctionTool`, so `isFunctionTool` reports true for it and the usual
tool plumbing applies. It differs from a plain `FunctionTool` in one further
way: it declares nothing to the model. The computer-use API supplies the
declarations of its own predefined functions, so a declaration of ours would
duplicate them.

That last point has a consequence today. `ComputerUseToolset`, which attaches
the computer-use configuration to the request, is not yet ported to adk-js.
Until it lands, adding a `ComputerUseTool` to an `LlmAgent` does not make the
model call it — the tool never enters the request's tool dictionary. You can
construct the tool and run it yourself, which is what the section below shows.

## Get started

```ts
import {ComputerState, ComputerUseTool} from '@google/adk';

const clickAt = new ComputerUseTool({
  name: 'click_at',
  description: 'Clicks at a coordinate on the page.',
  screenSize: [1920, 1080],
  execute: async (args): Promise<ComputerState> => {
    const {x, y} = args;
    if (typeof x !== 'number' || typeof y !== 'number') {
      throw new Error('click_at needs numeric coordinates.');
    }
    await browser.clickAt(x, y);
    return {screenshot: await browser.screenshot(), url: browser.url()};
  },
});

// The model works in its 1000x1000 space; `execute` sees real pixels.
const response = await clickAt.runAsync({
  args: {x: 500, y: 300},
  toolContext,
});
// `execute` received {x: 960, y: 324}.
// `response` is {image: {mimetype: 'image/png', data: '<base64>'}, url: '...'}.
```

`name` is optional. Without it the tool takes the name of the `execute`
function, as `FunctionTool` does.

## Coordinate normalization

Only the four coordinate arguments are touched. Every other argument reaches
`execute` unchanged, and the record the model sent is left alone — the tool
normalizes a copy.

```ts
const dragAndDrop = new ComputerUseTool({
  name: 'drag_and_drop',
  description: 'Drags from one point to another.',
  screenSize: [1920, 1080],
  virtualScreenSize: [2000, 2000], // optional; [1000, 1000] by default
  execute: async (args) => runDrag(args),
});
```

Scaling truncates toward zero and then clamps, so a coordinate is always an
integer inside the screen. On a 1920x1080 screen addressed in the default
space, `1000` becomes `1919` rather than `1920`, and `-100` becomes `0`.

The constructor rejects a screen size that is not a pair of positive, finite
numbers. A coordinate argument that is not a number makes `runAsync` reject
with `x coordinate must be numeric, got string`.

## Safety confirmation

The computer-use model marks a risky action by attaching a `safety_decision` to
the call. When the decision reads `require_confirmation` and nobody has
approved the call yet, the tool does not touch the computer. It asks for
confirmation and returns an error payload instead:

```ts
const result = await clickAt.runAsync({
  args: {x: 500, y: 300, safety_decision: {decision: 'require_confirmation'}},
  toolContext,
});
// {error: 'This tool call requires confirmation, please approve or reject.'}
```

The tool calls `toolContext.requestConfirmation()` with the model's
`explanation` as the hint, or a default hint when the model supplied none, and
sets `toolContext.actions.skipSummarization`. `requestConfirmation` needs
`toolContext.functionCallId`, so a context without one throws.

When the call comes back carrying a `ToolConfirmation`:

- confirmed — the action runs, and the response gains
  `safety_acknowledgement: 'true'`. A response that is not an object is wrapped
  as `{result: <value>}` first.
- declined — the tool returns `{error: 'This tool call is rejected.'}` and the
  action does not run.

## Results

Return a `ComputerState` from `execute` and the tool converts it:

```ts
{image: {mimetype: 'image/png', data: '<base64 screenshot>'}, url: '<page url>'}
```

The conversion is exact: a value counts as a `ComputerState` only when its
`screenshot` holds bytes and it carries no key other than `screenshot` and
`url`. Anything else your driver returns — a status object, a string, an error
payload — is passed back to the model unchanged. Use `isComputerState` if you
need the same test in your own code.
