/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ported from `google/adk-python` `main`,
 * `tests/unittests/agents/test_context.py::TestContextRunNodeTransferLoop`. The
 * ported cases keep their Python names verbatim so a reviewer can grep across
 * the two repositories.
 *
 * adk-python's `Context.run_node` resolves to the child's output; adk-js's
 * resolves to the child's context, so each assertion reads `.output` off the
 * returned context.
 */

import {beforeEach, describe, expect, it} from 'vitest';
import {BaseAgent} from '../../src/agents/base_agent.js';
import {InvocationContext} from '../../src/agents/invocation_context.js';
import {LlmAgent} from '../../src/agents/llm_agent.js';
import {Event} from '../../src/events/event.js';
import {createEventActions} from '../../src/events/event_actions.js';
import {AsyncQueue} from '../../src/utils/async_queue.js';
import {BaseNode} from '../../src/workflow/base_node.js';
import {NodeContext, NodeResult} from '../../src/workflow/node_context.js';
import type {
  ScheduleDynamicNode,
  ScheduleDynamicNodeOptions,
} from '../../src/workflow/schedule_dynamic_node.js';
import {createIc} from './test_helpers.js';

/** One recorded `schedule(...)` call. */
interface ScheduleCall {
  ctx: NodeContext;
  node: BaseNode;
  input: unknown;
  options: ScheduleDynamicNodeOptions;
}

/**
 * A scheduler that records every call and hands back the next canned child
 * context, standing in for the real `DynamicNodeScheduler` the way the
 * reference tests stand in for Python's.
 */
class RecordingScheduler implements ScheduleDynamicNode {
  readonly calls: ScheduleCall[] = [];

  constructor(private readonly children: NodeContext[]) {}

  /**
   * Puts this scheduler on every context, as the node runner does when it
   * propagates the scheduler to each child it builds.
   */
  attach(...contexts: NodeContext[]): void {
    for (const ctx of contexts) {
      ctx.scheduler = this;
    }
  }

  async schedule(
    ctx: NodeContext,
    node: BaseNode,
    input: unknown,
    options: ScheduleDynamicNodeOptions,
  ): Promise<NodeContext | NodeResult> {
    this.calls.push({ctx, node, input, options});
    const child = this.children[this.calls.length - 1];
    if (!child) {
      expect.fail(
        `scheduler called ${this.calls.length} times, but only ` +
          `${this.children.length} canned children were provided`,
      );
    }
    return child;
  }
}

/**
 * An agent that asks the workflow to transfer to `target` instead of producing
 * a result — what a node body does to hand execution to another agent.
 */
class TransferringNode extends BaseAgent {
  constructor(
    name: string,
    private readonly target: string,
  ) {
    super({name});
  }

  // eslint-disable-next-line require-yield -- a transfer request is state on the context, not an event
  protected override async *runImpl(
    ctx: NodeContext,
  ): AsyncGenerator<Event, void, void> {
    ctx.actions.transferToAgent = this.target;
  }

  protected async *runAsyncImpl(): AsyncGenerator<Event, void, void> {}
  protected async *runLiveImpl(): AsyncGenerator<Event, void, void> {}
}

/** An agent that sets `output` and nothing else. */
class OutputNode extends BaseAgent {
  constructor(
    name: string,
    private readonly value: unknown,
  ) {
    super({name});
  }

  // eslint-disable-next-line require-yield -- the result is state on the context, not an event
  protected override async *runImpl(
    ctx: NodeContext,
  ): AsyncGenerator<Event, void, void> {
    ctx.output = this.value;
  }

  protected async *runAsyncImpl(): AsyncGenerator<Event, void, void> {}
  protected async *runLiveImpl(): AsyncGenerator<Event, void, void> {}
}

let ic: InvocationContext;
let channel: AsyncQueue<Event>;

beforeEach(() => {
  ic = createIc();
  channel = new AsyncQueue<Event>();
});

/** Builds a context the way the node runner would. */
function makeCtx(options: {
  node?: BaseNode;
  parentCtx?: NodeContext;
  runId?: string;
  transferTo?: string;
}): NodeContext {
  return new NodeContext({
    invocationContext: ic,
    channel,
    nodePath: options.node?.name ?? '',
    runId: options.runId ?? '1',
    node: options.node,
    parentCtx: options.parentCtx,
    actions: createEventActions({transferToAgent: options.transferTo}),
  });
}

function agent(name: string, subAgents: BaseAgent[] = []): LlmAgent {
  return new LlmAgent({name, subAgents});
}

