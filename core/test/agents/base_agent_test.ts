/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AgentTransferLlmRequestProcessor,
  BaseAgent,
  BaseAgentConfig,
  BasePlugin,
  Context,
  Event,
  FunctionTool,
  InvocationContext,
  LlmAgent,
  PluginManager,
  Session,
  createEvent,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

class MockAgent extends BaseAgent {
  constructor(config: BaseAgentConfig) {
    super(config);
  }

  protected async *runAsyncImpl(
    context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    yield createEvent({
      invocationId: context.invocationId,
      author: this.name,
      branch: context.branch,
      content: {role: 'model', parts: [{text: `Response from ${this.name}`}]},
    });
  }

  protected async *runLiveImpl(
    _context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    // Not needed for this test
  }
}

const AGENT_FAILURE = new Error('agent exploded');
const NON_ERROR_FAILURE = 'agent exploded without an Error';

/** An agent that streams one event and then fails, in both run modes. */
class ThrowingAgent extends BaseAgent {
  failure: unknown = AGENT_FAILURE;

  protected async *runAsyncImpl(
    context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    yield createEvent({
      invocationId: context.invocationId,
      author: this.name,
      content: {role: 'model', parts: [{text: 'partial work'}]},
    });
    throw this.failure;
  }

  protected async *runLiveImpl(
    context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    yield createEvent({
      invocationId: context.invocationId,
      author: this.name,
      content: {role: 'model', parts: [{text: 'partial live work'}]},
    });
    throw this.failure;
  }
}

/** Records every agent error it is notified of, and can fail on purpose. */
class AgentErrorPlugin extends BasePlugin {
  readonly notifications: Array<{
    agentName: string;
    invocationId: string;
    error: Error;
  }> = [];
  failInHook = false;

  constructor(name = 'agent_error_plugin') {
    super(name);
  }

  override async onAgentErrorCallback({
    agent,
    callbackContext,
    error,
  }: {
    agent: BaseAgent;
    callbackContext: Context;
    error: Error;
  }): Promise<void> {
    this.notifications.push({
      agentName: agent.name,
      invocationId: callbackContext.invocationId,
      error,
    });
    if (this.failInHook) {
      throw new Error('plugin hook exploded');
    }
  }
}

