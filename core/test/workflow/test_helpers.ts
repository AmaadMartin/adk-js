/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Part} from '@google/genai';
import {expect} from 'vitest';
import {BaseAgent} from '../../src/agents/base_agent.js';
import {InvocationContext} from '../../src/agents/invocation_context.js';
import {LlmAgent, LlmAgentConfig} from '../../src/agents/llm_agent.js';
import {createEvent, Event} from '../../src/events/event.js';
import {BaseLlm} from '../../src/models/base_llm.js';
import {BaseLlmConnection} from '../../src/models/base_llm_connection.js';
import {LlmRequest} from '../../src/models/llm_request.js';
import {LlmResponse} from '../../src/models/llm_response.js';
import {PluginManager} from '../../src/plugins/plugin_manager.js';
import {createSession} from '../../src/sessions/session.js';
import {AsyncQueue} from '../../src/utils/async_queue.js';
import {BaseNode, BaseNodeConfig} from '../../src/workflow/base_node.js';
import {NodeContext} from '../../src/workflow/node_context.js';
import {
  executeChildNode,
  ExecuteChildNodeParams,
} from '../../src/workflow/node_runner.js';

/** A minimal concrete {@link BaseAgent} for driving nodes directly in tests. */
class TestAgent extends BaseAgent {
  // eslint-disable-next-line require-yield
  protected async *runAsyncImpl(): AsyncGenerator<Event, void, void> {
    return;
  }
  // eslint-disable-next-line require-yield
  protected async *runLiveImpl(): AsyncGenerator<Event, void, void> {
    return;
  }
}

/**
 * An agent that replies with `reply` and leaves `output` unset on its event.
 *
 * Not an `LlmAgent`, so nothing turns its reply into a node output — promoting
 * a final model turn is `LlmAgent.runImpl`'s job, as it is adk-python's. Use it
 * for the cases about an agent that is *not* an `LlmAgent` being a node; use
 * {@link replyAgent} for one whose reply should become the output.
 */
export class PlainReplyAgent extends BaseAgent {
  constructor(
    name: string,
    private readonly reply = 'ok',
  ) {
    super({name});
  }

  protected async *runAsyncImpl(
    ic: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    yield createEvent({
      author: this.name,
      invocationId: ic.invocationId,
      content: {role: 'model', parts: [{text: this.reply}]},
    });
  }

  // eslint-disable-next-line require-yield
  protected async *runLiveImpl(): AsyncGenerator<Event, void, void> {
    return;
  }
}

/**
 * A model that replays one canned response per call, so a test can build a real
 * `LlmAgent` without a network. `replies` may hold text (a plain model turn) or
 * a function call, and the last entry repeats once exhausted.
 */
export class ScriptedLlm extends BaseLlm {
  private calls = 0;

  constructor(private readonly replies: Array<string | Part>) {
    super({model: 'scripted-llm'});
  }

  /** How many times the model has been asked for a response. */
  get callCount(): number {
    return this.calls;
  }

  async *generateContentAsync(
    _request: LlmRequest,
  ): AsyncGenerator<LlmResponse, void, void> {
    const reply =
      this.replies[Math.min(this.calls++, this.replies.length - 1)] ?? '';
    const part: Part = typeof reply === 'string' ? {text: reply} : reply;
    yield {content: {role: 'model', parts: [part]}};
  }

  async connect(_request: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error('ScriptedLlm does not support live mode.');
  }
}

/** An {@link LlmAgent} whose model answers `reply`, then repeats it. */
export function replyAgent(
  name: string,
  reply = 'ok',
  config: Partial<LlmAgentConfig> = {},
): LlmAgent {
  return new LlmAgent({name, model: new ScriptedLlm([reply]), ...config});
}

/**
 * An {@link LlmAgent} that hands off to `target` by calling `transfer_to_agent`
 * — the way a real model does it — and then answers `reply` if it is asked
 * again. `target` must also be among its `subAgents` for the transfer tool to
 * offer it.
 */
