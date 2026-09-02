/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AgentConfigSchema,
  AgentTransferLlmRequestProcessor,
  BaseAgent,
  BaseAgentConfig,
  BasePlugin,
  ContextCompactorRequestProcessor,
  Event,
  FunctionTool,
  InvocationContext,
  LlmAgent,
  LlmAgentConfig,
  PluginManager,
  Session,
  TruncatingContextCompactor,
  createEvent,
  createSession,
} from '@google/adk';
import {Content} from '@google/genai';
import {describe, expect, it, vi} from 'vitest';
import {z} from 'zod';
import {logger} from '../../src/utils/logger.js';

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

interface LazyConfigAgentConfig extends BaseAgentConfig {
  greeting?: string;
}

/** Reads its config on demand instead of assigning it, like RemoteA2AAgent. */
class LazyConfigAgent extends BaseAgent<LazyConfigAgentConfig> {
  protected override get unassignedConfigKeys(): readonly (keyof LazyConfigAgentConfig)[] {
    return ['greeting'];
  }

  protected async *runAsyncImpl(
    context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    yield createEvent({
      invocationId: context.invocationId,
      author: this.name,
      content: {role: 'model', parts: [{text: this.config.greeting ?? 'none'}]},
    });
  }

  protected async *runLiveImpl(
    _context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {}
}

/** Records the config `fromConfig` derived, so a test can inspect it. */
class RecordingAgent extends MockAgent {
  readonly receivedConfig: BaseAgentConfig;

  constructor(config: BaseAgentConfig) {
    super(config);
    this.receivedConfig = config;
  }
}

interface ToneAgentConfig extends BaseAgentConfig {
  tone: string;
}

/** Declares its own config schema, with a field the base schema lacks. */
class ToneAgent extends BaseAgent<ToneAgentConfig> {
  static override configType: AgentConfigSchema = z.looseObject({
    agentClass: z.string().default('ToneAgent'),
    name: z.string(),
    description: z.string().default(''),
    tone: z.string(),
  });

  readonly tone: string;

  constructor(config: ToneAgentConfig) {
    super(config);
    this.tone = config.tone;
  }

  protected async *runAsyncImpl(): AsyncGenerator<Event, void, void> {}

  protected async *runLiveImpl(): AsyncGenerator<Event, void, void> {}
}

/** Checks across fields, so a failure carries no field path. */
class EitherAgent extends MockAgent {
  static override configType: AgentConfigSchema = z
    .looseObject({
      agentClass: z.string().default('EitherAgent'),
      name: z.string(),
      description: z.string().default(''),
      tone: z.string().optional(),
      style: z.string().optional(),
    })
    .refine(
      (config) => config.tone !== undefined || config.style !== undefined,
      {
        message: 'either tone or style is required',
      },
    );
}

/** Overrides the `parseConfig` hook to derive a field of its own. */
class DescribedAgent extends MockAgent {
  static override parseConfig(
    _config: unknown,
    configAbsPath: string | undefined,
    kwargs: BaseAgentConfig,
  ): BaseAgentConfig {
    return {...kwargs, description: `described by ${configAbsPath}`};
  }
}

const said = (value: string): Content => ({
  role: 'model',
  parts: [{text: value}],
});

const run = async (agent: BaseAgent): Promise<Event[]> => {
  const events: Event[] = [];
  const context = new InvocationContext({
    invocationId: 'test',
    agent,
    session: createSession({id: 'test-session', appName: 'test-app'}),
    pluginManager: new PluginManager(),
  });

  for await (const event of agent.runAsync(context)) {
    events.push(event);
  }

  return events;
};

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

