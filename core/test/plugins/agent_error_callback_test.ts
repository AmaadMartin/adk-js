/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseAgent,
  BaseAgentConfig,
  BasePlugin,
  Context,
  Event,
  InvocationContext,
  PluginManager,
  createEvent,
  createSession,
} from '@google/adk';
import {Content} from '@google/genai';
import {describe, expect, it} from 'vitest';

/** An agent whose body always throws, in both run modes. */
class CrashingAgent extends BaseAgent {
  constructor(
    config: BaseAgentConfig,
    private readonly crashError: Error = new Error('agent crashed'),
  ) {
    super(config);
  }

  // eslint-disable-next-line require-yield -- BaseAgent fixes the AsyncGenerator signature; a body that only throws has nothing to emit.
  protected async *runAsyncImpl(): AsyncGenerator<Event, void, void> {
    throw this.crashError;
  }

  // eslint-disable-next-line require-yield -- same as runAsyncImpl above.
  protected async *runLiveImpl(): AsyncGenerator<Event, void, void> {
    throw this.crashError;
  }
}

/** An agent that completes normally. */
class SuccessAgent extends BaseAgent {
  protected async *runAsyncImpl(
    context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    yield createEvent({
      invocationId: context.invocationId,
      author: this.name,
      branch: context.branch,
      content: {role: 'model', parts: [{text: 'ok'}]},
    });
  }

  protected async *runLiveImpl(
    context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    yield createEvent({
      invocationId: context.invocationId,
      author: this.name,
      branch: context.branch,
      content: {role: 'model', parts: [{text: 'ok live'}]},
    });
  }
}

/** Records which agent errors and after-agent calls a plugin observed. */
class ErrorTrackingPlugin extends BasePlugin {
  readonly agentErrors: Array<{agentName: string; error: Error}> = [];
  afterAgentCalled = false;

  override async onAgentErrorCallback({
    agent,
    error,
  }: {
    agent: BaseAgent;
    callbackContext: Context;
    error: Error;
  }): Promise<void> {
    this.agentErrors.push({agentName: agent.name, error});
  }

  override async afterAgentCallback(): Promise<Content | undefined> {
    this.afterAgentCalled = true;
    return undefined;
  }
}

/** A plugin whose error callback itself fails. */
class FailingPlugin extends BasePlugin {
  notified = false;

  override async onAgentErrorCallback(): Promise<void> {
    this.notified = true;
    throw new Error('plugin boom');
  }
}

/** A plugin manager that fails the whole fan-out, not just one plugin. */
class ThrowingPluginManager extends PluginManager {
  override async runOnAgentErrorCallback(): Promise<void> {
    throw new Error('plugin manager exploded');
  }
}

function createContext(
  agent: BaseAgent,
  plugins: BasePlugin[],
  abortSignal?: AbortSignal,
): InvocationContext {
  return new InvocationContext({
    invocationId: 'test-invocation',
    agent,
    session: createSession({id: 'test-session', appName: 'test-app'}),
    pluginManager: new PluginManager(plugins),
    abortSignal,
  });
}

async function drain(
  events: AsyncGenerator<Event, void, void>,
): Promise<Event[]> {
  const collected: Event[] = [];
  for await (const event of events) {
    collected.push(event);
  }
  return collected;
}

