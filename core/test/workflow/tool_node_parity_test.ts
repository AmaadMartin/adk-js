/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `ToolNode` tests ported from `google/adk-python`
 * `tests/unittests/workflow/test_tool_node.py` (ref `main`).
 *
 * Each `it(...)` keeps the Python test name verbatim, snake_case included, so
 * the two suites line up under grep.
 */

import {describe, expect, it} from 'vitest';
import {BaseTool, RunAsyncToolRequest} from '../../src/tools/base_tool.js';
import {ToolNode} from '../../src/workflow/nodes/tool_node.js';
import {driveNode} from './test_helpers.js';

/** A mock tool that returns the args it was called with. */
class MockTool extends BaseTool {
  lastFunctionCallId?: string;

  constructor() {
    super({name: 'mock_tool', description: 'Mock tool'});
  }

  async runAsync({args, toolContext}: RunAsyncToolRequest): Promise<unknown> {
    this.lastFunctionCallId = toolContext.functionCallId;
    return args;
  }
}

/** Runs a `ToolNode` over `MockTool` with `nodeInput`, returning its output. */
async function runToolNode(nodeInput?: unknown): Promise<unknown> {
  const {output} = await driveNode(new ToolNode(new MockTool()), nodeInput);
  return output;
}

describe('ToolNode parity with adk-python', () => {
  it('test_tool_node_accepts_dict', async () => {
    const input = {param_a: 1, param_b: 'value'};
    expect(await runToolNode(input)).toEqual(input);
  });

  it('test_tool_node_accepts_none', async () => {
    expect(await runToolNode(null)).toEqual({});
  });

  it.each(['', '   ', '\n\t'])(
    'test_tool_node_accepts_empty_string (%j)',
    async (emptyInput) => {
      expect(await runToolNode(emptyInput)).toEqual({});
    },
  );

  it('test_tool_node_accepts_json_string', async () => {
    const output = await runToolNode('{"param_a": 1, "param_b": "value"}');
    expect(output).toEqual({param_a: 1, param_b: 'value'});
  });

  it('test_tool_node_accepts_content_with_json_string', async () => {
    const content = {
      role: 'user',
      parts: [{text: '{"param_a": 1, "param_b": "value"}'}],
    };
    expect(await runToolNode(content)).toEqual({param_a: 1, param_b: 'value'});
  });

  it('test_tool_node_rejects_non_dict_json_string', async () => {
    await expect(runToolNode('[1, 2, 3]')).rejects.toThrow(
      /The input to ToolNode must be an object of tool arguments/,
    );
  });

  it('test_tool_node_rejects_invalid_json_string', async () => {
    await expect(runToolNode('not a json')).rejects.toThrow(
      /The input to ToolNode must be an object of tool arguments/,
    );
  });

  it('test_tool_node_rejects_non_dict_content', async () => {
    const content = {role: 'user', parts: [{text: 'not a json'}]};
    await expect(runToolNode(content)).rejects.toThrow(
      /The input to ToolNode must be an object of tool arguments/,
    );
  });

  it('test_tool_node_function_call_id_uses_platform_id_provider', async () => {
    // adk-python mints the id through its `platform.uuid` provider, which a
    // test can swap for a deterministic one. adk-js has no such seam: the id
    // is `${nodePath}:${runId}`, which is already replay-stable, so the ported
    // assertion is that two runs at the same path see the same id.
    const first = new MockTool();
    const second = new MockTool();
    await driveNode(new ToolNode(first));
    await driveNode(new ToolNode(second));

    expect(first.lastFunctionCallId).toBe('mock_tool:mock_tool');
    expect(second.lastFunctionCallId).toBe(first.lastFunctionCallId);
  });
});
