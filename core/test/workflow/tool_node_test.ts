/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {getFunctionResponses} from '../../src/models/llm_response.js';
import {BasePlugin} from '../../src/plugins/base_plugin.js';
import {BaseTool, RunAsyncToolRequest} from '../../src/tools/base_tool.js';
import {node} from '../../src/workflow/node.js';
import {ToolNode} from '../../src/workflow/nodes/tool_node.js';
import {createIc, driveNode} from './test_helpers.js';

/** A tool that records the args it was called with and echoes them back. */
class EchoTool extends BaseTool {
  lastArgs?: Record<string, unknown>;
  constructor() {
    super({name: 'echo', description: 'echoes its args'});
  }
  async runAsync({args}: RunAsyncToolRequest): Promise<unknown> {
    this.lastArgs = args;
    return {echoed: args};
  }
}

/** A tool that writes to its context state and returns a scalar. */
class StateWritingTool extends BaseTool {
  constructor() {
    super({name: 'writer', description: 'writes state'});
  }
  async runAsync({toolContext}: RunAsyncToolRequest): Promise<unknown> {
    toolContext.state.set('touched', true);
    return 'done';
  }
}

/** What a {@link RecordingTool} writes on its context and hands back. */
interface RecordingToolOptions {
  name?: string;
  isLongRunning?: boolean;
  /** State keys the tool writes on its context. */
  state?: Record<string, unknown>;
  /** Artifact versions the tool records on its context. */
  artifacts?: Record<string, number>;
  /** The tool's return value; omitted means the tool returns nothing. */
  returns?: unknown;
  /** When set, the tool throws with this message instead of returning. */
  throws?: string;
}

/** A tool that records what it is told to and returns `options.returns`. */
class RecordingTool extends BaseTool {
  lastArgs?: Record<string, unknown>;

  constructor(private readonly options: RecordingToolOptions = {}) {
    super({
      name: options.name ?? 'recorder',
      description: 'records what it is told to',
      isLongRunning: options.isLongRunning,
    });
  }

  async runAsync({args, toolContext}: RunAsyncToolRequest): Promise<unknown> {
    this.lastArgs = args;
    for (const [key, value] of Object.entries(this.options.state ?? {})) {
      toolContext.state.set(key, value);
    }
    // Written straight onto the actions: `saveArtifact` needs an artifact
    // service, and the delta is what this test is about.
    Object.assign(
      toolContext.actions.artifactDelta,
      this.options.artifacts ?? {},
    );
    if (this.options.throws !== undefined) {
      throw new Error(this.options.throws);
    }
    return this.options.returns;
  }
}

describe('ToolNode execution', () => {
  it('invokes the tool with coerced args and surfaces the response', async () => {
    const tool = new EchoTool();
    const {events, output} = await driveNode(new ToolNode(tool), {city: 'ams'});

    expect(tool.lastArgs).toEqual({city: 'ams'});
    expect(output).toEqual({echoed: {city: 'ams'}});
    // The event carries a canonical functionResponse part (visible to history).
    const responses = getFunctionResponses(events.at(-1)!);
    expect(responses[0]?.name).toBe('echo');
  });

  it('propagates tool context state writes onto the emitted event', async () => {
    const {events} = await driveNode(new ToolNode(new StateWritingTool()));
    expect(events.at(-1)?.actions.stateDelta).toEqual({touched: true});
  });

  it('runs the plugin tool-callback chain (before_tool_callback override)', async () => {
    const tool = new EchoTool();
    class OverridePlugin extends BasePlugin {
      constructor() {
        super('override');
      }
      override async beforeToolCallback(): Promise<Record<string, unknown>> {
        return {overridden: true};
      }
    }
    const ic = createIc();
    ic.pluginManager.registerPlugin(new OverridePlugin());

    const {output} = await driveNode(new ToolNode(tool), {a: 1}, ic);

    // The plugin short-circuited the call: its response wins and the tool's own
    // runAsync never ran — proof ToolNode goes through the shared execution path.
    expect(output).toEqual({overridden: true});
    expect(tool.lastArgs).toBeUndefined();
  });
});

describe('ToolNode long-running tools', () => {
  it('runs a long-running tool that returns a response', async () => {
    const tool = new RecordingTool({
      name: 'long',
      isLongRunning: true,
      returns: {ticket: 7},
    });
    const {events, output} = await driveNode(new ToolNode(tool), {id: 1});

    expect(tool.lastArgs).toEqual({id: 1});
    expect(output).toEqual({ticket: 7});
    expect(getFunctionResponses(events.at(-1)!)[0]?.name).toBe('long');
  });

  it('emits a state-delta-only event when it defers its response', async () => {
    const tool = new RecordingTool({
      isLongRunning: true,
      state: {pending: true},
    });
    const {events, output} = await driveNode(new ToolNode(tool));

    expect(events).toHaveLength(1);
    expect(events[0].actions.stateDelta).toEqual({pending: true});
    expect(getFunctionResponses(events[0])).toEqual([]);
    expect(events[0].content).toBeUndefined();
    expect(output).toBeUndefined();
  });

  it('emits nothing when it defers its response and records nothing', async () => {
    const {events, output} = await driveNode(
      new ToolNode(new RecordingTool({isLongRunning: true})),
    );

    expect(events).toEqual([]);
    expect(output).toBeUndefined();
  });

  it('carries an artifact delta onto the state-delta-only event', async () => {
    const tool = new RecordingTool({
      isLongRunning: true,
      artifacts: {'report.txt': 1},
    });
    const {events} = await driveNode(new ToolNode(tool));

    expect(events).toHaveLength(1);
    expect(events[0].actions.artifactDelta).toEqual({'report.txt': 1});
  });
});

