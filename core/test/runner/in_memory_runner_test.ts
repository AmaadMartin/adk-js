/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseAgent,
  BasePlugin,
  BaseTool,
  BaseToolset,
  createEvent,
  Event,
  InMemoryRunner,
  InvocationContext,
  LlmAgent,
} from '@google/adk';
import {afterEach, describe, expect, it, vi} from 'vitest';

const TEST_USER_ID = 'test_user_id';
const TEST_MESSAGE = 'Hello, agent!';

class MockAgent extends BaseAgent {
  constructor(name = 'mock_agent') {
    super({name});
  }

  protected async *runAsyncImpl(
    context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    yield createEvent({
      invocationId: context.invocationId,
      author: this.name,
      content: {role: 'model', parts: [{text: 'Mock response'}]},
    });
  }

  protected async *runLiveImpl(
    _context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {}
}

describe('InMemoryRunner', () => {
  it('should initialize with required agent parameter', () => {
    const agent = new MockAgent();
    const runner = new InMemoryRunner({agent});

    expect(runner.agent).toBe(agent);
    expect(runner.appName).toBe('InMemoryRunner');
  });

  it('should use custom appName when provided', () => {
    const agent = new MockAgent();
    const runner = new InMemoryRunner({agent, appName: 'MyApp'});

    expect(runner.appName).toBe('MyApp');
  });

  it('should initialize with in-memory services', () => {
    const agent = new MockAgent();
    const runner = new InMemoryRunner({agent});

    expect(runner.sessionService).toBeDefined();
    expect(runner.artifactService).toBeDefined();
    expect(runner.memoryService).toBeDefined();
  });

  it('should accept plugins', () => {
    const agent = new MockAgent();
    const plugin = new (class extends BasePlugin {
      constructor() {
        super('test_plugin');
      }
    })();

    const runner = new InMemoryRunner({agent, plugins: [plugin]});
    expect(runner.pluginManager).toBeDefined();
  });

  it('should default to empty plugins array', () => {
    const agent = new MockAgent();
    const runner = new InMemoryRunner({agent});

    expect(runner.pluginManager).toBeDefined();
  });

  it('should run agent and yield events', async () => {
    const agent = new MockAgent();
    const runner = new InMemoryRunner({agent});

    const session = await runner.sessionService.createSession({
      appName: runner.appName,
      userId: TEST_USER_ID,
    });

    const events: Event[] = [];
    for await (const event of runner.runAsync({
      userId: TEST_USER_ID,
      sessionId: session.id,
      newMessage: {role: 'user', parts: [{text: TEST_MESSAGE}]},
    })) {
      events.push(event);
    }

    expect(events.length).toBeGreaterThan(0);
    const agentEvent = events.find((e) => e.author === 'mock_agent');
    expect(agentEvent).toBeDefined();
    expect(agentEvent?.content?.parts?.[0]?.text).toBe('Mock response');
  });

  it('should support multiple independent sessions', async () => {
    const agent = new MockAgent();
    const runner = new InMemoryRunner({agent});

    const session1 = await runner.sessionService.createSession({
      appName: runner.appName,
      userId: 'user_1',
    });
    const session2 = await runner.sessionService.createSession({
      appName: runner.appName,
      userId: 'user_2',
    });

    expect(session1.id).not.toBe(session2.id);

    const events1: Event[] = [];
    for await (const event of runner.runAsync({
      userId: 'user_1',
      sessionId: session1.id,
      newMessage: {role: 'user', parts: [{text: 'Hello from user 1'}]},
    })) {
      events1.push(event);
    }

    const events2: Event[] = [];
    for await (const event of runner.runAsync({
      userId: 'user_2',
      sessionId: session2.id,
      newMessage: {role: 'user', parts: [{text: 'Hello from user 2'}]},
    })) {
      events2.push(event);
    }

    expect(events1.length).toBeGreaterThan(0);
    expect(events2.length).toBeGreaterThan(0);
  });

  it('automatically closes stateful toolsets at the end of runAsync', async () => {
    const closeSpy = vi.fn().mockResolvedValue(undefined);

    class CustomToolset extends BaseToolset {
      constructor() {
        super([]);
      }
      async getTools(): Promise<BaseTool[]> {
        return [];
      }
      async close(): Promise<void> {
        await closeSpy();
      }
    }

    const toolset = new CustomToolset();
    const agent = new LlmAgent({
      name: 'llm_agent',
      tools: [toolset],
    });

    const runner = new InMemoryRunner({agent});

    const session = await runner.sessionService.createSession({
      appName: runner.appName,
      userId: TEST_USER_ID,
    });

    try {
      for await (const _ of runner.runAsync({
        userId: TEST_USER_ID,
        sessionId: session.id,
        newMessage: {role: 'user', parts: [{text: TEST_MESSAGE}]},
      })) {
        // consume events
      }
    } catch (_e: unknown) {
      // Ignore any model-related errors because we only care that finally block closes the toolset!
    }

    expect(closeSpy).toHaveBeenCalled();
  });
});

/** A plugin whose `close()` finishes only when the test settles its gate. */
class HangingPlugin extends BasePlugin {
  closeCount = 0;

  constructor(
    name: string,
    private readonly gate: Promise<void>,
  ) {
    super(name);
  }

  override async close(): Promise<void> {
    this.closeCount++;
    await this.gate;
  }
}

describe('InMemoryRunner pluginCloseTimeoutMs', () => {
  let releaseGate: () => void = () => {};

  afterEach(() => {
    // Release the hung close so no worker is held open past its test.
    releaseGate();
  });

  it('should forward the budget to the plugin manager', async () => {
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const runner = new InMemoryRunner({
      agent: new MockAgent(),
      plugins: [new HangingPlugin('hangs', gate)],
      pluginCloseTimeoutMs: 20,
    });

    const startedAt = Date.now();
    const error = await runner.close().catch((e: unknown) => e);

    if (!(error instanceof AggregateError)) {
      expect.fail(`expected an AggregateError, got ${String(error)}`);
    }
    expect(error.message).toEqual(
      "Failed to close plugins: 'hangs': PluginCloseTimeoutError",
    );
    // Far below the 5000 ms default, so the configured budget was the one used.
    expect(Date.now() - startedAt).toBeLessThan(1000);
  });
});