export function transferringAgent(
  name: string,
  target: string,
  subAgents: BaseAgent[],
  reply = '(unused)',
): LlmAgent {
  return new LlmAgent({
    name,
    subAgents,
    model: new ScriptedLlm([
      {
        functionCall: {
          id: `fc-${name}`,
          name: 'transfer_to_agent',
          args: {agentName: target},
        },
      },
      reply,
    ]),
  });
}

/** Builds a throwaway InvocationContext for driving nodes directly in tests. */
export function createIc(
  state: Record<string, unknown> = {},
  abortSignal?: AbortSignal,
): InvocationContext {
  const session = createSession({
    id: 's1',
    appName: 'app',
    userId: 'u',
    state,
    lastUpdateTime: Date.now(),
  });
  return new InvocationContext({
    invocationId: 'inv-1',
    session,
    agent: new TestAgent({name: 'wf'}),
    pluginManager: new PluginManager(),
    abortSignal,
  });
}

/** Runs a node (or workflow) to completion, returning its events and output. */
export async function driveNode(
  node: BaseNode,
  input?: unknown,
  ic: InvocationContext = createIc(),
): Promise<{events: Event[]; output: unknown; ctx: NodeContext}> {
  const channel = new AsyncQueue<Event>();
  const root = new NodeContext({
    invocationContext: ic,
    channel,
    nodePath: '',
    runId: 'root',
  });
  const events: Event[] = [];
  const settle = root.runNode(node, input, {useAsOutput: true}).then(
    () => channel.close(),
    (err) => channel.fail(err),
  );
  for await (const ev of channel) {
    events.push(ev);
  }
  await settle;
  return {events, output: root.output, ctx: root};
}

/** Options for {@link driveWorkflow}. */
export interface DriveWorkflowOptions {
  /** InvocationContext to run under (defaults to a fresh {@link createIc}). */
  ic?: InvocationContext;
  /** Resume inputs keyed by interrupt id (for HITL/auth resume). */
  resumeInputs?: Record<string, unknown>;
}

/**
 * Drives a workflow (or any node) to completion and returns its streamed events,
 * final output, and the interrupt ids it is paused on — the shared harness for
 * the workflow-level tests (replaces the per-file `createIc`/`driveWorkflow`
 * copies that reached for `as unknown as Session/BaseAgent`).
 */
export async function driveWorkflow(
  wf: BaseNode,
  input?: unknown,
  options: DriveWorkflowOptions = {},
): Promise<{events: Event[]; output: unknown; interruptIds: string[]}> {
  const channel = new AsyncQueue<Event>();
  const root = new NodeContext({
    invocationContext: options.ic ?? createIc(),
    channel,
    nodePath: '',
    runId: 'root',
    resumeInputs: options.resumeInputs,
  });
  const events: Event[] = [];
  const resultPromise = root.runNode(wf, input, {useAsOutput: true});
  const settle = resultPromise.then(
    () => channel.close(),
    (err) => channel.fail(err),
  );
  for await (const ev of channel) {
    events.push(ev);
  }
  await settle;
  const result = await resultPromise;
  return {events, output: root.output, interruptIds: result.interruptIds};
}

/** A node whose behavior is a plain function returning a value or Event. */
export class FnNode extends BaseNode {
  constructor(
    name: string,
    private readonly fn: (
      ctx: NodeContext,
      input: unknown,
    ) => unknown | Promise<unknown>,
    config: Partial<Omit<BaseNodeConfig, 'name'>> = {},
  ) {
    super({name, ...config});
  }
  protected async *runImpl(ctx: NodeContext, input: unknown) {
    yield await this.fn(ctx, input);
  }
}

/**
 * Closes a channel and returns everything buffered in it, for a test that ran a
 * node against a channel it did not drain while the node was running.
 */
export async function drain(channel: AsyncQueue<Event>): Promise<Event[]> {
  channel.close();
  const events: Event[] = [];
  for await (const event of channel) {
    events.push(event);
  }
  return events;
}

/** Options for {@link runChildNode} and {@link runFailingChildNode}. */
export interface RunChildNodeParams extends Omit<
  Partial<ExecuteChildNodeParams>,
  'parent' | 'node'
> {
  /** Invocation context to run under (defaults to a fresh {@link createIc}). */
  ic?: InvocationContext;
  /** Node path of the context standing in for the parent (default: root). */
  parentNodePath?: string;
}

