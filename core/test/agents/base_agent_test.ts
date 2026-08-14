/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {BaseAgentConfig, Event, Session} from '@google/adk';
import {
  AgentTransferLlmRequestProcessor,
  BaseAgent,
  FunctionTool,
  InvocationContext,
  LlmAgent,
  PluginManager,
  createEvent,
  createSession,
} from '@google/adk';
import {describe, expect, it, vi} from 'vitest';
import * as metrics from '../../src/telemetry/metrics.js';

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
}

/** A text-only agent, declaring no live implementation of its own. */
class LiveLessAgent extends BaseAgent {
  protected async *runAsyncImpl(
    context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    yield createEvent({
      invocationId: context.invocationId,
      author: this.name,
      content: {role: 'model', parts: [{text: `Response from ${this.name}`}]},
    });
  }
}

/** An agent that overrides the default live implementation. */
class LiveCapableAgent extends BaseAgent {
  protected async *runAsyncImpl(): AsyncGenerator<Event, void, void> {}

  protected async *runLiveImpl(
    context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    yield createEvent({
      invocationId: context.invocationId,
      author: this.name,
      content: {
        role: 'model',
        parts: [{text: `Live response from ${this.name}`}],
      },
    });
  }
}

async function drainTexts(
  events: AsyncGenerator<Event, void, void>,
): Promise<Array<string | undefined>> {
  const texts: Array<string | undefined> = [];
  for await (const event of events) {
    texts.push(event.content?.parts?.[0]?.text);
  }
  return texts;
}