  describe('plugin agent callbacks', () => {
    class AgentHookPlugin extends BasePlugin {
      beforeCalls = 0;
      afterCalls = 0;

      constructor(
        name: string,
        private readonly beforeContent?: Content,
        private readonly afterContent?: Content,
      ) {
        super(name);
      }

      override async beforeAgentCallback(): Promise<Content | undefined> {
        this.beforeCalls++;
        return this.beforeContent;
      }

      override async afterAgentCallback(): Promise<Content | undefined> {
        this.afterCalls++;
        return this.afterContent;
      }
    }

    const text = (value: string): Content => ({
      role: 'model',
      parts: [{text: value}],
    });

    const contextFor = (agent: BaseAgent, plugin: BasePlugin) =>
      new InvocationContext({
        invocationId: 'test',
        agent,
        session: createSession({id: 'test-session', appName: 'test-app'}),
        pluginManager: new PluginManager([plugin]),
      });

    const drain = async (events: AsyncGenerator<Event, void, void>) => {
      const collected: Event[] = [];
      for await (const event of events) {
        collected.push(event);
      }
      return collected;
    };

    it('runs the plugin hooks on an agent that declares none of its own', async () => {
      const plugin = new AgentHookPlugin('hooks');
      const agent = new MockAgent({name: 'test_agent'});

      const events = await drain(agent.runAsync(contextFor(agent, plugin)));

      expect(plugin.beforeCalls).toBe(1);
      expect(plugin.afterCalls).toBe(1);
      expect(events).toHaveLength(1);
    });

    it('lets plugin before-content short-circuit the whole run', async () => {
      const plugin = new AgentHookPlugin('hooks', text('from plugin'));
      let ownCallbackCalled = false;
      const agent = new MockAgent({
        name: 'test_agent',
        beforeAgentCallback: () => {
          ownCallbackCalled = true;
          return undefined;
        },
      });

      const events = await drain(agent.runAsync(contextFor(agent, plugin)));

      // MockAgent's body yields one event of its own; only the plugin's
      // content came back, so the body never ran.
      expect(events).toHaveLength(1);
      expect(events[0].content).toEqual(text('from plugin'));
      expect(events[0].author).toBe('test_agent');
      expect(ownCallbackCalled).toBe(false);
    });

    it('appends plugin after-content and skips the agent\u2019s own hook', async () => {
      const plugin = new AgentHookPlugin(
        'hooks',
        undefined,
        text('after plugin'),
      );
      let ownCallbackCalled = false;
      const agent = new MockAgent({
        name: 'test_agent',
        afterAgentCallback: () => {
          ownCallbackCalled = true;
          return undefined;
        },
      });

      const events = await drain(agent.runAsync(contextFor(agent, plugin)));

      expect(events).toHaveLength(2);
      expect(events[1].content).toEqual(text('after plugin'));
      expect(ownCallbackCalled).toBe(false);
    });

    it("falls through to the agent's own callbacks when the plugin returns nothing", async () => {
      const plugin = new AgentHookPlugin('hooks');
      const agent = new MockAgent({
        name: 'test_agent',
        beforeAgentCallback: () => text('from agent'),
      });

      const events = await drain(agent.runAsync(contextFor(agent, plugin)));

      expect(plugin.beforeCalls).toBe(1);
      expect(events).toHaveLength(1);
      expect(events[0].content).toEqual(text('from agent'));
    });

    it('runs the plugin hooks on runLive too', async () => {
      const plugin = new AgentHookPlugin('hooks', text('from plugin'));
      const agent = new MockAgent({name: 'test_agent'});

      const events = await drain(agent.runLive(contextFor(agent, plugin)));

      expect(plugin.beforeCalls).toBe(1);
      expect(events).toHaveLength(1);
      expect(events[0].content).toEqual(text('from plugin'));
    });

    it('yields plugin after-content from runLive', async () => {
      const plugin = new AgentHookPlugin(
        'hooks',
        undefined,
        text('after live'),
      );
      const agent = new MockAgent({name: 'test_agent'});

      const events = await drain(agent.runLive(contextFor(agent, plugin)));

      expect(events).toHaveLength(1);
      expect(events[0].content).toEqual(text('after live'));
    });

    it('yields the agent\u2019s own after-content', async () => {
      const plugin = new AgentHookPlugin('hooks');
      const agent = new MockAgent({
        name: 'test_agent',
        afterAgentCallback: () => text('from agent'),
      });

      const events = await drain(agent.runAsync(contextFor(agent, plugin)));

      expect(events).toHaveLength(2);
      expect(events[1].content).toEqual(text('from agent'));
    });

    it('reports a state delta a before-callback wrote, without content', async () => {
      const plugin = new AgentHookPlugin('hooks');
      const agent = new MockAgent({
        name: 'test_agent',
        beforeAgentCallback: (callbackContext) => {
          callbackContext.state.set('before_key', 'before_value');
          return undefined;
        },
      });

      const events = await drain(agent.runAsync(contextFor(agent, plugin)));

      expect(events).toHaveLength(2);
      expect(events[0].content).toBeUndefined();
      expect(events[0].actions.stateDelta).toEqual({
        before_key: 'before_value',
      });
    });

    it('reports a state delta an after-callback wrote, without content', async () => {
      const plugin = new AgentHookPlugin('hooks');
      const agent = new MockAgent({
        name: 'test_agent',
        afterAgentCallback: (callbackContext) => {
          callbackContext.state.set('after_key', 'after_value');
          return undefined;
        },
      });

      const events = await drain(agent.runAsync(contextFor(agent, plugin)));

      expect(events).toHaveLength(2);
      expect(events[1].content).toBeUndefined();
      expect(events[1].actions.stateDelta).toEqual({after_key: 'after_value'});
    });
  });

