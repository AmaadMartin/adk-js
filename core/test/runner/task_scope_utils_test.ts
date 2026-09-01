/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  createEvent,
  createSession,
  Event,
  findActiveTaskScope,
  findTaskAgentNames,
  FINISH_TASK_ERROR_RESULT,
  FINISH_TASK_SUCCESS_RESULT,
  FINISH_TASK_TOOL_NAME,
  LlmAgent,
  Session,
  Workflow,
} from '@google/adk';
import {Part} from '@google/genai';
import {describe, expect, it} from 'vitest';

const APP_NAME = 'task_scope_app';
const USER_ID = 'task_scope_user';

/** The scoped events below are authored by this task agent. */
const TASK_AGENTS: ReadonlySet<string> = new Set(['task_agent']);

function scopedEvent(params: {
  invocationId: string;
  isolationScope?: string;
  finishResult?: unknown;
  finishError?: string;
  text?: string;
}): Event {
  const parts: Part[] = [];
  if (params.finishResult !== undefined) {
    parts.push({
      functionResponse: {
        id: 'fc-finish',
        name: FINISH_TASK_TOOL_NAME,
        response: {result: params.finishResult},
      },
    });
  }
  if (params.finishError !== undefined) {
    parts.push({
      functionResponse: {
        id: 'fc-finish',
        name: FINISH_TASK_TOOL_NAME,
        response: {error: params.finishError},
      },
    });
  }
  if (params.text !== undefined) {
    parts.push({text: params.text});
  }
  const event = createEvent({
    invocationId: params.invocationId,
    author: 'task_agent',
    content: {role: 'model', parts},
  });
  event.isolationScope = params.isolationScope;
  return event;
}

function sessionWith(events: Event[]): Session {
  return createSession({
    id: 'scope_session',
    appName: APP_NAME,
    userId: USER_ID,
    events,
  });
}

describe('findActiveTaskScope', () => {
  it('reports the scope open when finish_task returned a validation error', () => {
    const session = sessionWith([
      scopedEvent({
        invocationId: 'inv-1',
        isolationScope: 'scope-a',
        finishError: 'missing required parameters: city',
      }),
    ]);

    expect(findActiveTaskScope(session, TASK_AGENTS)).toEqual({
      isolationScope: 'scope-a',
      invocationId: 'inv-1',
    });
  });

  it('closes the scope on a successful finish_task', () => {
    const session = sessionWith([
      scopedEvent({
        invocationId: 'inv-1',
        isolationScope: 'scope-a',
        finishResult: FINISH_TASK_SUCCESS_RESULT,
      }),
    ]);

    expect(findActiveTaskScope(session, TASK_AGENTS)).toBeUndefined();
  });

  it('closes the scope on a failed finish_task', () => {
    const session = sessionWith([
      scopedEvent({
        invocationId: 'inv-1',
        isolationScope: 'scope-a',
        finishResult: FINISH_TASK_ERROR_RESULT,
      }),
    ]);

    expect(findActiveTaskScope(session, TASK_AGENTS)).toBeUndefined();
  });

  it('reports nothing when no event carries an isolation scope', () => {
    const session = sessionWith([
      scopedEvent({invocationId: 'inv-1', text: 'hello'}),
    ]);

    expect(findActiveTaskScope(session, TASK_AGENTS)).toBeUndefined();
  });

  it('keeps a scope closed when later events land in it', () => {
    const session = sessionWith([
      scopedEvent({
        invocationId: 'inv-1',
        isolationScope: 'scope-a',
        finishResult: FINISH_TASK_SUCCESS_RESULT,
      }),
      scopedEvent({
        invocationId: 'inv-1',
        isolationScope: 'scope-a',
        text: 'a summary written after the task finished',
      }),
    ]);

    expect(findActiveTaskScope(session, TASK_AGENTS)).toBeUndefined();
  });

  it('returns the later of two scopes when the earlier one finished', () => {
    const session = sessionWith([
      scopedEvent({
        invocationId: 'inv-1',
        isolationScope: 'scope-a',
        finishResult: FINISH_TASK_SUCCESS_RESULT,
      }),
      scopedEvent({
        invocationId: 'inv-2',
        isolationScope: 'scope-b',
        text: 'still working',
      }),
    ]);

    expect(findActiveTaskScope(session, TASK_AGENTS)).toEqual({
      isolationScope: 'scope-b',
      invocationId: 'inv-2',
    });
  });

  it('ignores a scope no task agent ever wrote into', () => {
    // Any node may declare `isolationScope`, and a plain node never emits
    // finish_task, so its scope would otherwise look open forever.
    const event = createEvent({
      invocationId: 'inv-1',
      author: 'plain_node',
      content: {role: 'model', parts: [{text: 'done'}]},
    });
    event.isolationScope = 'plain_node@1';

    expect(
      findActiveTaskScope(sessionWith([event]), TASK_AGENTS),
    ).toBeUndefined();
  });

  it('reports nothing when the root has no task agent at all', () => {
    const session = sessionWith([
      scopedEvent({
        invocationId: 'inv-1',
        isolationScope: 'scope-a',
        text: 'still working',
      }),
    ]);

    expect(findActiveTaskScope(session, new Set())).toBeUndefined();
  });

  it('ignores a function response from another tool', () => {
    const event = createEvent({
      invocationId: 'inv-1',
      author: 'task_agent',
      content: {
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: 'fc-1',
              name: 'lookup',
              response: {result: FINISH_TASK_SUCCESS_RESULT},
            },
          },
        ],
      },
    });
    event.isolationScope = 'scope-a';

    expect(findActiveTaskScope(sessionWith([event]), TASK_AGENTS)).toEqual({
      isolationScope: 'scope-a',
      invocationId: 'inv-1',
    });
  });
});

describe('findTaskAgentNames', () => {
  it('finds a task agent nested in a workflow graph', () => {
    const workflow = new Workflow({
      name: 'flow',
      edges: [
        [
          'START',
          new LlmAgent({
            name: 'task_agent',
            model: 'finishing-4',
            mode: 'task',
          }),
        ],
      ],
    });

    expect([...findTaskAgentNames(workflow)]).toEqual(['task_agent']);
  });

  it('finds a task agent among sub-agents and skips the others', () => {
    const root = new LlmAgent({
      name: 'root',
      model: 'talking-3',
      subAgents: [
        new LlmAgent({name: 'chatty', model: 'talking-4'}),
        new LlmAgent({name: 'worker', model: 'finishing-5', mode: 'task'}),
      ],
    });

    expect([...findTaskAgentNames(root)]).toEqual(['worker']);
  });

  it('reports no task agent for a plain agent', () => {
    const root = new LlmAgent({name: 'root', model: 'talking-5'});

    expect(findTaskAgentNames(root).size).toBe(0);
  });
});