describe('BaseAgent', () => {
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

  describe('runLiveImpl', () => {
    const makeContext = (agent: BaseAgent) =>
      new InvocationContext({
        invocationId: 'live-invocation',
        agent,
        session: createSession({id: 'live-session', appName: 'test-app'}),
        pluginManager: new PluginManager(),
      });

    it('throws by default, naming the concrete class', async () => {
      const agent = new MockAgent({name: 'text_only'});

      await expect(
        drainTexts(agent.runLive(makeContext(agent))),
      ).rejects.toThrow('runLiveImpl for MockAgent is not implemented.');
    });

    it('names whichever subclass is running, rather than a fixed class', async () => {
      const agent = new LiveLessAgent({name: 'live_less'});

      await expect(
        drainTexts(agent.runLive(makeContext(agent))),
      ).rejects.toThrow('runLiveImpl for LiveLessAgent is not implemented.');
    });

    it('does not shadow a subclass override', async () => {
      const agent = new LiveCapableAgent({name: 'live_capable'});

      await expect(
        drainTexts(agent.runLive(makeContext(agent))),
      ).resolves.toEqual(['Live response from live_capable']);
    });

    it('surfaces the failure on the first iteration, not when runLive is called', async () => {
      const agent = new MockAgent({name: 'text_only'});

      const events = agent.runLive(makeContext(agent));

      await expect(events.next()).rejects.toThrow(
        'runLiveImpl for MockAgent is not implemented.',
      );
    });

    it('leaves the runAsync path of a text-only subclass untouched', async () => {
      const agent = new LiveLessAgent({name: 'live_less'});

      await expect(
        drainTexts(agent.runAsync(makeContext(agent))),
      ).resolves.toEqual(['Response from live_less']);
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

  describe('Metrics and Callback Events', () => {
    it('should handle short-circuiting and metrics in beforeAgentCallback', async () => {
      const mockBeforeContent = {role: 'model', parts: [{text: 'before'}]};

      const agent = new MockAgent({
        name: 'test_before_callback_agent',
        beforeAgentCallback: [async () => mockBeforeContent],
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
      });

      const spyRequestSize = vi.spyOn(metrics, 'recordAgentRequestSize');
      const spyInvocationDuration = vi.spyOn(
        metrics,
        'recordAgentInvocationDuration',
      );
      const spyWorkflowSteps = vi.spyOn(metrics, 'recordAgentWorkflowSteps');
      const spyResponseSize = vi.spyOn(metrics, 'recordAgentResponseSize');

      const generator = agent.runAsync(parentContext);
      const events: Event[] = [];
      for await (const event of generator) {
        events.push(event);
      }

      expect(events).toHaveLength(1);
      expect(events[0]).toEqual(
        expect.objectContaining({
          author: 'test_before_callback_agent',
          content: mockBeforeContent,
        }),
      );

      expect(spyRequestSize).toHaveBeenCalled();
      expect(spyInvocationDuration).toHaveBeenCalled();
      expect(spyWorkflowSteps).toHaveBeenCalledWith(
        'test_before_callback_agent',
        1,
      );
      expect(spyResponseSize).toHaveBeenCalledWith(
        'test_before_callback_agent',
        mockBeforeContent,
      );
    });

    it('should push afterAgentCallback events and record metrics when execution succeeds', async () => {
      const mockAfterContent = {role: 'model', parts: [{text: 'after'}]};

      const agent = new MockAgent({
        name: 'test_after_callback_agent',
        afterAgentCallback: [async () => mockAfterContent],
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
      });

      const spyRequestSize = vi.spyOn(metrics, 'recordAgentRequestSize');
      const spyInvocationDuration = vi.spyOn(
        metrics,
        'recordAgentInvocationDuration',
      );
      const spyWorkflowSteps = vi.spyOn(metrics, 'recordAgentWorkflowSteps');
      const spyResponseSize = vi.spyOn(metrics, 'recordAgentResponseSize');

      const generator = agent.runAsync(parentContext);
      const events: Event[] = [];
      for await (const event of generator) {
        events.push(event);
      }

      expect(events).toContainEqual(
        expect.objectContaining({
          author: 'test_after_callback_agent',
          content: mockAfterContent,
        }),
      );

      expect(spyRequestSize).toHaveBeenCalled();
      expect(spyInvocationDuration).toHaveBeenCalled();
      // One event from runAsyncImpl plus the afterAgentCallback event.
      expect(spyWorkflowSteps).toHaveBeenCalledWith(
        'test_after_callback_agent',
        2,
      );
      expect(spyResponseSize).toHaveBeenCalledWith(
        'test_after_callback_agent',
        mockAfterContent,
      );
    });

    it('should count only its own events and report its last own content', async () => {
      const ownFirstContent = {role: 'model', parts: [{text: 'first'}]};
      const ownLastContent = {role: 'model', parts: [{text: 'last own'}]};

      class MixedAuthorAgent extends BaseAgent {
        protected async *runAsyncImpl(
          context: InvocationContext,
        ): AsyncGenerator<Event, void, void> {
          const emitted = [
            {author: this.name, content: ownFirstContent},
            {author: 'sub_agent', content: {parts: [{text: 'sub 1'}]}},
            {author: this.name, content: ownLastContent},
            // A trailing sub-agent event must not become this agent's
            // response, and must not count towards its workflow steps.
            {author: 'sub_agent', content: {parts: [{text: 'sub 2'}]}},
          ];
          for (const {author, content} of emitted) {
            yield createEvent({
              invocationId: context.invocationId,
              author,
              content,
            });
          }
        }

        protected async *runLiveImpl(): AsyncGenerator<Event, void, void> {
          // Not needed for this test.
        }
      }

      const agent = new MixedAuthorAgent({name: 'mixed_author_agent'});
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
      });

      const spyWorkflowSteps = vi.spyOn(metrics, 'recordAgentWorkflowSteps');
      const spyResponseSize = vi.spyOn(metrics, 'recordAgentResponseSize');

      const events: Event[] = [];
      for await (const event of agent.runAsync(parentContext)) {
        events.push(event);
      }

      expect(events).toHaveLength(4);
      expect(spyWorkflowSteps).toHaveBeenCalledWith('mixed_author_agent', 2);
      expect(spyResponseSize).toHaveBeenCalledWith(
        'mixed_author_agent',
        ownLastContent,
      );
    });

    it('should record no steps and no content when it authors nothing', async () => {
      class SubAgentOnlyAgent extends BaseAgent {
        protected async *runAsyncImpl(
          context: InvocationContext,
        ): AsyncGenerator<Event, void, void> {
          yield createEvent({
            invocationId: context.invocationId,
            author: 'sub_agent',
            content: {parts: [{text: 'only from the sub agent'}]},
          });
        }

        protected async *runLiveImpl(): AsyncGenerator<Event, void, void> {
          // Not needed for this test.
        }
      }

      const agent = new SubAgentOnlyAgent({name: 'sub_agent_only_agent'});
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
      });

      const spyWorkflowSteps = vi.spyOn(metrics, 'recordAgentWorkflowSteps');
      const spyResponseSize = vi.spyOn(metrics, 'recordAgentResponseSize');

      for await (const _ of agent.runAsync(parentContext)) {
        continue;
      }

      expect(spyWorkflowSteps).toHaveBeenCalledWith('sub_agent_only_agent', 0);
      expect(spyResponseSize).toHaveBeenCalledWith(
        'sub_agent_only_agent',
        undefined,
      );
    });

    it('should record agent invocation duration with error if implementation throws', async () => {
      class ErrorAgent extends BaseAgent {
        protected async *runAsyncImpl(): AsyncGenerator<Event, void, void> {
          yield* [];
          throw new Error('Agent failed');
        }
        protected async *runLiveImpl(): AsyncGenerator<Event, void, void> {
          yield* [];
        }
      }

      const agent = new ErrorAgent({name: 'error_agent'});
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
      });

      const spyInvocationDuration = vi.spyOn(
        metrics,
        'recordAgentInvocationDuration',
      );

      await expect(async () => {
        const generator = agent.runAsync(parentContext);
        for await (const _ of generator) {
          continue;
        }
      }).rejects.toThrow('Agent failed');

      expect(spyInvocationDuration).toHaveBeenCalledWith(
        'error_agent',
        expect.any(Number),
        expect.any(Error),
      );
    });
  });
});