  describe('clone validation', () => {
    it('throws on an override key the agent does not have', () => {
      const agent = new LlmAgent({name: 'original'});

      expect(() =>
        agent.clone({instrction: 'be brief'} as Partial<LlmAgentConfig>),
      ).toThrow(/Cannot update nonexistent fields in LlmAgent: instrction/);
    });

    it('lists every rejected key, sorted', () => {
      const agent = new LlmAgent({name: 'original'});

      expect(() =>
        agent.clone({zebra: 1, alpha: 2} as Partial<LlmAgentConfig>),
      ).toThrow(/nonexistent fields in LlmAgent: alpha, zebra/);
    });

    it('accepts a config field the subclass folds away instead of storing', () => {
      const agent = new LlmAgent({name: 'original'});
      const countCompactors = (a: LlmAgent) =>
        a.requestProcessors.filter(
          (p) => p instanceof ContextCompactorRequestProcessor,
        ).length;
      expect(countCompactors(agent)).toBe(0);

      const clone = agent.clone({
        contextCompactors: [new TruncatingContextCompactor({threshold: 5})],
      });

      expect(countCompactors(clone)).toBe(1);
    });

    it('accepts a field the agent was constructed without', () => {
      const agent = new LlmAgent({name: 'original'});

      const clone = agent.clone({instruction: 'be brief'});

      expect(clone.instruction).toBe('be brief');
    });

    it('accepts several valid keys at once', () => {
      const agent = new LlmAgent({name: 'original'});
      const replacement = new LlmAgent({name: 'replacement'});

      const clone = agent.clone({
        name: 'renamed',
        subAgents: [replacement],
        description: 'a renamed agent',
      });

      expect(clone.name).toBe('renamed');
      expect(clone.subAgents).toEqual([replacement]);
      expect(clone.description).toBe('a renamed agent');
    });

    it('reports the concrete subclass name', () => {
      const agent = new MockAgent({name: 'mock'});

      expect(() =>
        agent.clone({nope: true} as Partial<BaseAgentConfig>),
      ).toThrow(/nonexistent fields in MockAgent: nope/);
    });

    it('accepts a key a subclass declares as unassigned, and the clone reads it', async () => {
      const agent = new LazyConfigAgent({name: 'lazy'});

      const clone = agent.clone({greeting: 'hello there'});
      const events: Event[] = [];
      for await (const event of clone.runAsync(
        new InvocationContext({
          invocationId: 'test',
          agent: clone,
          session: createSession({id: 'test-session', appName: 'test-app'}),
          pluginManager: new PluginManager(),
        }),
      )) {
        events.push(event);
      }

      expect(events[0].content?.parts?.[0].text).toBe('hello there');
    });

    it('still rejects a key a subclass did not declare as unassigned', () => {
      const agent = new LazyConfigAgent({name: 'lazy'});

      expect(() =>
        agent.clone({greetng: 'typo'} as Partial<LazyConfigAgentConfig>),
      ).toThrow(/nonexistent fields in LazyConfigAgent: greetng/);
    });
  });

  describe('duplicate sub-agent names', () => {
    it('warns once for a duplicated name', () => {
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});

      new LlmAgent({
        name: 'root',
        subAgents: [new LlmAgent({name: 'search'}), new LlmAgent({name: 'x'})],
      });
      expect(warn).not.toHaveBeenCalled();

      new LlmAgent({
        name: 'root2',
        subAgents: [
          new LlmAgent({name: 'search'}),
          new LlmAgent({name: 'search'}),
        ],
      });

      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toBe(
        'Found duplicate sub-agent names: `search`. ' +
          'All sub-agents must have unique names.',
      );
      warn.mockRestore();
    });

