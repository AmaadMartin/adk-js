/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Reference tests ported from adk-python
 * `tests/unittests/workflow/test_node_tool.py`, ref `main` at commit
 * a119dd7751082dbbd9a65f71e359abdc2be659cc. Each `it(...)` keeps the Python
 * test name verbatim so it can be grepped against the original.
 *
 * The eleven reference tests that exercise the child-run bridge (HITL resume,
 * join/dynamic/nested nodes, tool confirmation, concurrent isolation) are
 * covered by `tests/integration/workflows/node_as_tool*` and are not repeated
 * here; the PR body carries the full accounting.
 */

import {
  Event,
  FunctionNode,
  InMemoryRunner,
  LlmAgent,
  NodeContext,
  NodeTool,
  Workflow,
  getFunctionResponses,
  node,
} from '@google/adk';
import {FunctionResponse} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {z} from 'zod/v3';
import {ScriptedLlm} from './test_helpers.js';

/**
 * Runs `agent` for one user turn and returns every function response the turn
 * produced — the adk-js equivalent of the reference's `InMemoryRunner` plus
 * `MockModel` assertions.
 */
async function runTurn(agent: LlmAgent): Promise<FunctionResponse[]> {
  const runner = new InMemoryRunner({agent, appName: agent.name});
  const session = await runner.sessionService.createSession({
    appName: agent.name,
    userId: 'u1',
  });
  const events: Event[] = [];
  for await (const event of runner.runAsync({
    userId: 'u1',
    sessionId: session.id,
    newMessage: {role: 'user', parts: [{text: 'Run'}]},
  })) {
    events.push(event);
  }
  return events.flatMap((event) => getFunctionResponses(event));
}

/** An agent whose model calls `toolName` once with `args`, then answers. */
function callingAgent(
  toolName: string,
  args: Record<string, unknown>,
  tools: LlmAgent['tools'],
): LlmAgent {
  return new LlmAgent({
    name: 'parent_agent',
    model: new ScriptedLlm([
      {functionCall: {id: 'fc-1', name: toolName, args}},
      'Finished.',
    ]),
    tools,
  });
}

describe('NodeTool parity with adk-python', () => {
  it('test_node_tool_requires_input_schema', () => {
    // adk-js rejects an edgeless Workflow at construction, so the reference's
    // `edges=[]` becomes one no-op edge; the node under test is the workflow.
    const wf = new Workflow({
      name: 'no_schema_wf',
      edges: [['START', node(() => 'noop', {name: 'noop'})]],
    });
    expect(() => new NodeTool(wf)).toThrow(
      /does not have an inputSchema defined/,
    );
  });

  it('test_node_tool_rejects_agent', () => {
    const agent = new LlmAgent({
      name: 'my_agent',
      model: new ScriptedLlm(['Answer questions']),
    });
    expect(() => new NodeTool(agent)).toThrow(
      /cannot be wrapped as a NodeTool/,
    );
  });

  it('test_node_tool_auto_converts_function_node_binding', () => {
    const myFuncNode = new FunctionNode(
      'my_func_node',
      (_ctx: NodeContext, input: string) => `Result: ${input}`,
    );
    expect(myFuncNode.inputSchema).toBeUndefined();

    const tool = new NodeTool(myFuncNode);

    // adk-js has no `parameter_binding`: the handler already takes the node
    // input explicitly, so only the input-schema exemption is portable.
    expect(tool.node).toBe(myFuncNode);
    expect(tool._getDeclaration().parametersJsonSchema).toBeUndefined();
    expect(tool._getDeclaration().parameters).toBeUndefined();
  });

  it('test_node_tool_wraps_zero_argument_function', async () => {
    const getConstant = new FunctionNode('get_constant', () => 'constant_val');
    const tool = new NodeTool(getConstant);
    const declaration = tool._getDeclaration();
    expect(declaration.name).toBe('get_constant');
    expect(declaration.parametersJsonSchema).toBeUndefined();

    const responses = await runTurn(
      callingAgent('get_constant', {}, [getConstant]),
    );
    expect(responses).toHaveLength(1);
    expect(responses[0].response).toEqual({result: 'constant_val'});
  });

  it('test_node_tool_wraps_zero_argument_function (context only)', async () => {
    const getConstant = new FunctionNode(
      'get_constant',
      (ctx: NodeContext) => `constant_val:${ctx.invocationId !== ''}`,
    );
    const responses = await runTurn(
      callingAgent('get_constant', {}, [getConstant]),
    );
    expect(responses).toHaveLength(1);
    expect(responses[0].response).toEqual({result: 'constant_val:true'});
  });

  it('test_node_tool_primitive_input_schema', async () => {
    const echoFunc = node(
      (_ctx: NodeContext, input: string) => `Echo: ${input}`,
      {name: 'echo_func'},
    );
    const subWorkflow = new Workflow({
      name: 'sub_workflow',
      inputSchema: z.string(),
      edges: [['START', echoFunc]],
    });
    const tool = new NodeTool(subWorkflow, 'primitive_tool');

    const parameters = tool._getDeclaration().parametersJsonSchema as Record<
      string,
      Record<string, Record<string, unknown>>
    >;
    expect(parameters['type']).toBe('object');
    expect(parameters['properties']['request']['type']).toBe('string');

    const responses = await runTurn(
      callingAgent('primitive_tool', {request: 'hello_world'}, [tool]),
    );
    expect(responses).toHaveLength(1);
    expect(responses[0].response).toEqual({result: 'Echo: hello_world'});
  });

  it('test_node_tool_returns_structured_dict', async () => {
    const getUserProfile = node(
      (_ctx: NodeContext, input: {userId: string}) => ({
        id: input.userId,
        role: 'admin',
      }),
      {
        name: 'get_user_profile',
        inputSchema: z.object({userId: z.string()}),
        outputSchema: z.object({id: z.string(), role: z.string()}),
      },
    );
    const tool = new NodeTool(getUserProfile, 'get_user_profile');
    expect(tool._getDeclaration().responseJsonSchema).toMatchObject({
      type: 'object',
      properties: {id: {type: 'string'}, role: {type: 'string'}},
    });

    const responses = await runTurn(
      callingAgent('get_user_profile', {userId: 'user_123'}, [tool]),
    );
    expect(responses).toHaveLength(1);
    expect(responses[0].response).toEqual({id: 'user_123', role: 'admin'});
  });

  it('test_function_node_wrapped_as_tool_returns_output', async () => {
    const greetNode = node(
      (_ctx: NodeContext, input: {request: string}) =>
        `Hello, ${input.request}!`,
      {name: 'greet_node', inputSchema: z.object({request: z.string()})},
    );
    const responses = await runTurn(
      callingAgent('greet_tool', {request: 'world'}, [
        new NodeTool(greetNode, 'greet_tool'),
      ]),
    );
    expect(responses).toHaveLength(1);
    expect(responses[0].response).toEqual({result: 'Hello, world!'});
  });

  it('test_function_node_wrapped_as_tool_no_output', async () => {
    const noOutputNode = node((_ctx: NodeContext, _input: unknown) => null, {
      name: 'no_output_node',
      inputSchema: z.object({request: z.string()}),
    });
    const responses = await runTurn(
      callingAgent('no_output_tool', {request: 'world'}, [
        new NodeTool(noOutputNode, 'no_output_tool'),
      ]),
    );
    expect(responses).toHaveLength(1);
    expect(responses[0].response).toEqual({result: null});
  });
});
