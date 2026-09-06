/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {InvocationContext} from '../../src/agents/invocation_context.js';
import {LlmAgent} from '../../src/agents/llm_agent.js';
import {createEvent, Event} from '../../src/events/event.js';
import {Runner} from '../../src/runner/runner.js';
import {InMemorySessionService} from '../../src/sessions/in_memory_session_service.js';
import {BaseTool} from '../../src/tools/base_tool.js';
import {BaseToolset} from '../../src/tools/base_toolset.js';
import {node} from '../../src/workflow/node.js';
import {NodeContext} from '../../src/workflow/node_context.js';
import {Workflow} from '../../src/workflow/workflow.js';

/** A toolset that records how often the runner closed it. */
class RecordingToolset extends BaseToolset {
  closeCount = 0;

  constructor(private readonly failure?: Error) {
    super([]);
  }

  async getTools(): Promise<BaseTool[]> {
    return [];
  }

  async close(): Promise<void> {
    this.closeCount++;
    if (this.failure) {
      throw this.failure;
    }
  }
}

/** An agent that emits one event without needing a model. */
class OneEventAgent extends LlmAgent {
  async *runAsyncImpl(
    context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    yield createEvent({
      invocationId: context.invocationId,
      author: this.name,
      branch: context.branch,
      content: {parts: [{text: 'done'}], role: 'model'},
    });
  }
}

function createRunner(agent: ConstructorParameters<typeof Runner>[0]['agent']) {
  return new Runner({
    appName: 'test_app',
    agent,
    sessionService: new InMemorySessionService(),
  });
}

describe('Runner.close', () => {
  it('should close every toolset in the agent tree', async () => {
    const rootToolset = new RecordingToolset();
    const subToolset = new RecordingToolset();
    const runner = createRunner(
      new LlmAgent({
        name: 'root_agent',
        tools: [rootToolset],
        subAgents: [new LlmAgent({name: 'sub_agent', tools: [subToolset]})],
      }),
    );

    await runner.close();

    expect(rootToolset.closeCount).toBe(1);
    expect(subToolset.closeCount).toBe(1);
  });

  it('should keep closing after a toolset throws', async () => {
    const broken = new RecordingToolset(new Error('close failed'));
    const sibling = new RecordingToolset();
    const runner = createRunner(
      new LlmAgent({name: 'root_agent', tools: [broken, sibling]}),
    );

    await expect(runner.close()).resolves.toBeUndefined();

    expect(broken.closeCount).toBe(1);
    expect(sibling.closeCount).toBe(1);
  });

  it('should be safe to call twice', async () => {
    const toolset = new RecordingToolset();
    const runner = createRunner(
      new LlmAgent({name: 'root_agent', tools: [toolset]}),
    );

    await expect(runner.close()).resolves.toBeUndefined();
    await expect(runner.close()).resolves.toBeUndefined();
  });

  it('should resolve for a runner with no toolsets', async () => {
    const runner = createRunner(new LlmAgent({name: 'root_agent'}));

    await expect(runner.close()).resolves.toBeUndefined();
  });

  it('should resolve for a runner whose root is not an agent', async () => {
    const runner = createRunner(
      new Workflow({
        name: 'wf',
        edges: [
          [
            'START',
            node((_c: NodeContext, input: string) => input, {name: 'echo'}),
          ],
        ],
      }),
    );

    await expect(runner.close()).resolves.toBeUndefined();
  });

  it('should still close the toolsets at the end of a run', async () => {
    const toolset = new RecordingToolset();
    const sessionService = new InMemorySessionService();
    const session = await sessionService.createSession({
      appName: 'test_app',
      userId: 'u1',
    });
    const runner = new Runner({
      appName: 'test_app',
      agent: new OneEventAgent({name: 'root_agent', tools: [toolset]}),
      sessionService,
    });

    const events: Event[] = [];
    for await (const event of runner.runAsync({
      userId: 'u1',
      sessionId: session.id,
      newMessage: {role: 'user', parts: [{text: 'go'}]},
    })) {
      events.push(event);
    }

    expect(events.length).toBeGreaterThan(0);
    expect(toolset.closeCount).toBe(1);
  });
});
