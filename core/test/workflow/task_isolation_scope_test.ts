/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A task-mode agent node runs under an isolation scope of its own, so its
 * multi-turn conversation stays out of its peers' view. Mirrors
 * `Workflow._compute_isolation_scope_for_node` in `google/adk-python`
 * `src/google/adk/workflow/_workflow.py` at `25f5214c`.
 */

import {Content, Type} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {LlmAgent} from '../../src/agents/llm_agent.js';
import {createEvent, Event} from '../../src/events/event.js';
import {BaseLlm} from '../../src/models/base_llm.js';
import type {BaseLlmConnection} from '../../src/models/base_llm_connection.js';
import type {LlmRequest} from '../../src/models/llm_request.js';
import type {LlmResponse} from '../../src/models/llm_response.js';
import {LLMRegistry} from '../../src/models/registry.js';
import {InMemoryRunner} from '../../src/runner/in_memory_runner.js';
import {DEFAULT_ROUTE} from '../../src/workflow/graph.js';
import {node} from '../../src/workflow/node.js';
import {NodeContext} from '../../src/workflow/node_context.js';
import {Workflow} from '../../src/workflow/workflow.js';
import {driveWorkflow} from './test_helpers.js';

/** Finishes its task on the first turn, so a graph runs straight through. */
class OneShotTaskLlm extends BaseLlm {
  static override readonly supportedModels = [/one-shot-task-.*/];

  override async *generateContentAsync(): AsyncGenerator<LlmResponse, void> {
    yield {
      content: {
        role: 'model',
        parts: [{functionCall: {name: 'finish_task', args: {name: 'Ada'}}}],
      },
    } as LlmResponse;
  }

  override connect(): Promise<BaseLlmConnection> {
    throw new Error('not supported');
  }
}
LLMRegistry.register(OneShotTaskLlm);

/** Finishes like {@link OneShotTaskLlm}, reporting the history it was given. */
class RecordingTaskLlm extends BaseLlm {
  static override readonly supportedModels = [/recording-task-.*/];
  static onRequest: ((contents: Content[]) => void) | undefined;

  override async *generateContentAsync(
    llmRequest: LlmRequest,
  ): AsyncGenerator<LlmResponse, void> {
    RecordingTaskLlm.onRequest?.(llmRequest.contents ?? []);
    yield {
      content: {
        role: 'model',
        parts: [{functionCall: {name: 'finish_task', args: {name: 'Ada'}}}],
      },
    } as LlmResponse;
  }

  override connect(): Promise<BaseLlmConnection> {
    throw new Error('not supported');
  }
}
LLMRegistry.register(RecordingTaskLlm);

function taskAgent(
  name: string,
  model: string,
  isolationScope?: string,
): LlmAgent {
  return new LlmAgent({
    name,
    model,
    mode: 'task',
    isolationScope,
    instruction: 'Collect the name.',
    outputSchema: {
      type: Type.OBJECT,
      properties: {name: {type: Type.STRING}},
    },
  });
}

/** A graph whose check node routes back to the task agent exactly once. */
function retryGraph(model: string): Workflow {
  const intake = taskAgent('intake', model);
  let checks = 0;
  const check = node(
    () =>
      checks++ === 0
        ? createEvent({route: 'retry', content: {role: 'user', parts: []}})
        : 'accepted',
    {name: 'check'},
  );
  return new Workflow({
    name: 'flow',
    edges: [
      ['START', intake, check],
      [
        check,
        {retry: intake, [DEFAULT_ROUTE]: node(() => 'end', {name: 'end'})},
      ],
    ],
  });
}

/** The distinct scopes the events of `author` were emitted under. */
function scopesOf(events: Event[], author: string): Array<string | undefined> {
  return [
    ...new Set(
      events.filter((e) => e.author === author).map((e) => e.isolationScope),
    ),
  ];
}

