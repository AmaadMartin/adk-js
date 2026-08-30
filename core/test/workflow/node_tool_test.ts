/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `NodeTool` shares its child-run bridge with the `AgentTool` delegation
 * wrappers. These cases pin the behaviour the bridge owns — the scoped branch,
 * the pause on an interrupt, and the depth guard — so the shared implementation
 * cannot drift away from what `NodeTool` needs.
 */

import {describe, expect, it} from 'vitest';
import {z} from 'zod/v3';

import {BaseAgent} from '../../src/agents/base_agent.js';
import {Context} from '../../src/agents/context.js';
import {InvocationContext} from '../../src/agents/invocation_context.js';
import {Event} from '../../src/events/event.js';
import {PluginManager} from '../../src/plugins/plugin_manager.js';
import {createSession} from '../../src/sessions/session.js';
import {AsyncQueue} from '../../src/utils/async_queue.js';
import {NodeContext} from '../../src/workflow/node_context.js';
import {FunctionNode} from '../../src/workflow/nodes/function_node.js';
import {NodeTool} from '../../src/workflow/nodes/node_tool.js';
import {RequestInput} from '../../src/workflow/request_input.js';

/** A minimal agent, only needed because an invocation context requires one. */
class HostAgent extends BaseAgent {
  // eslint-disable-next-line require-yield -- BaseAgent mandates an AsyncGenerator; this fixture never runs.
  protected async *runAsyncImpl(): AsyncGenerator<Event, void, void> {
    return;
  }

  // eslint-disable-next-line require-yield -- BaseAgent mandates an AsyncGenerator; this fixture never runs live.
  protected async *runLiveImpl(): AsyncGenerator<Event, void, void> {
    return;
  }
}

function createToolCall(options: {nodeToolDepth?: number} = {}): Context {
  const invocationContext = new InvocationContext({
    invocationId: 'inv-1',
    agent: new HostAgent({name: 'host'}),
    session: createSession({id: 's1', appName: 'app', userId: 'u'}),
    pluginManager: new PluginManager([]),
    branch: 'parent',
    nodeToolDepth: options.nodeToolDepth ?? 0,
  });
  invocationContext.eventQueue = new AsyncQueue<Event>();
  return new Context({invocationContext, functionCallId: 'fc-1'});
}

describe('NodeTool', () => {
  it('runs the node on a branch scoped to the function call', async () => {
    const branches: Array<string | undefined> = [];
    const node = new FunctionNode(
      'lookup',
      (ctx: NodeContext) => {
        branches.push(ctx.branch);
        return 'found';
      },
      {inputSchema: z.object({query: z.string()})},
    );

    const result = await new NodeTool(node).runAsync({
      args: {query: 'anything'},
      toolContext: createToolCall(),
    });

    expect(result).toBe('found');
    expect(branches).toEqual(['parent.lookup@fc-1']);
  });

  it('leaves the call pending when the node asks for input', async () => {
    const node = new FunctionNode(
      'gate',
      () => new RequestInput({interruptId: 'gate-1', message: 'Approve?'}),
      {inputSchema: z.object({query: z.string()})},
    );

    const result = await new NodeTool(node).runAsync({
      args: {query: 'anything'},
      toolContext: createToolCall(),
    });

    expect(result).toBeUndefined();
  });

  it('reports a null result when the node produces no output', async () => {
    const node = new FunctionNode('silent', () => undefined, {
      inputSchema: z.object({query: z.string()}),
    });

    const result = await new NodeTool(node).runAsync({
      args: {query: 'anything'},
      toolContext: createToolCall(),
    });

    expect(result).toEqual({result: null});
  });

  it('refuses to nest past the depth limit', async () => {
    const node = new FunctionNode('deep', () => 'ran', {
      inputSchema: z.object({query: z.string()}),
    });

    await expect(
      new NodeTool(node).runAsync({
        args: {query: 'anything'},
        toolContext: createToolCall({nodeToolDepth: 8}),
      }),
    ).rejects.toThrow(
      "Tool 'deep': node-tool nesting exceeded 8 " +
        '(possible node -> tool -> node recursion).',
    );
  });
});
