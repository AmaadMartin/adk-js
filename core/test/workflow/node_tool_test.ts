/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {z} from 'zod';
import {Context} from '../../src/agents/context.js';
import {QueuedInvocationEvent} from '../../src/agents/invocation_context.js';
import {AsyncQueue} from '../../src/utils/async_queue.js';
import {FunctionNode} from '../../src/workflow/nodes/function_node.js';
import {NodeTool} from '../../src/workflow/nodes/node_tool.js';
import {createIc} from './test_helpers.js';

/** A node that emits one event per name, driven through {@link NodeTool}. */
function emittingNode(names: string[]): FunctionNode {
  return new FunctionNode(
    'emitter',
    function* () {
      for (const name of names) {
        yield name;
      }
    },
    {inputSchema: z.object({request: z.string()})},
  );
}

function toolContextFor(queue?: AsyncQueue<QueuedInvocationEvent>): Context {
  const ic = createIc();
  ic.eventQueue = queue;
  return new Context({invocationContext: ic, functionCallId: 'call-1'});
}

describe('NodeTool event forwarding', () => {
  it('forwards the node events to the invocation in emission order', async () => {
    const queue = new AsyncQueue<QueuedInvocationEvent>();
    const toolContext = toolContextFor(queue);
    const outputs: unknown[] = [];
    const consumer = (async () => {
      for await (const queued of queue) {
        outputs.push(queued.event.output);
        queued.markProcessed?.();
      }
    })();

    await new NodeTool(emittingNode(['a', 'b', 'c'])).runAsync({
      args: {request: 'go'},
      toolContext,
    });
    queue.close();
    await consumer;

    expect(outputs).toEqual(['a', 'b', 'c']);
  });

  it('reports the closed invocation queue instead of hanging', async () => {
    const queue = new AsyncQueue<QueuedInvocationEvent>();
    queue.close();

    await expect(
      new NodeTool(emittingNode(['a'])).runAsync({
        args: {request: 'go'},
        toolContext: toolContextFor(queue),
      }),
    ).rejects.toThrowError(/InvocationContext.eventQueue is closed/);
  });

  it('rejects when the invocation has no event queue', async () => {
    await expect(
      new NodeTool(emittingNode(['a'])).runAsync({
        args: {request: 'go'},
        toolContext: toolContextFor(undefined),
      }),
    ).rejects.toThrowError(/requires an invocation event queue/);
  });
});
