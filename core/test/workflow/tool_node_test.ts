/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {getFunctionResponses} from '../../src/events/event.js';
import {BasePlugin} from '../../src/plugins/base_plugin.js';
import {BaseTool, RunAsyncToolRequest} from '../../src/tools/base_tool.js';
import {node} from '../../src/workflow/node.js';
import {ToolNode} from '../../src/workflow/nodes/tool_node.js';
import {createIc, driveNode} from './test_helpers.js';

/** A tool that records the args it was called with and echoes them back. */
class EchoTool extends BaseTool {
  lastArgs?: Record<string, unknown>;
  lastFunctionCallId?: string;
  constructor() {
    super({name: 'echo', description: 'echoes its args'});
  }
  async runAsync({args, toolContext}: RunAsyncToolRequest): Promise<unknown> {
    this.lastArgs = args;
    this.lastFunctionCallId = toolContext.functionCallId;
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
    expect(events).toHaveLength(1);
    expect(getFunctionResponses(events[0])[0]?.name).toBe('echo');
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
    expect(events).toHaveLength(1);
    expect(getFunctionResponses(events[0])[0]?.name).toBe('long');
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

  it('reports the error when a long-running tool throws', async () => {
    const tool = new RecordingTool({
      name: 'long_boom',
      isLongRunning: true,
      throws: 'long tool exploded',
    });
    const {events, output} = await driveNode(new ToolNode(tool));

    expect(events).toHaveLength(1);
    expect(getFunctionResponses(events[0])[0]?.response).toEqual({
      error: 'long tool exploded',
    });
    expect(output).toEqual({error: 'long tool exploded'});
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
  // See `toolResponse()` in tool_node.ts for why the two are indistinguishable.
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

  // `BuildNodeOptions` still carries the key, so this call compiles.
  it('drops an override passed through node()', () => {
    expect(node(new EchoTool(), {rerunOnResume: true}).rerunOnResume).toBe(
      false,
    );
  });

  // `cloneWithOverrides` assigns the key after construction, so the pin in the
  // ToolNode constructor does not reach this route. See ToolNode's class doc.
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

/**
 * Ported from `google/adk-python`
 * `tests/unittests/workflow/test_tool_node.py` (ref `main`).
 *
 * Each `it(...)` keeps the Python test name verbatim, snake_case included, so
 * the two suites line up under grep. Python's mock tool returns its args, so
 * its assertions read the node output; `EchoTool` wraps its return, so these
 * read the args the tool received, which is the same coercion.
 */
describe('ToolNode parity with adk-python', () => {
  const argsFor = async (nodeInput?: unknown) => {
    const tool = new EchoTool();
    await driveNode(new ToolNode(tool), nodeInput);
    return tool.lastArgs;
  };

  it('test_tool_node_accepts_dict', async () => {
    const input = {param_a: 1, param_b: 'value'};
    expect(await argsFor(input)).toEqual(input);
  });

  it('test_tool_node_accepts_none', async () => {
    expect(await argsFor(null)).toEqual({});
  });

  it.each(['', '   ', '\n\t'])(
    'test_tool_node_accepts_empty_string (%j)',
    async (emptyInput) => {
      expect(await argsFor(emptyInput)).toEqual({});
    },
  );

  it('test_tool_node_accepts_json_string', async () => {
    const args = await argsFor('{"param_a": 1, "param_b": "value"}');
    expect(args).toEqual({param_a: 1, param_b: 'value'});
  });

  it('test_tool_node_accepts_content_with_json_string', async () => {
    const content = {
      role: 'user',
      parts: [{text: '{"param_a": 1, "param_b": "value"}'}],
    };
    expect(await argsFor(content)).toEqual({param_a: 1, param_b: 'value'});
  });

  it('test_tool_node_rejects_non_dict_json_string', async () => {
    await expect(argsFor('[1, 2, 3]')).rejects.toThrow(
      /The input to ToolNode must be an object of tool arguments/,
    );
  });

  it('test_tool_node_rejects_invalid_json_string', async () => {
    await expect(argsFor('not a json')).rejects.toThrow(
      /The input to ToolNode must be an object of tool arguments/,
    );
  });

  it('test_tool_node_rejects_non_dict_content', async () => {
    const content = {role: 'user', parts: [{text: 'not a json'}]};
    await expect(argsFor(content)).rejects.toThrow(
      /The input to ToolNode must be an object of tool arguments/,
    );
  });

  it('test_tool_node_function_call_id_uses_platform_id_provider', async () => {
    // adk-python mints the id through its `platform.uuid` provider, which a
    // test can swap for a deterministic one. adk-js has no such seam: the id
    // is `${nodePath}:${runId}`, which is already replay-stable, so the ported
    // assertion is that two runs at the same path see the same id.
    const first = new EchoTool();
    const second = new EchoTool();
    await driveNode(new ToolNode(first));
    await driveNode(new ToolNode(second));

    expect(first.lastFunctionCallId).toBe('echo:echo');
    expect(second.lastFunctionCallId).toBe(first.lastFunctionCallId);
  });
});