    it('lists two duplicated names, sorted, each once', () => {
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});

      new LlmAgent({
        name: 'root',
        subAgents: [
          new LlmAgent({name: 'zebra'}),
          new LlmAgent({name: 'alpha'}),
          new LlmAgent({name: 'zebra'}),
          new LlmAgent({name: 'alpha'}),
        ],
      });

      expect(warn.mock.calls[0][0]).toBe(
        'Found duplicate sub-agent names: `alpha`, `zebra`. ' +
          'All sub-agents must have unique names.',
      );
      warn.mockRestore();
    });

    it('names a triple duplicate exactly once', () => {
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});

      new LlmAgent({
        name: 'root',
        subAgents: [
          new LlmAgent({name: 'search'}),
          new LlmAgent({name: 'search'}),
          new LlmAgent({name: 'search'}),
        ],
      });

      const message = String(warn.mock.calls[0][0]);
      expect(message.match(/`search`/g)).toHaveLength(1);
      warn.mockRestore();
    });

    it('logs nothing for unique names or an empty list', () => {
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});

      const root = new LlmAgent({
        name: 'root',
        subAgents: [new LlmAgent({name: 'a'}), new LlmAgent({name: 'b'})],
      });
      new LlmAgent({name: 'leaf'});

      expect(warn).not.toHaveBeenCalled();
      expect(root.subAgents).toHaveLength(2);
      warn.mockRestore();
    });

    it('still builds the tree, and findSubAgent returns the first match', () => {
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      const first = new LlmAgent({name: 'search'});

      const root = new LlmAgent({
        name: 'root',
        subAgents: [first, new LlmAgent({name: 'search'})],
      });

      expect(root.findSubAgent('search')).toBe(first);
      warn.mockRestore();
    });
  });

  describe('clone callback rebinding', () => {
    class AnnouncingAgent extends MockAgent {
      constructor(config: BaseAgentConfig) {
        super({
          beforeAgentCallback: AnnouncingAgent.prototype.announce,
          ...config,
        });
      }

      announce(): Content {
        return said(`announced by ${this.name}`);
      }
    }

    it("rebinds a callback that is one of the agent's own methods", async () => {
      const original = new AnnouncingAgent({name: 'original'});

      const clone = original.clone({name: 'copy'});
      const events = await run(clone);

      expect(events[0].content).toEqual(said('announced by copy'));
    });

    it('rebinds a callback given in a list', async () => {
      const original = new AnnouncingAgent({
        name: 'original',
        beforeAgentCallback: [AnnouncingAgent.prototype.announce],
      });

      const clone = original.clone({name: 'copy'});
      const events = await run(clone);

      expect(events[0].content).toEqual(said('announced by copy'));
    });

    it('rebinds to the newest copy when a clone is cloned', async () => {
      const original = new AnnouncingAgent({name: 'original'});

      const events = await run(
        original.clone({name: 'first'}).clone({
          name: 'second',
        }),
      );

      expect(events[0].content).toEqual(said('announced by second'));
    });

    it('leaves the original agent untouched', () => {
      const original = new AnnouncingAgent({name: 'original'});

      original.clone({name: 'copy'});

      expect(original.beforeAgentCallback[0]).toBe(
        AnnouncingAgent.prototype.announce,
      );
    });

    it('leaves a callback bound to another object alone', async () => {
      const recorder = {
        label: 'recorder',
        mark(): Content {
          return said(this.label);
        },
      };
      const original = new MockAgent({
        name: 'original',
        beforeAgentCallback: recorder.mark.bind(recorder),
      });

      const events = await run(original.clone({name: 'copy'}));

      expect(events[0].content).toEqual(said('recorder'));
    });

    it('leaves a closure over the original agent alone', async () => {
      const original = new MockAgent({
        name: 'original',
        beforeAgentCallback: () => said(`closed over ${original.name}`),
      });

      const events = await run(original.clone({name: 'copy'}));

      expect(events[0].content).toEqual(said('closed over original'));
    });

    it('does not rebind a callback the caller overrode', async () => {
      const original = new AnnouncingAgent({name: 'original'});

      const events = await run(
        original.clone({
          name: 'copy',
          beforeAgentCallback: () => said('from the override'),
        }),
      );

      expect(events[0].content).toEqual(said('from the override'));
    });
  });

  describe('fromConfig', () => {
    it('builds an instance of the concrete subclass', () => {
      const agent = MockAgent.fromConfig({
        name: 'built',
        description: 'from a config',
      });

      expect(agent).toBeInstanceOf(MockAgent);
      expect(agent.name).toBe('built');
      expect(agent.description).toBe('from a config');
    });

    it('defaults a missing description to the empty string', () => {
      expect(MockAgent.fromConfig({name: 'built'}).description).toBe('');
    });

    it('does not pass agentClass to the constructor', () => {
      const agent = RecordingAgent.fromConfig({
        name: 'built',
        agentClass: 'RecordingAgent',
      });

      expect(agent.receivedConfig).not.toHaveProperty('agentClass');
    });

    it('rejects a config that is not an object', () => {
      expect(() => MockAgent.fromConfig(null)).toThrow(
        'Invalid config type: expected object, got null',
      );
      expect(() => MockAgent.fromConfig('x')).toThrow(
        'Invalid config type: expected object, got string',
      );
      expect(() => MockAgent.fromConfig([])).toThrow(
        'Invalid config type: expected object, got array',
      );
    });

    it('names the class and the field when the config is invalid', () => {
      expect(() => MockAgent.fromConfig({description: 'no name'})).toThrow(
        /Invalid MockAgent config: name:/,
      );
    });

    it('passes an extra key through to the constructor', () => {
      const agent = RecordingAgent.fromConfig({name: 'built', locale: 'en-GB'});

      expect(agent.receivedConfig).toHaveProperty('locale', 'en-GB');
    });

    it('builds a subclass whose schema declares its own field', () => {
      const agent = ToneAgent.fromConfig({name: 'built', tone: 'dry'});

      expect(agent.tone).toBe('dry');
    });

    it('enforces a schema the subclass declares', () => {
      expect(() => ToneAgent.fromConfig({name: 'built'})).toThrow(
        /Invalid ToneAgent config: tone:/,
      );
    });

    it('labels a schema failure that names no field', () => {
      expect(() => EitherAgent.fromConfig({name: 'built'})).toThrow(
        'Invalid EitherAgent config: (root): either tone or style is required',
      );
    });

    it('uses the kwargs a subclass parseConfig returns', () => {
      const agent = DescribedAgent.fromConfig(
        {name: 'built'},
        '/tmp/agent.yml',
      );

      expect(agent.description).toBe('described by /tmp/agent.yml');
    });

    it('accepts constructed sub-agents and callbacks', () => {
      const subAgent = new MockAgent({name: 'child'});
      const callback = () => said('from the config callback');

      const agent = MockAgent.fromConfig({
        name: 'built',
        subAgents: [subAgent],
        beforeAgentCallbacks: [callback],
        afterAgentCallbacks: callback,
      });

      expect(agent.subAgents).toEqual([subAgent]);
      expect(agent.beforeAgentCallback).toEqual([callback]);
      expect(agent.afterAgentCallback).toEqual([callback]);
    });

    it('rejects an unresolved sub-agent reference', () => {
      expect(() =>
        MockAgent.fromConfig({
          name: 'built',
          subAgents: [{configPath: './child.yml'}],
        }),
      ).toThrow(
        /Cannot build MockAgent from config: `subAgents` holds an unresolved reference/,
      );
    });

    it('rejects an unresolved callback reference', () => {
      expect(() =>
        MockAgent.fromConfig({
          name: 'built',
          beforeAgentCallbacks: [{name: 'my_library.before_agent'}],
        }),
      ).toThrow(
        /Cannot build MockAgent from config: `beforeAgentCallbacks` holds an unresolved reference/,
      );
    });

    it('rejects a sub-agents value that is not a list', () => {
      expect(() =>
        MockAgent.fromConfig({name: 'built', subAgents: 'child.yml'}),
      ).toThrow(/`subAgents` holds an unresolved reference/);
    });

    it('returns the kwargs unchanged by default', () => {
      const kwargs = {name: 'built'};

      expect(BaseAgent.parseConfig({}, undefined, kwargs)).toBe(kwargs);
    });
  });
});
