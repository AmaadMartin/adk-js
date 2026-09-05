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

import {Type} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {LlmAgent} from '../../src/agents/llm_agent.js';
import {createEvent, Event} from '../../src/events/event.js';
import {BaseLlm} from '../../src/models/base_llm.js';
import type {BaseLlmConnection} from '../../src/models/base_llm_connection.js';
import type {LlmResponse} from '../../src/models/llm_response.js';
import {LLMRegistry} from '../../src/models/registry.js';
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

  it('gives a re-triggered task agent a fresh scope', async () => {
    const intake = taskAgent('intake', 'one-shot-task-5');
    let checks = 0;
    const check = node(
      () =>
        checks++ === 0
          ? createEvent({route: 'retry', content: {role: 'user', parts: []}})
          : 'accepted',
      {name: 'check'},
    );
    const wf = new Workflow({
      name: 'flow',
      edges: [
        ['START', intake, check],
        [
          check,
          {retry: intake, [DEFAULT_ROUTE]: node(() => 'end', {name: 'end'})},
        ],
      ],
    });

    const {events} = await driveWorkflow(wf, 'go');

    expect(scopesOf(events, 'intake')).toEqual([
      'flow.intake@1',
      'flow.intake@2',
    ]);
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