describe('Context.runNode transfer loop', () => {
  it('test_sibling_transfer_executes_target_agent', async () => {
    const agentA = agent('agent_a');
    const agentB = agent('agent_b');
    const root = agent('root', [agentA, agentB]);

    const rootCtx = makeCtx({node: root});
    const childCtxA = makeCtx({
      node: agentA,
      parentCtx: rootCtx,
      transferTo: 'agent_b',
    });
    const childCtxB = makeCtx({node: agentB, parentCtx: rootCtx});
    childCtxB.setOutputInternal('b_output');

    const scheduler = new RecordingScheduler([childCtxA, childCtxB]);
    scheduler.attach(rootCtx, childCtxA, childCtxB);

    const result = await rootCtx.runNode(agentA, 'a_input');

    expect(result.output).toBe('b_output');
    expect(scheduler.calls).toHaveLength(2);

    expect(scheduler.calls[0].ctx).toBe(rootCtx);
    expect(scheduler.calls[0].node.name).toBe('agent_a');
    expect(scheduler.calls[0].input).toBe('a_input');
    expect(scheduler.calls[0].options.runId).toBe('1');

    // The sibling runs under the same parent context, and its own run counter
    // is independent, so it is still at 1.
    expect(scheduler.calls[1].ctx).toBe(rootCtx);
    expect(scheduler.calls[1].node.name).toBe('agent_b');
    expect(scheduler.calls[1].input).toBeUndefined();
    expect(scheduler.calls[1].options.runId).toBe('1');
  });

  it('test_parent_transfer_routes_execution_to_parent_agent', async () => {
    const child = agent('child');
    const parent = agent('parent', [child]);
    const root = agent('root', [parent]);

    const rootCtx = makeCtx({node: root});
    const parentCtx = makeCtx({node: parent, parentCtx: rootCtx});
    const childCtx = makeCtx({node: child, parentCtx, transferTo: 'parent'});
    const parentCtx2 = makeCtx({node: parent, parentCtx: rootCtx, runId: '2'});
    parentCtx2.setOutputInternal('parent_output');

    const scheduler = new RecordingScheduler([childCtx, parentCtx2]);
    scheduler.attach(rootCtx, parentCtx, childCtx, parentCtx2);

    const result = await parentCtx.runNode(child, 'child_input', {
      useAsOutput: true,
    });

    expect(result.output).toBe('parent_output');
    expect(scheduler.calls).toHaveLength(2);

    expect(scheduler.calls[0].ctx).toBe(parentCtx);
    expect(scheduler.calls[0].node.name).toBe('child');
    expect(scheduler.calls[0].options.useAsOutput).toBe(true);

    // Climbed up to the root context, and the delegation flag is dropped
    // because the run crossed a parent context.
    expect(scheduler.calls[1].ctx).toBe(rootCtx);
    expect(scheduler.calls[1].node.name).toBe('parent');
    expect(scheduler.calls[1].options.useAsOutput).toBe(false);
  });

  it('test_standalone_sibling_transfer_executes_target_agent', async () => {
    const agentB = new OutputNode('agent_b', 'standalone_b_output');
    const agentA = new TransferringNode('agent_a', 'agent_b');
    const root = agent('root', [agentA, agentB]);

    // Standalone mode: no scheduler, so each hop runs through the node runner.
    const rootCtx = makeCtx({node: root});

    const result = await rootCtx.runNode(agentA, 'a_input');

    expect(result.output).toBe('standalone_b_output');
  });

  it('test_child_transfer_routes_execution_to_child_agent', async () => {
    const child = agent('child');
    const parent = agent('parent', [child]);

    const parentCtx = makeCtx({});
    const parentRunCtx = makeCtx({
      node: parent,
      parentCtx,
      transferTo: 'child',
    });
    const childRunCtx = makeCtx({node: child, parentCtx: parentRunCtx});
    childRunCtx.setOutputInternal('child_output');

    const scheduler = new RecordingScheduler([parentRunCtx, childRunCtx]);
    scheduler.attach(parentCtx, parentRunCtx, childRunCtx);

    const result = await parentCtx.runNode(parent, 'parent_input');

    expect(result.output).toBe('child_output');
    expect(scheduler.calls).toHaveLength(2);

    expect(scheduler.calls[0].ctx).toBe(parentCtx);
    expect(scheduler.calls[0].node.name).toBe('parent');

    // The child runs under the parent's own execution context.
    expect(scheduler.calls[1].ctx).toBe(parentRunCtx);
    expect(scheduler.calls[1].node.name).toBe('child');
    expect(scheduler.calls[1].options.runId).toBe('1');
  });

  it('test_three_layer_transfer_round_trip', async () => {
    const grandchild = agent('grandchild');
    const child = agent('child', [grandchild]);
    const root = agent('root', [child]);

    const rootCtx = makeCtx({});
    const rootRunCtx = makeCtx({
      node: root,
      parentCtx: rootCtx,
      transferTo: 'child',
    });
    const childRunCtx = makeCtx({
      node: child,
      parentCtx: rootRunCtx,
      transferTo: 'grandchild',
    });
    const grandchildRunCtx = makeCtx({
      node: grandchild,
      parentCtx: childRunCtx,
      transferTo: 'child',
    });
    const childRunCtx2 = makeCtx({
      node: child,
      parentCtx: rootRunCtx,
      runId: '2',
      transferTo: 'root',
    });
    const rootRunCtx2 = makeCtx({node: root, parentCtx: rootCtx, runId: '2'});
    rootRunCtx2.setOutputInternal('final_root_output');

    const scheduler = new RecordingScheduler([
      rootRunCtx,
      childRunCtx,
      grandchildRunCtx,
      childRunCtx2,
      rootRunCtx2,
    ]);
    scheduler.attach(
      rootCtx,
      rootRunCtx,
      childRunCtx,
      grandchildRunCtx,
      childRunCtx2,
      rootRunCtx2,
    );

    const result = await rootCtx.runNode(root, 'start');

    expect(result.output).toBe('final_root_output');
    expect(
      scheduler.calls.map((call) => [
        call.ctx,
        call.node.name,
        call.options.runId,
      ]),
    ).toEqual([
      [rootCtx, 'root', '1'],
      [rootRunCtx, 'child', '1'],
      [childRunCtx, 'grandchild', '1'],
      [rootRunCtx, 'child', '2'],
      [rootCtx, 'root', '2'],
    ]);
  });

  it('test_transfer_preserves_use_as_output_for_original_context', async () => {
    const child = agent('child');
    const root = agent('root', [child]);

    const rootCtx = makeCtx({});
    const rootRunCtx1 = makeCtx({
      node: root,
      parentCtx: rootCtx,
      transferTo: 'child',
    });
    const childRunCtx = makeCtx({
      node: child,
      parentCtx: rootRunCtx1,
      transferTo: 'root',
    });
    const rootRunCtx2 = makeCtx({node: root, parentCtx: rootCtx, runId: '2'});
    rootRunCtx2.setOutputInternal('final_output');

    const scheduler = new RecordingScheduler([
      rootRunCtx1,
      childRunCtx,
      rootRunCtx2,
    ]);
    scheduler.attach(rootCtx, rootRunCtx1, childRunCtx, rootRunCtx2);

    const result = await rootCtx.runNode(root, 'start', {useAsOutput: true});

    expect(result.output).toBe('final_output');
    // Delegation applies again whenever the run is back under the original
    // context, and not while it is under another one.
    expect(scheduler.calls.map((call) => call.options.useAsOutput)).toEqual([
      true,
      false,
      true,
    ]);
  });
});