function createParentContext(
  agent: BaseAgent,
  pluginManager: PluginManager,
): InvocationContext {
  return new InvocationContext({
    invocationId: 'test-invocation',
    agent,
    session: {
      id: 'test-session',
      appName: 'test-app',
      userId: 'test-user',
      state: {},
      events: [],
      lastUpdateTime: Date.now(),
    } as Session,
    pluginManager,
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

describe('BaseAgent', () => {
  describe('agent error callbacks', () => {
    it('notifies the plugin once when runAsyncImpl throws', async () => {
      const plugin = new AgentErrorPlugin();
      const agent = new ThrowingAgent({name: 'crashing_agent'});
      const parentContext = createParentContext(
        agent,
        new PluginManager([plugin]),
      );

      await expect(drain(agent.runAsync(parentContext))).rejects.toBe(
        AGENT_FAILURE,
      );

      expect(plugin.notifications).toEqual([
        {
          agentName: 'crashing_agent',
          invocationId: 'test-invocation',
          error: AGENT_FAILURE,
        },
      ]);
    });

    it('does not run the after-agent callback when runAsyncImpl throws', async () => {
      let afterAgentCallbackCalled = false;
      const plugin = new AgentErrorPlugin();
      const agent = new ThrowingAgent({
        name: 'crashing_agent',
        afterAgentCallback: async () => {
          afterAgentCallbackCalled = true;
          return undefined;
        },
      });
      const parentContext = createParentContext(
        agent,
        new PluginManager([plugin]),
      );

      await expect(drain(agent.runAsync(parentContext))).rejects.toBe(
        AGENT_FAILURE,
      );

      expect(afterAgentCallbackCalled).toBe(false);
    });

    it('notifies the plugin when a before-agent callback throws', async () => {
      const beforeFailure = new Error('before-agent callback exploded');
      const plugin = new AgentErrorPlugin();
      const agent = new MockAgent({
        name: 'callback_crash_agent',
        beforeAgentCallback: async () => {
          throw beforeFailure;
        },
      });
      const parentContext = createParentContext(
        agent,
        new PluginManager([plugin]),
      );

      await expect(drain(agent.runAsync(parentContext))).rejects.toBe(
        beforeFailure,
      );

      expect(plugin.notifications).toEqual([
        {
          agentName: 'callback_crash_agent',
          invocationId: 'test-invocation',
          error: beforeFailure,
        },
      ]);
    });

    it('notifies the plugin when runLiveImpl throws', async () => {
      const plugin = new AgentErrorPlugin();
      const agent = new ThrowingAgent({name: 'crashing_live_agent'});
      const parentContext = createParentContext(
        agent,
        new PluginManager([plugin]),
      );

      await expect(drain(agent.runLive(parentContext))).rejects.toBe(
        AGENT_FAILURE,
      );

      expect(plugin.notifications).toEqual([
        {
          agentName: 'crashing_live_agent',
          invocationId: 'test-invocation',
          error: AGENT_FAILURE,
        },
      ]);
    });

    it('keeps the original error when the plugin hook itself throws', async () => {
      const plugin = new AgentErrorPlugin();
      plugin.failInHook = true;
      const agent = new ThrowingAgent({name: 'crashing_agent'});
      const parentContext = createParentContext(
        agent,
        new PluginManager([plugin]),
      );

      await expect(drain(agent.runAsync(parentContext))).rejects.toBe(
        AGENT_FAILURE,
      );

      expect(plugin.notifications).toHaveLength(1);
    });

    it('wraps a non-Error failure for the plugin and rethrows the original', async () => {
      const plugin = new AgentErrorPlugin();
      const agent = new ThrowingAgent({name: 'crashing_agent'});
      agent.failure = NON_ERROR_FAILURE;
      const parentContext = createParentContext(
        agent,
        new PluginManager([plugin]),
      );

      await expect(drain(agent.runAsync(parentContext))).rejects.toBe(
        NON_ERROR_FAILURE,
      );

      expect(plugin.notifications).toHaveLength(1);
      expect(plugin.notifications[0].agentName).toBe('crashing_agent');
      expect(plugin.notifications[0].error).toBeInstanceOf(Error);
      expect(plugin.notifications[0].error.message).toBe(NON_ERROR_FAILURE);
    });

    it('notifies no plugin on a successful run', async () => {
      let afterAgentCallbackCalled = false;
      const plugin = new AgentErrorPlugin();
      const agent = new MockAgent({
        name: 'healthy_agent',
        afterAgentCallback: async () => {
          afterAgentCallbackCalled = true;
          return undefined;
        },
      });
      const parentContext = createParentContext(
        agent,
        new PluginManager([plugin]),
      );

      const events = await drain(agent.runAsync(parentContext));

      expect(events).toHaveLength(1);
      expect(plugin.notifications).toEqual([]);
      expect(afterAgentCallbackCalled).toBe(true);
    });
  });

  describe('rootAgent', () => {
    it('should return the actual root agent for sub-agents', () => {
      const subAgent = new LlmAgent({
        name: 'sub_agent',
        description: 'A sub agent',
      });

      const rootAgent = new LlmAgent({
        name: 'root_agent',
        description: 'The root agent',
        subAgents: [subAgent],
      });

      expect(subAgent.rootAgent).toBe(rootAgent);
      expect(rootAgent.rootAgent).toBe(rootAgent);
    });

    it('should traverse multiple levels of nesting', () => {
      const leafAgent = new LlmAgent({name: 'leaf_agent'});
      const middleAgent = new LlmAgent({
        name: 'middle_agent',
        subAgents: [leafAgent],
      });
      const rootAgent = new LlmAgent({
        name: 'root_agent',
        subAgents: [middleAgent],
      });

      expect(leafAgent.rootAgent).toBe(rootAgent);
      expect(middleAgent.rootAgent).toBe(rootAgent);
      expect(rootAgent.rootAgent).toBe(rootAgent);
    });
  });

  describe('Abort Signal Handling', () => {
    it('should stop processing beforeAgentCallbacks if aborted', async () => {
      const controller = new AbortController();
      let callback2Called = false;

      const agent = new MockAgent({
        name: 'test_agent',
        beforeAgentCallback: [
          async () => {
            controller.abort();
            return undefined;
          },
          async () => {
            callback2Called = true;
            return undefined;
          },
        ],
      });

      const parentContext = new InvocationContext({
        invocationId: 'test',
        agent: agent,
        session: {
          id: 'test-session',
          appName: 'test-app',
          userId: 'test-user',
          state: {},
          events: [],
          lastUpdateTime: Date.now(),
        } as Session,
        pluginManager: new PluginManager(),
        abortSignal: controller.signal,
      });

      const generator = agent.runAsync(parentContext);

      for await (const _ of generator) {
        // do nothing
      }

      expect(callback2Called).toBe(false);
    });

    it('should stop processing afterAgentCallbacks if aborted', async () => {
      const controller = new AbortController();
      let callback2Called = false;

      const agent = new MockAgent({
        name: 'test_agent',
        afterAgentCallback: [
          async () => {
            controller.abort();
            return undefined;
          },
          async () => {
            callback2Called = true;
            return undefined;
          },
        ],
      });

      const parentContext = new InvocationContext({
        invocationId: 'test',
        agent: agent,
        session: {
          id: 'test-session',
          appName: 'test-app',
          userId: 'test-user',
          state: {},
          events: [],
          lastUpdateTime: Date.now(),
        } as Session,
        pluginManager: new PluginManager(),
        abortSignal: controller.signal,
      });

      const generator = agent.runAsync(parentContext);

      for await (const _ of generator) {
        // do nothing
      }

      expect(callback2Called).toBe(false);
    });
  });

  describe('clone', () => {
    const makeTool = (name: string) =>
      new FunctionTool({
        name,
        description: `tool ${name}`,
        execute: async () => 'ok',
      });

    it('returns a new, equivalent instance when given no overrides', () => {
      const tool = makeTool('search');
      const agent = new LlmAgent({
        name: 'original',
        description: 'the original agent',
        instruction: 'be helpful',
        model: 'gemini-2.5-flash',
        tools: [tool],
      });

      const clone = agent.clone();

      expect(clone).not.toBe(agent);
      expect(clone).toBeInstanceOf(LlmAgent);
      expect(clone.name).toBe('original');
      expect(clone.description).toBe('the original agent');
      expect(clone.instruction).toBe('be helpful');
      expect(clone.model).toBe('gemini-2.5-flash');
      expect(clone.tools).toEqual([tool]);
    });

    it('shallow-copies list fields so clones never share arrays', () => {
      const tool = makeTool('search');
      const agent = new LlmAgent({name: 'original', tools: [tool]});

      const clone = agent.clone();

      // Different array object, same tool instances (shallow copy).
      expect(clone.tools).not.toBe(agent.tools);
      expect(clone.tools[0]).toBe(tool);
    });

    it('rebuilds a single agent-transfer processor (no duplication)', () => {
      const agent = new LlmAgent({name: 'original', instruction: 'hi'});

      const clone = agent.clone();

      const countTransfer = (a: LlmAgent) =>
        a.requestProcessors.filter(
          (p) => p instanceof AgentTransferLlmRequestProcessor,
        ).length;
      expect(countTransfer(agent)).toBe(1);
      expect(countTransfer(clone)).toBe(1);
    });

    it('applies an instruction override without mutating the original', () => {
      const agent = new LlmAgent({name: 'original', instruction: 'old'});

      const clone = agent.clone({instruction: 'new'});

      expect(clone.instruction).toBe('new');
      expect(agent.instruction).toBe('old');
    });

    it('applies a name override only to the clone', () => {
      const agent = new LlmAgent({name: 'original'});

      const clone = agent.clone({name: 'renamed'});

      expect(clone.name).toBe('renamed');
      expect(agent.name).toBe('original');
    });

    it('uses the provided tools when tools is overridden', () => {
      const original = makeTool('search');
      const replacement = makeTool('lookup');
      const agent = new LlmAgent({name: 'original', tools: [original]});

      const clone = agent.clone({tools: [replacement]});

      expect(clone.tools).toEqual([replacement]);
      expect(agent.tools).toEqual([original]);
    });

    it('throws when overriding parentAgent', () => {
      const agent = new LlmAgent({name: 'original'});
      const wouldBeParent = new LlmAgent({name: 'parent'});

      expect(() => agent.clone({parentAgent: wouldBeParent})).toThrow(
        'Cannot update `parentAgent` field in clone.',
      );
    });

    it('detaches the clone of a sub-agent from its parent', () => {
      const subAgent = new LlmAgent({name: 'sub'});
      const root = new LlmAgent({name: 'root', subAgents: [subAgent]});
      expect(subAgent.parentAgent).toBe(root);

      const clone = subAgent.clone();

      expect(clone.parentAgent).toBeUndefined();
    });

    it('recursively clones sub-agents and re-parents them', () => {
      const subAgent = new LlmAgent({name: 'sub'});
      const root = new LlmAgent({name: 'root', subAgents: [subAgent]});

      const clonedRoot = root.clone();

      expect(clonedRoot.subAgents).not.toBe(root.subAgents);
      expect(clonedRoot.subAgents[0]).not.toBe(subAgent);
      expect(clonedRoot.subAgents[0].parentAgent).toBe(clonedRoot);
      // The original tree is untouched.
      expect(subAgent.parentAgent).toBe(root);
    });

    it('uses the provided sub-agents when subAgents is overridden', () => {
      const subAgent = new LlmAgent({name: 'sub'});
      const root = new LlmAgent({name: 'root', subAgents: [subAgent]});
      const replacement = new LlmAgent({name: 'replacement'});

      const clonedRoot = root.clone({subAgents: [replacement]});

      expect(clonedRoot.subAgents[0]).toBe(replacement);
      expect(clonedRoot.subAgents[0].parentAgent).toBe(clonedRoot);
    });

    it('clones a plain BaseAgent subclass', () => {
      const agent = new MockAgent({name: 'mock', description: 'a mock'});

      const clone = agent.clone();

      expect(clone).not.toBe(agent);
      expect(clone).toBeInstanceOf(MockAgent);
      expect(clone.name).toBe('mock');
      expect(clone.description).toBe('a mock');
    });
  });
});