describe('ToolNode tools that return nothing', () => {
  it('emits a state-delta-only event instead of an empty response', async () => {
    const tool = new RecordingTool({state: {seen: true}});
    const {events, output} = await driveNode(new ToolNode(tool));

    expect(events).toHaveLength(1);
    expect(events[0].actions.stateDelta).toEqual({seen: true});
    expect(getFunctionResponses(events[0])).toEqual([]);
    expect(output).toBeUndefined();
  });

  it('emits nothing when the tool records nothing either', async () => {
    const {events, output} = await driveNode(new ToolNode(new RecordingTool()));

    expect(events).toEqual([]);
    expect(output).toBeUndefined();
  });

  it('treats a real {result: ...} response as a response', async () => {
    const tool = new RecordingTool({returns: {result: 'x'}});
    const {output} = await driveNode(new ToolNode(tool));

    expect(output).toEqual({result: 'x'});
  });

  // Known divergence from adk-python, pinned so it cannot change unnoticed.
  // `_tool_node.py` tests `response is not None` against the tool's raw return,
  // so the dict `{'result': None}` is a response there and yields
  // `Event(output={'result': None})`. Here `handleFunctionCallList` wraps a
  // nullish return as `{result: <nullish>}` before ToolNode sees it, so by then
  // the two are one payload and both take the no-response path.
  it('cannot tell {result: null} from no response at all', async () => {
    const returned = new RecordingTool({name: 'r1', returns: {result: null}});
    const nothing = new RecordingTool({name: 'r2'});

    const withResult = await driveNode(new ToolNode(returned));
    const withNothing = await driveNode(new ToolNode(nothing));

    expect(withResult.output).toBeUndefined();
    expect(withResult.events).toEqual([]);
    expect(withNothing.output).toBeUndefined();
    expect(withNothing.events).toEqual([]);
  });

  it('treats a thrown error as a response, not as an empty result', async () => {
    const tool = new RecordingTool({name: 'boom', throws: 'tool exploded'});
    const {events, output} = await driveNode(new ToolNode(tool));

    expect(events).toHaveLength(1);
    expect(getFunctionResponses(events[0])[0]?.response).toEqual({
      error: 'tool exploded',
    });
    expect(output).toEqual({error: 'tool exploded'});
  });
});

describe('ToolNode rerunOnResume', () => {
  it('is false by default', () => {
    expect(new ToolNode(new EchoTool()).rerunOnResume).toBe(false);
  });

  // adk-python's `_ToolNode` passes `rerun_on_resume=False`, which `BaseNode`
  // already gives us. `rerunOnResume` is in OVERRIDABLE_KEYS, so the three
  // routes below are supported calls and must agree.
  it('honours an explicit override on the constructor', () => {
    expect(
      new ToolNode(new EchoTool(), {rerunOnResume: true}).rerunOnResume,
    ).toBe(true);
  });

  it('honours an explicit override through node()', () => {
    expect(node(new EchoTool(), {rerunOnResume: true}).rerunOnResume).toBe(
      true,
    );
  });

  it('honours an explicit override on an already-built ToolNode', () => {
    expect(
      node(new ToolNode(new EchoTool()), {rerunOnResume: true}).rerunOnResume,
    ).toBe(true);
  });
});

describe('ToolNode argument coercion', () => {
  const drive = async (input: unknown) => {
    const tool = new EchoTool();
    await driveNode(new ToolNode(tool), input);
    return tool.lastArgs;
  };

  it('passes an object through unchanged', async () => {
    expect(await drive({a: 1})).toEqual({a: 1});
  });

  it('parses a JSON-string input', async () => {
    expect(await drive('{"a":2}')).toEqual({a: 2});
  });

  it('extracts and parses text from genai Content', async () => {
    expect(await drive({role: 'user', parts: [{text: '{"a":3}'}]})).toEqual({
      a: 3,
    });
  });

  it('joins the text of a multi-part genai Content', async () => {
    expect(
      await drive({role: 'user', parts: [{text: '{"a":'}, {text: '4}'}]}),
    ).toEqual({a: 4});
  });

  it('treats null / empty string as no arguments', async () => {
    expect(await drive(null)).toEqual({});
    expect(await drive('')).toEqual({});
  });

  it('rejects array and scalar inputs', async () => {
    await expect(
      driveNode(new ToolNode(new EchoTool()), [1, 2]),
    ).rejects.toThrow(TypeError);
    await expect(driveNode(new ToolNode(new EchoTool()), 5)).rejects.toThrow(
      TypeError,
    );
  });
});