describe('Context.runNode transfer failures', () => {
  it('stops after 50 hops when two agents transfer to each other forever', async () => {
    const ping = new TransferringNode('ping', 'pong');
    const pong = new TransferringNode('pong', 'ping');
    const rootCtx = makeCtx({node: agent('root', [ping, pong])});

    await expect(rootCtx.runNode(ping, 'go')).rejects.toThrow(
      'exceeded 50 hops',
    );
  });

  it('rejects a transfer requested by a node that is not an agent', async () => {
    class PlainNode extends BaseNode {
      // eslint-disable-next-line require-yield -- the transfer request is state on the context
      protected async *runImpl(
        ctx: NodeContext,
      ): AsyncGenerator<Event, void, void> {
        ctx.actions.transferToAgent = 'somewhere';
      }
    }
    const rootCtx = makeCtx({node: agent('root')});

    await expect(
      rootCtx.runNode(new PlainNode({name: 'plain'}), undefined),
    ).rejects.toThrow('Only agents can request an agent transfer.');
  });

  it('rejects a transfer to an agent that is not in the tree', async () => {
    const lost = new TransferringNode('lost', 'nowhere');
    const rootCtx = makeCtx({node: agent('root', [lost])});

    await expect(rootCtx.runNode(lost, undefined)).rejects.toThrow(
      "Transfer target agent 'nowhere' not found.",
    );
  });

  it('rejects a transfer to an agent with no routing relationship', async () => {
    const nephew = agent('nephew');
    const uncle = agent('uncle', [nephew]);
    const stranger = new TransferringNode('stranger', 'nephew');
    const rootCtx = makeCtx({node: agent('root', [stranger, uncle])});

    await expect(rootCtx.runNode(stranger, undefined)).rejects.toThrow(
      "Cannot transfer from 'stranger' to unrelated agent 'nephew'.\n" +
        'Available agents: root, stranger, uncle, nephew',
    );
  });
});