describe('task-mode node isolation scope', () => {
  it('scopes a task agent node to its own node path and run', async () => {
    const intake = taskAgent('intake', 'one-shot-task-1');
    const wf = new Workflow({
      name: 'flow',
      edges: [['START', intake]],
    });

    const {events} = await driveWorkflow(wf, 'go');

    expect(scopesOf(events, 'intake')).toEqual(['flow.intake@1']);
  }, 30000);

  it('leaves a node that is not a task agent unscoped', async () => {
    const plain = node(() => 'done', {name: 'plain'});
    const wf = new Workflow({name: 'flow', edges: [['START', plain]]});

    const {events} = await driveWorkflow(wf, 'go');

    expect(scopesOf(events, 'plain')).toEqual([undefined]);
  }, 30000);

  it('carries the whole node path so a nested workflow stays unique', async () => {
    const inner = new Workflow({
      name: 'inner',
      edges: [['START', taskAgent('intake', 'one-shot-task-2')]],
    });
    const outer = new Workflow({name: 'outer', edges: [['START', inner]]});

    const {events} = await driveWorkflow(outer, 'go');

    expect(scopesOf(events, 'intake')).toEqual(['outer.inner.intake@1']);
  }, 30000);

  it('keeps a scope the task node declares for itself', async () => {
    const intake = taskAgent('intake', 'one-shot-task-3', 'shared-thread');
    const wf = new Workflow({name: 'flow', edges: [['START', intake]]});

    const {events} = await driveWorkflow(wf, 'go');

    expect(scopesOf(events, 'intake')).toEqual(['shared-thread']);
  }, 30000);

  it('keeps one scope when the graph routes back to a task agent', async () => {
    const {events} = await driveWorkflow(retryGraph('one-shot-task-5'), 'go');

    // Two activations, one scope. An event is readable only inside the scope
    // it was written under, so a second scope would hide the first attempt.
    expect(events.filter((e) => e.author === 'intake').length).toBeGreaterThan(
      1,
    );
    expect(scopesOf(events, 'intake')).toEqual(['flow.intake@1']);
  }, 30000);

  it('still shows a re-triggered task agent its own earlier turns', async () => {
    const seen: Content[][] = [];
    RecordingTaskLlm.onRequest = (contents) => seen.push(contents);
    // The real Runner, so the session accumulates the events the second
    // activation has to read back.
    const runner = new InMemoryRunner({
      agent: retryGraph('recording-task-1'),
      appName: 'app',
    });
    const session = await runner.sessionService.createSession({
      appName: 'app',
      userId: 'u',
    });
    try {
      for await (const _event of runner.runAsync({
        userId: 'u',
        sessionId: session.id,
        newMessage: {role: 'user', parts: [{text: 'go'}]},
      })) {
        // drain
      }
    } finally {
      RecordingTaskLlm.onRequest = undefined;
    }

    // The agent's own finish_task call from the first attempt is in the history
    // the second activation reads. A per-activation scope would hide it, and
    // leave the agent the user's turns with its own replies cut out.
    expect(seen).toHaveLength(2);
    const callsIn = (contents: Content[]): string[] =>
      contents.flatMap((c) =>
        (c.parts ?? []).flatMap((p) =>
          p.functionCall?.name ? [p.functionCall.name] : [],
        ),
      );
    expect(callsIn(seen[0])).toEqual([]);
    expect(callsIn(seen[1])).toContain('finish_task');
  }, 30000);

  it('withholds a task agent turn from an unscoped peer node', async () => {
    const seen: Array<string | undefined> = [];
    const peer = node(
      (ctx: NodeContext) => {
        seen.push(ctx.invocationContext.isolationScope);
        return 'peer';
      },
      {name: 'peer'},
    );
    const wf = new Workflow({
      name: 'flow',
      edges: [['START', taskAgent('intake', 'one-shot-task-4'), peer]],
    });

    const {events} = await driveWorkflow(wf, 'go');

    expect(scopesOf(events, 'intake')).toEqual(['flow.intake@1']);
    expect(scopesOf(events, 'peer')).toEqual([undefined]);
    expect(seen).toEqual([undefined]);
  }, 30000);
});