describe('onAgentErrorCallback', () => {
  it('fires when runAsyncImpl throws', async () => {
    const plugin = new ErrorTrackingPlugin('error_tracker');
    const agent = new CrashingAgent({name: 'crash_agent'});
    const context = createContext(agent, [plugin]);

    await expect(drain(agent.runAsync(context))).rejects.toThrow(
      'agent crashed',
    );

    expect(plugin.agentErrors).toHaveLength(1);
    expect(plugin.agentErrors[0].agentName).toBe('crash_agent');
    expect(plugin.agentErrors[0].error.message).toBe('agent crashed');
  });

  it('fires when runLiveImpl throws', async () => {
    const plugin = new ErrorTrackingPlugin('error_tracker');
    const agent = new CrashingAgent({name: 'crash_agent'});
    const context = createContext(agent, [plugin]);

    await expect(drain(agent.runLive(context))).rejects.toThrow(
      'agent crashed',
    );

    expect(plugin.agentErrors).toHaveLength(1);
    expect(plugin.agentErrors[0].agentName).toBe('crash_agent');
  });

  it('does not call afterAgentCallback on a crash', async () => {
    const plugin = new ErrorTrackingPlugin('error_tracker');
    const agent = new CrashingAgent({name: 'crash_agent'});
    const context = createContext(agent, [plugin]);

    await expect(drain(agent.runAsync(context))).rejects.toThrow(
      'agent crashed',
    );

    expect(plugin.afterAgentCalled).toBe(false);
  });

  it("fires when the agent's own beforeAgentCallback throws", async () => {
    const plugin = new ErrorTrackingPlugin('error_tracker');
    const agent = new SuccessAgent({
      name: 'good_agent',
      beforeAgentCallback: () => {
        throw new Error('before boom');
      },
    });
    const context = createContext(agent, [plugin]);

    await expect(drain(agent.runAsync(context))).rejects.toThrow('before boom');

    expect(plugin.agentErrors).toHaveLength(1);
    expect(plugin.agentErrors[0].agentName).toBe('good_agent');
    expect(plugin.afterAgentCalled).toBe(false);
  });

  it("fires when the agent's own afterAgentCallback throws", async () => {
    const plugin = new ErrorTrackingPlugin('error_tracker');
    const agent = new SuccessAgent({
      name: 'good_agent',
      afterAgentCallback: () => {
        throw new Error('after boom');
      },
    });
    const context = createContext(agent, [plugin]);

    await expect(drain(agent.runAsync(context))).rejects.toThrow('after boom');

    expect(plugin.agentErrors).toHaveLength(1);
    expect(plugin.agentErrors[0].agentName).toBe('good_agent');
  });

  it('re-throws the original error object unchanged', async () => {
    const plugin = new ErrorTrackingPlugin('error_tracker');
    const original = new TypeError('specific error');
    const agent = new CrashingAgent({name: 'crash_agent'}, original);
    const context = createContext(agent, [plugin]);

    const thrown = await drain(agent.runAsync(context)).catch(
      (e: unknown) => e,
    );

    expect(thrown).toBe(original);
    expect(plugin.agentErrors[0].error).toBe(original);
  });

  it('normalizes a thrown non-Error value', async () => {
    const plugin = new ErrorTrackingPlugin('error_tracker');
    const agent = new SuccessAgent({
      name: 'good_agent',
      beforeAgentCallback: () => {
        throw 'plain string failure';
      },
    });
    const context = createContext(agent, [plugin]);

    const thrown = await drain(agent.runAsync(context)).catch(
      (e: unknown) => e,
    );

    expect(thrown).toBe('plain string failure');
    expect(plugin.agentErrors[0].error).toBeInstanceOf(Error);
    expect(plugin.agentErrors[0].error.message).toContain(
      'plain string failure',
    );
  });

  it('does not fire on success, while afterAgentCallback does', async () => {
    const plugin = new ErrorTrackingPlugin('error_tracker');
    const agent = new SuccessAgent({name: 'good_agent'});
    const context = createContext(agent, [plugin]);

    const events = await drain(agent.runAsync(context));

    expect(events).toHaveLength(1);
    expect(plugin.agentErrors).toHaveLength(0);
    expect(plugin.afterAgentCalled).toBe(true);
  });

  it('does not fire when the consumer stops reading early', async () => {
    const plugin = new ErrorTrackingPlugin('error_tracker');
    const agent = new SuccessAgent({name: 'good_agent'});
    const context = createContext(agent, [plugin]);

    for await (const _ of agent.runAsync(context)) {
      break;
    }

    expect(plugin.agentErrors).toHaveLength(0);
  });

  it('does not fire when the invocation was aborted', async () => {
    const plugin = new ErrorTrackingPlugin('error_tracker');
    const controller = new AbortController();
    const agent = new SuccessAgent({
      name: 'cancel_agent',
      beforeAgentCallback: () => {
        controller.abort();
        throw new Error('cancelled');
      },
    });
    const context = createContext(agent, [plugin], controller.signal);

    await expect(drain(agent.runAsync(context))).rejects.toThrow('cancelled');

    expect(plugin.agentErrors).toHaveLength(0);
  });

  it('notifies every plugin, and a failing one masks neither', async () => {
    const failing = new FailingPlugin('bad_plugin');
    const tracker = new ErrorTrackingPlugin('error_tracker');
    const agent = new CrashingAgent({name: 'crash_agent'});
    const context = createContext(agent, [failing, tracker]);

    await expect(drain(agent.runAsync(context))).rejects.toThrow(
      'agent crashed',
    );

    expect(failing.notified).toBe(true);
    expect(tracker.agentErrors).toHaveLength(1);
    expect(tracker.agentErrors[0].error.message).toBe('agent crashed');
  });

  it('propagates the agent error when the whole fan-out fails', async () => {
    const original = new Error('agent crashed');
    const agent = new CrashingAgent({name: 'crash_agent'}, original);
    const context = new InvocationContext({
      invocationId: 'test-invocation',
      agent,
      session: createSession({id: 'test-session', appName: 'test-app'}),
      pluginManager: new ThrowingPluginManager(),
    });

    const thrown = await drain(agent.runAsync(context)).catch(
      (e: unknown) => e,
    );

    expect(thrown).toBe(original);
  });
});