async function executeAndDrain(
  node: BaseNode,
  params: RunChildNodeParams,
): Promise<{child?: NodeContext; error?: unknown; events: Event[]}> {
  const {ic, parentNodePath = '', input, ...rest} = params;
  const channel = new AsyncQueue<Event>();
  const parent = new NodeContext({
    invocationContext: ic ?? createIc(),
    channel,
    nodePath: parentNodePath,
    runId: 'root',
  });
  try {
    const child = await executeChildNode({...rest, parent, node, input});
    return {child, events: await drain(channel)};
  } catch (error) {
    return {error, events: await drain(channel)};
  }
}

/**
 * Runs `node` as a child of a fresh parent context and returns that child
 * together with every event the run pushed — the adk-js counterpart of
 * adk-python's `NodeRunner(node=…, parent_ctx=…).run()`, which the ported
 * reference tests are written against. Rethrows if the node fails.
 */
export async function runChildNode(
  node: BaseNode,
  params: RunChildNodeParams = {},
): Promise<{child: NodeContext; events: Event[]}> {
  const {child, error, events} = await executeAndDrain(node, params);
  if (!child) {
    throw error;
  }
  return {child, events};
}

/**
 * {@link runChildNode} for a node that is expected to fail: hands back what it
 * threw instead of rethrowing, along with the events it pushed first. `error`
 * is `undefined` when the node unexpectedly succeeded.
 */
export async function runFailingChildNode(
  node: BaseNode,
  params: RunChildNodeParams = {},
): Promise<{error: unknown; events: Event[]}> {
  const {error, events} = await executeAndDrain(node, params);
  return {error, events};
}

/** Options for {@link driveNodeRunner} and {@link driveNodeRunnerFailure}. */
export interface DriveNodeRunnerOptions {
  /** The input handed to the node. */
  input?: unknown;
  /** InvocationContext to run under (defaults to a fresh {@link createIc}). */
  ic?: InvocationContext;
  /** Output from a previous run, carried forward on resume. */
  priorOutput?: unknown;
  /** Unresolved interrupt ids from a previous run, carried forward on resume. */
  priorInterruptIds?: readonly string[];
}

/**
 * Runs one node through the node runner, returning its context and every event
 * it pushed — the shape adk-python's node runner tests get from
 * `NodeRunner(node=…, parent_ctx=…).run()`.
 *
 * Fails the test when the node threw; use {@link driveNodeRunnerFailure} for a
 * node that is expected to fail.
 */
export async function driveNodeRunner(
  node: BaseNode,
  opts: DriveNodeRunnerOptions = {},
): Promise<{child: NodeContext; events: Event[]}> {
  const {child, error, events} = await executeAndDrain(node, opts);
  if (!child) {
    expect.fail(`node '${node.name}' threw unexpectedly: ${String(error)}`);
  }
  return {child, events};
}

/**
 * Runs one node expected to fail, returning what it threw and the events it
 * left on the channel on its way out.
 */
export async function driveNodeRunnerFailure(
  node: BaseNode,
  opts: DriveNodeRunnerOptions = {},
): Promise<{events: Event[]; thrown: unknown}> {
  const {error, events} = await executeAndDrain(node, opts);
  return {events, thrown: error};
}

/**
 * A node whose body is an async generator — the analogue of adk-python's
 * `BaseNode._run_impl`, and what the ported reference tests are written
 * against. Unlike `node(fn)` it is a plain {@link BaseNode}, so it brings none
 * of `FunctionNode`'s own event or delta handling with it. Use it for the cases
 * {@link FnNode} cannot express: yielding more than once, or yielding between
 * context writes.
 */
export class GenNode extends BaseNode {
  constructor(
    name: string,
    private readonly body: (
      ctx: NodeContext,
      input: unknown,
    ) => AsyncGenerator<unknown, void, void>,
    config: Partial<Omit<BaseNodeConfig, 'name'>> = {},
  ) {
    super({name, ...config});
  }
  protected async *runImpl(ctx: NodeContext, input: unknown) {
    yield* this.body(ctx, input);
  }
}
