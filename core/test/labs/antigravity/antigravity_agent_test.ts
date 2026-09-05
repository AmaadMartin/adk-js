/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tests for the ADK agent wrapping an Antigravity agent.
 *
 * Ported from adk-python
 * `tests/unittests/labs/antigravity/test_antigravity_agent.py` at `a119dd77`.
 * The `it(...)` names are the reference test names, verbatim; tests with no
 * reference counterpart carry plain descriptive names.
 */

import {
  AntigravityAgent,
  AntigravityAgentConfig,
  AntigravityHook,
  AntigravityStep,
  AntigravityTool,
  AntigravityToolResult,
  BaseAgent,
  createEvent,
  createSession,
  Event,
  InvocationContext,
  LocalAntigravityAgentConfig,
  PluginManager,
  SdkAgent,
  SdkConversation,
  StreamingMode,
} from '@google/adk';
import {logger} from '@google/adk/utils/logger.js';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {driveNode} from '../../workflow/test_helpers.js';

const CID = 'a'.repeat(36);
const OTHER_CID = 'b'.repeat(36);
const STATE_KEY = '_antigravity_conversation_id_agy';

/** A minimal local Antigravity configuration for the wrapped agent. */
function makeConfig(
  overrides: Partial<AntigravityAgentConfig> = {},
): AntigravityAgentConfig {
  return {connection: 'local', ...overrides};
}

/** A tool already on the caller's configuration. */
const userTool: AntigravityTool = {
  name: 'user_tool',
  description: 'Answers a query.',
  run: async (request: string) => request,
};

/** A runnable ADK child agent. */
class StubChild extends BaseAgent {
  protected async *runAsyncImpl(
    ctx: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    yield createEvent({invocationId: ctx.invocationId, author: this.name});
  }

  protected async *runLiveImpl(): AsyncGenerator<Event, void, void> {
    // Never driven: these agents exist for the text path only.
  }
}

/** An ADK parent, which `BaseAgent` cannot be directly because it is abstract. */
class StubParent extends StubChild {}

/** A stand-in for the Antigravity conversation one turn drives. */
class FakeConversation implements SdkConversation {
  sendCount = 0;
  lastPrompt?: string;
  sendError?: unknown;

  constructor(
    readonly history: AntigravityStep[],
    private readonly steps: () => AsyncIterable<AntigravityStep>,
  ) {}

  async send(prompt: string): Promise<void> {
    this.sendCount++;
    this.lastPrompt = prompt;
    if (this.sendError) {
      throw this.sendError;
    }
  }

  receiveSteps(): AsyncIterable<AntigravityStep> {
    return this.steps();
  }
}

/** A stand-in for the Antigravity agent `runAsyncImpl` connects to. */
class FakeSdkAgent implements SdkAgent {
  conversationId?: string;
  closeCount = 0;
  readonly closeErrors: unknown[] = [];
  readonly conversation: FakeConversation;
  connectError?: unknown;

  constructor(
    steps: () => AsyncIterable<AntigravityStep> = stepsOnce,
    conversationId?: string,
    history: AntigravityStep[] = [],
  ) {
    this.conversation = new FakeConversation(history, steps);
    this.conversationId = conversationId;
  }

  async connect(): Promise<SdkAgent> {
    if (this.connectError) {
      throw this.connectError;
    }
    return this;
  }

  async close(error?: unknown): Promise<void> {
    this.closeCount++;
    this.closeErrors.push(error);
  }
}

/** A completed model text step. */
function textStep(stepIndex: number, text: string): AntigravityStep {
  return {
    stepIndex,
    source: 'MODEL',
    type: 'TEXT_RESPONSE',
    status: 'DONE',
    isCompleteResponse: true,
    content: text,
    toolCalls: [],
  };
}

/** The single step of a minimal, complete trajectory. */
async function* stepsOnce(): AsyncGenerator<AntigravityStep> {
  yield textStep(0, 'done');
}

/** A trajectory that produces no steps at all. */
async function* noSteps(): AsyncGenerator<AntigravityStep> {
  // Nothing to yield; the harness went idle without producing a step.
}

/** A factory recording the configuration each turn was built with. */
function capturingFactory(agent: FakeSdkAgent): {
  factory: (config: AntigravityAgentConfig) => SdkAgent;
  configs: AntigravityAgentConfig[];
} {
  const configs: AntigravityAgentConfig[] = [];
  return {
    factory: (config: AntigravityAgentConfig) => {
      configs.push(config);
      return agent;
    },
    configs,
  };
}

/** An invocation context standing in for one ADK turn. */
function runCtx(
  state: Record<string, unknown> = {},
  userText?: string,
): InvocationContext {
  return new InvocationContext({
    invocationId: 'inv_1',
    branch: 'main',
    session: createSession({
      id: 'sess_456',
      appName: 'test_app',
      userId: 'test_user',
      state,
    }),
    userContent:
      userText === undefined
        ? undefined
        : {role: 'user', parts: [{text: userText}]},
    pluginManager: new PluginManager(),
  });
}

/** The state deltas these events carry, in order. */
function deltas(events: Event[]): Array<Record<string, unknown>> {
  return events
    .map((event) => event.actions.stateDelta)
    .filter((delta) => Object.keys(delta).length > 0);
}

/** Collects events until the run raises, returning both. */
async function drain(
  agent: AntigravityAgent,
  ctx: InvocationContext,
): Promise<{events: Event[]; error: unknown}> {
  const events: Event[] = [];
  try {
    for await (const event of agent.runAsync(ctx)) {
      events.push(event);
    }
  } catch (error: unknown) {
    return {events, error};
  }
  return {events, error: undefined};
}

/** Runs one turn to completion, discarding the events. */
async function runOnce(
  agent: AntigravityAgent,
  ctx: InvocationContext,
): Promise<Event[]> {
  const events: Event[] = [];
  for await (const event of agent.runAsync(ctx)) {
    events.push(event);
  }
  return events;
}

/** The model text of each event that carries some. */
function texts(events: Event[]): string[] {
  return events
    .filter((event) => event.content)
    .map((event) => event.content?.parts?.[0].text ?? '');
}

/** Returns [name, id, response] for each function-response part emitted. */
function responses(
  events: Event[],
): Array<[string | undefined, string | undefined, unknown]> {
  const found: Array<[string | undefined, string | undefined, unknown]> = [];
  for (const event of events) {
    for (const part of event.content?.parts ?? []) {
      if (part.functionResponse) {
        found.push([
          part.functionResponse.name,
          part.functionResponse.id,
          part.functionResponse.response,
        ]);
      }
    }
  }
  return found;
}

/** The ids of the function calls these events emitted. */
function callIds(events: Event[]): Array<string | undefined> {
  const found: Array<string | undefined> = [];
  for (const event of events) {
    for (const part of event.content?.parts ?? []) {
      if (part.functionCall) {
        found.push(part.functionCall.id);
      }
    }
  }
  return found;
}

describe('AntigravityAgent construction', () => {
  it('test_standalone_agent_is_allowed', () => {
    const agent = new AntigravityAgent({
      name: 'agy',
      antigravityConfig: makeConfig(),
      agentFactory: () => new FakeSdkAgent(),
    });

    expect(agent.parentAgent).toBeUndefined();
    expect(agent.subAgents).toEqual([]);
  });

  it('test_sub_agents_are_allowed', () => {
    const child = new StubChild({
      name: 'reviewer',
      description: 'Reviews a diff.',
    });

    const agent = new AntigravityAgent({
      name: 'coder',
      antigravityConfig: makeConfig(),
      agentFactory: () => new FakeSdkAgent(),
      subAgents: [child],
    });

    expect(agent.subAgents).toEqual([child]);
  });

  it('test_a_sub_agent_without_a_description_is_rejected', () => {
    const child = new StubChild({name: 'reviewer'});

    expect(
      () =>
        new AntigravityAgent({
          name: 'coder',
          antigravityConfig: makeConfig(),
          agentFactory: () => new FakeSdkAgent(),
          subAgents: [child],
        }),
    ).toThrow(/description/);
  });

  it('test_two_sub_agents_with_the_same_name_are_rejected', () => {
    // The harness's own "already registered" error names no ADK agent.
    const first = new StubChild({
      name: 'reviewer',
      description: 'Reviews a diff.',
    });
    const second = new StubChild({
      name: 'reviewer',
      description: 'Reviews a design.',
    });

    expect(
      () =>
        new AntigravityAgent({
          name: 'coder',
          antigravityConfig: makeConfig(),
          agentFactory: () => new FakeSdkAgent(),
          subAgents: [first, second],
        }),
    ).toThrow(/share the name/);
  });

  it('test_a_sub_agent_named_like_a_config_tool_is_rejected', () => {
    // The child joins the same `tools` as `userTool`, so the two would collide
    // in the harness's one-tool-per-name namespace.
    const child = new StubChild({
      name: 'user_tool',
      description: 'Shadows a tool.',
    });

    expect(
      () =>
        new AntigravityAgent({
          name: 'coder',
          antigravityConfig: makeConfig({tools: [userTool]}),
          agentFactory: () => new FakeSdkAgent(),
          subAgents: [child],
        }),
    ).toThrow(/collides with a tool/);
  });

  it('rejects a sub-agent named like a builtin already enabled by name', () => {
    const child = new StubChild({
      name: 'run_command',
      description: 'Shadows a builtin.',
    });

    expect(
      () =>
        new AntigravityAgent({
          name: 'coder',
          antigravityConfig: makeConfig({tools: ['run_command']}),
          agentFactory: () => new FakeSdkAgent(),
          subAgents: [child],
        }),
    ).toThrow(/collides with a tool/);
  });

  it('test_using_as_sub_agent_is_rejected', () => {
    const agy = new AntigravityAgent({
      name: 'agy',
      antigravityConfig: makeConfig(),
      agentFactory: () => new FakeSdkAgent(),
    });

    expect(() => new StubParent({name: 'parent', subAgents: [agy]})).toThrow(
      /may only be an ADK sub-agent/,
    );
  });

  it('test_single_turn_agent_can_be_a_sub_agent', () => {
    const agy = new AntigravityAgent({
      name: 'agy',
      antigravityConfig: makeConfig(),
      agentFactory: () => new FakeSdkAgent(),
      mode: 'single_turn',
    });

    const parent = new StubParent({name: 'parent', subAgents: [agy]});

    expect(agy.parentAgent).toBe(parent);
  });

  it('test_mode_cannot_be_reassigned_after_construction', () => {
    // `mode` is read once, by the adoption guard, so it has no setter.
    const agy = new AntigravityAgent({
      name: 'agy',
      antigravityConfig: makeConfig(),
      agentFactory: () => new FakeSdkAgent(),
      mode: 'single_turn',
    });
    const parent = new StubParent({name: 'parent', subAgents: [agy]});

    // `mode` has no setter, so a write is refused. Reflect.set reports the
    // refusal that a plain assignment turns into a TypeError under strict mode,
    // which every ES module runs in.
    expect(Reflect.set(agy, 'mode', undefined)).toBe(false);
    expect(agy.mode).toBe('single_turn');
    expect(agy.parentAgent).toBe(parent);
  });

  it('leaves the guard in place after a single-turn agent is adopted', () => {
    const agy = new AntigravityAgent({
      name: 'agy',
      antigravityConfig: makeConfig(),
      agentFactory: () => new FakeSdkAgent(),
      mode: 'single_turn',
    });
    const parent = new StubParent({name: 'parent', subAgents: [agy]});

    expect(agy.parentAgent).toBe(parent);
    expect(() => new StubParent({name: 'other', subAgents: [agy]})).toThrow(
      /already has a parent agent/,
    );
  });
});

describe('AntigravityAgent save_dir warning', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    return () => {
      warn.mockRestore();
    };
  });

  /** The text of every warning logged so far. */
  function warnings(): string {
    return warn.mock.calls.map((call) => String(call[0])).join('\n');
  }

  it('test_a_local_config_without_save_dir_warns', () => {
    // The one case that loses history with no error and no log of its own.
    new AntigravityAgent({
      name: 'agy',
      antigravityConfig: makeConfig(),
      agentFactory: () => new FakeSdkAgent(),
    });

    expect(warnings()).toContain('saveDir');
  });

  it('test_a_local_config_with_save_dir_is_silent', () => {
    new AntigravityAgent({
      name: 'agy',
      antigravityConfig: makeConfig({saveDir: '/var/lib/app/antigravity'}),
      agentFactory: () => new FakeSdkAgent(),
    });

    expect(warnings()).not.toContain('saveDir');
  });

  it('test_single_turn_without_save_dir_is_silent', () => {
    new AntigravityAgent({
      name: 'agy',
      antigravityConfig: makeConfig(),
      agentFactory: () => new FakeSdkAgent(),
      mode: 'single_turn',
    });

    expect(warnings()).not.toContain('saveDir');
  });

  it('test_a_non_local_config_is_silent', () => {
    new AntigravityAgent({
      name: 'agy',
      antigravityConfig: {connection: 'remote'},
      agentFactory: () => new FakeSdkAgent(),
    });

    expect(warnings()).not.toContain('saveDir');
  });

  it("warns for an adapter's own local config, not just a bare one", () => {
    // The warning follows the discriminator, so every local configuration gets
    // it — not only one shaped exactly like the bare interface.
    interface OpenAiLocalConfig extends LocalAntigravityAgentConfig {
      model: string;
    }
    const config: OpenAiLocalConfig = {connection: 'local', model: 'llama3'};

    new AntigravityAgent({
      name: 'agy',
      antigravityConfig: config,
      agentFactory: () => new FakeSdkAgent(),
    });

    expect(warnings()).toContain('saveDir');
  });
});

describe('AntigravityAgent turn lifecycle', () => {
  it('test_subclass_overrides_the_sdk_agent_class', async () => {
    // The factory is the seam: no module global is ever reached for.
    const built = new FakeSdkAgent(stepsOnce);
    const agent = new AntigravityAgent({
      name: 'agy',
      antigravityConfig: makeConfig(),
      agentFactory: () => built,
      mode: 'single_turn',
    });

    const events = await runOnce(agent, runCtx());

    expect(texts(events)).toEqual(['done']);
  });

  it('test_each_turn_of_one_session_builds_a_new_sdk_agent', async () => {
    const built: FakeSdkAgent[] = [];
    const agent = new AntigravityAgent({
      name: 'agy',
      antigravityConfig: makeConfig(),
      agentFactory: () => {
        const sdkAgent = new FakeSdkAgent(stepsOnce);
        built.push(sdkAgent);
        return sdkAgent;
      },
    });
    const ctx = runCtx();

    await runOnce(agent, ctx);
    await runOnce(agent, ctx);

    expect(built).toHaveLength(2);
    expect(built.map((a) => a.conversation.sendCount)).toEqual([1, 1]);
    expect(built.map((a) => a.closeCount)).toEqual([1, 1]);
  });

  it('test_single_turn_builds_a_new_sdk_agent_per_call', async () => {
    const built: FakeSdkAgent[] = [];
    const agent = new AntigravityAgent({
      name: 'agy',
      antigravityConfig: makeConfig(),
      agentFactory: () => {
        const sdkAgent = new FakeSdkAgent(stepsOnce);
        built.push(sdkAgent);
        return sdkAgent;
      },
      mode: 'single_turn',
    });
    const ctx = runCtx();

    await runOnce(agent, ctx);
    await runOnce(agent, ctx);

    expect(built).toHaveLength(2);
    expect(built.map((a) => a.conversation.sendCount)).toEqual([1, 1]);
    expect(built.map((a) => a.closeCount)).toEqual([1, 1]);
  });

  it('test_save_dir_is_no_longer_required', async () => {
    const config = makeConfig();
    expect(config.saveDir).toBeUndefined();
    const agent = new AntigravityAgent({
      name: 'agy',
      antigravityConfig: config,
      agentFactory: () => new FakeSdkAgent(stepsOnce),
    });

    expect(texts(await runOnce(agent, runCtx()))).toEqual(['done']);
  });

  it('test_normal_completion_inside_an_outer_except_reports_no_error', async () => {
    // A turn that completes normally closes the Antigravity agent with no
    // error, even while an unrelated failure is being handled higher up.
    const sdkAgent = new FakeSdkAgent(stepsOnce, CID);
    const agent = new AntigravityAgent({
      name: 'agy',
      antigravityConfig: makeConfig(),
      agentFactory: () => sdkAgent,
    });

    try {
      throw new Error('unrelated');
    } catch {
      await runOnce(agent, runCtx());
    }

    expect(sdkAgent.closeCount).toBe(1);
    expect(sdkAgent.closeErrors).toEqual([undefined]);
  });

  it('test_abandoning_the_generator_mid_stream_does_not_error', async () => {
    // A consumer that leaves mid-turn lands on the cleanup path, never on the
    // one that yields, so nothing tries to answer it.
    const sdkAgent = new FakeSdkAgent(stepsOnce, CID, [textStep(0, 'earlier')]);
    const agent = new AntigravityAgent({
      name: 'agy',
      antigravityConfig: makeConfig(),
      agentFactory: () => sdkAgent,
    });

    const seen: Event[] = [];
    for await (const event of agent.runAsync(runCtx({[STATE_KEY]: CID}))) {
      seen.push(event);
      break;
    }

    expect(seen).toHaveLength(1);
    expect(sdkAgent.closeCount).toBe(1);
  });

  it('sends the first text part of the user message as the prompt', async () => {
    const sdkAgent = new FakeSdkAgent(stepsOnce);
    const agent = new AntigravityAgent({
      name: 'agy',
      antigravityConfig: makeConfig(),
      agentFactory: () => sdkAgent,
    });

    await runOnce(agent, runCtx({}, 'fix the flake'));

    expect(sdkAgent.conversation.lastPrompt).toBe('fix the flake');
  });

  it('sends an empty prompt when the turn carries no user text', async () => {
    const sdkAgent = new FakeSdkAgent(stepsOnce);
    const agent = new AntigravityAgent({
      name: 'agy',
      antigravityConfig: makeConfig(),
      agentFactory: () => sdkAgent,
    });

    await runOnce(agent, runCtx());

    expect(sdkAgent.conversation.lastPrompt).toBe('');
  });

  it('streams partial deltas only when the run config asks for SSE', async () => {
    async function* deltaSteps(): AsyncGenerator<AntigravityStep> {
      yield {
        stepIndex: 0,
        source: 'MODEL',
        type: 'TEXT_RESPONSE',
        thinkingDelta: 'thinking...',
        contentDelta: 'done',
      };
      yield textStep(1, 'done');
    }
    const agent = new AntigravityAgent({
      name: 'agy',
      antigravityConfig: makeConfig(),
      agentFactory: () => new FakeSdkAgent(deltaSteps),
      mode: 'single_turn',
    });

    const ctx = runCtx();
    ctx.runConfig = {streamingMode: StreamingMode.SSE};
    const streamed = await runOnce(agent, ctx);
    const plain = await runOnce(agent, runCtx());

    expect(streamed.map((e) => e.partial ?? false)).toEqual([
      true,
      true,
      false,
    ]);
    expect(plain.map((e) => e.partial ?? false)).toEqual([false]);
  });

  it('refuses a live run', async () => {
    const agent = new AntigravityAgent({
      name: 'agy',
      antigravityConfig: makeConfig(),
      agentFactory: () => new FakeSdkAgent(),
    });

    const run = async () => {
      for await (const _event of agent.runLive(runCtx())) {
        // The first pull is what raises.
      }
    };

    await expect(run()).rejects.toThrow(/does not support live/);
  });
});

describe('AntigravityAgent conversation id', () => {
  it('test_turn_one_records_the_runtime_assigned_id', async () => {
    const agent = new AntigravityAgent({
      name: 'agy',
      antigravityConfig: makeConfig(),
      agentFactory: () => new FakeSdkAgent(stepsOnce, CID),
    });

    const events = await runOnce(agent, runCtx());

    expect(deltas(events)).toEqual([{[STATE_KEY]: CID}]);
  });

  it('test_turn_two_passes_the_stored_id_back', async () => {
    // And asks for create_or_resume, the only mode that survives a lost store.
    const sdkAgent = new FakeSdkAgent(stepsOnce, CID, [textStep(0, 'earlier')]);
    const {factory, configs} = capturingFactory(sdkAgent);
    const agent = new AntigravityAgent({
      name: 'agy',
      antigravityConfig: makeConfig(),
      agentFactory: factory,
    });

    await runOnce(agent, runCtx({[STATE_KEY]: CID}));

    expect(configs[0].conversationId).toBe(CID);
    expect(configs[0].sessionContinuationMode).toBe('create_or_resume');
  });

  it('test_an_unchanged_id_is_not_rewritten', async () => {
    const sdkAgent = new FakeSdkAgent(stepsOnce, CID, [textStep(0, 'earlier')]);
    const agent = new AntigravityAgent({
      name: 'agy',
      antigravityConfig: makeConfig(),
      agentFactory: () => sdkAgent,
    });

    const events = await runOnce(agent, runCtx({[STATE_KEY]: CID}));

    expect(deltas(events)).toEqual([]);
  });

  it('test_a_turn_with_no_steps_records_nothing', async () => {
    // Its history is legitimately empty, so recording the id would make the
    // next turn's resume check report a spurious silent drop.
    const agent = new AntigravityAgent({
      name: 'agy',
      antigravityConfig: makeConfig(),
      agentFactory: () => new FakeSdkAgent(noSteps, CID),
    });

    const events = await runOnce(agent, runCtx());

    expect(deltas(events)).toEqual([]);
  });

  it('test_a_content_less_turn_with_history_still_records_the_id', async () => {
    // A compaction turn's steps carry no user-visible content, so the turn
    // yields zero ADK events, yet the conversation has history and an id and
    // must still be recorded — otherwise the next turn starts fresh and
    // orphans this conversation.
    const agent = new AntigravityAgent({
      name: 'agy',
      antigravityConfig: makeConfig(),
      agentFactory: () =>
        new FakeSdkAgent(noSteps, CID, [textStep(0, 'earlier')]),
    });

    const events = await runOnce(agent, runCtx());

    expect(deltas(events)).toEqual([{[STATE_KEY]: CID}]);
  });

  it('test_a_content_less_turn_without_history_records_nothing', async () => {
    // The other side of the guard: zero events AND no history is a genuinely
    // empty turn, so recording the id would make the next resume look dropped.
    const agent = new AntigravityAgent({
      name: 'agy',
      antigravityConfig: makeConfig(),
      agentFactory: () => new FakeSdkAgent(noSteps, CID),
    });

    const events = await runOnce(agent, runCtx());

    expect(deltas(events)).toEqual([]);
  });

  it('test_an_id_published_after_the_first_step_is_still_recorded', async () => {
    // The runtime records a trajectory id only once it is non-empty, so a
    // first step can leave `conversationId` blank.
    const sdkAgent = new FakeSdkAgent(lateIdSteps, '');
    async function* lateIdSteps(): AsyncGenerator<AntigravityStep> {
      yield textStep(0, 'thinking');
      sdkAgent.conversationId = CID;
      yield textStep(1, 'done');
    }
    const agent = new AntigravityAgent({
      name: 'agy',
      antigravityConfig: makeConfig(),
      agentFactory: () => sdkAgent,
    });

    const events = await runOnce(agent, runCtx());

    expect(deltas(events)).toEqual([{[STATE_KEY]: CID}]);
  });

  it('records a changed id once when the turn also has history', async () => {
    // A resumed conversation the runtime re-identified: an event records the
    // new id, and the end-of-turn check must not record it a second time.
    const agent = new AntigravityAgent({
      name: 'agy',
      antigravityConfig: makeConfig(),
      agentFactory: () =>
        new FakeSdkAgent(stepsOnce, OTHER_CID, [textStep(0, 'earlier')]),
    });

    const events = await runOnce(agent, runCtx({[STATE_KEY]: CID}));

    expect(deltas(events)).toEqual([{[STATE_KEY]: OTHER_CID}]);
  });

  it('test_single_turn_neither_reads_nor_writes_the_id', async () => {
    const {factory, configs} = capturingFactory(
      new FakeSdkAgent(stepsOnce, CID),
    );
    const agent = new AntigravityAgent({
      name: 'agy',
      antigravityConfig: makeConfig(),
      agentFactory: factory,
      mode: 'single_turn',
    });

    const events = await runOnce(agent, runCtx({[STATE_KEY]: OTHER_CID}));

    expect(configs[0].conversationId).toBeUndefined();
    expect(deltas(events)).toEqual([]);
  });

  it('test_two_agents_in_one_session_use_separate_keys', async () => {
    // Otherwise the second agent resumes the first agent's conversation.
    const ctx = runCtx();
    const keys: string[] = [];

    for (const [name, cid] of [
      ['first', CID],
      ['second', OTHER_CID],
    ]) {
      const agent = new AntigravityAgent({
        name,
        antigravityConfig: makeConfig(),
        agentFactory: () => new FakeSdkAgent(stepsOnce, cid),
      });
      for (const delta of deltas(await runOnce(agent, ctx))) {
        keys.push(...Object.keys(delta));
      }
    }

    expect(keys).toEqual([
      '_antigravity_conversation_id_first',
      '_antigravity_conversation_id_second',
    ]);
  });
});

describe('AntigravityAgent failure paths', () => {
  it('test_connect_failure_after_resume_reraises_and_keeps_the_id', async () => {
    // create_or_resume recreates the conversation next turn, so a transient
    // connect error must not orphan one that is probably still alive.
    const failure = new Error('conversation not found');
    const sdkAgent = new FakeSdkAgent(stepsOnce, CID);
    sdkAgent.connectError = failure;
    const agent = new AntigravityAgent({
      name: 'agy',
      antigravityConfig: makeConfig(),
      agentFactory: () => sdkAgent,
    });

    const {events, error} = await drain(agent, runCtx({[STATE_KEY]: CID}));

    // The very object reaches the caller, unwrapped.
    expect(error).toBe(failure);
    expect(deltas(events)).toEqual([]);
    expect(events).toEqual([]);
  });

  it('test_cancelling_a_connect_keeps_the_stored_id', async () => {
    // A cancelled connect says the caller left, not that the conversation did.
    const sdkAgent = new FakeSdkAgent(stepsOnce, CID);
    sdkAgent.connectError = new DOMException('aborted', 'AbortError');
    const agent = new AntigravityAgent({
      name: 'agy',
      antigravityConfig: makeConfig(),
      agentFactory: () => sdkAgent,
    });

    const {events, error} = await drain(agent, runCtx({[STATE_KEY]: CID}));

    expect((error as DOMException).name).toBe('AbortError');
    expect(deltas(events)).toEqual([]);
  });

  it('test_a_cancelled_connect_still_closes_the_sdk_agent', async () => {
    const sdkAgent = new FakeSdkAgent(stepsOnce, CID);
    sdkAgent.connectError = new DOMException('aborted', 'AbortError');
    const agent = new AntigravityAgent({
      name: 'agy',
      antigravityConfig: makeConfig(),
      agentFactory: () => sdkAgent,
    });

    await drain(agent, runCtx());

    expect(sdkAgent.closeCount).toBe(1);
    expect((sdkAgent.closeErrors[0] as DOMException).name).toBe('AbortError');
  });

  it('test_connect_failure_without_a_stored_id_is_untouched', async () => {
    const sdkAgent = new FakeSdkAgent(stepsOnce, CID);
    sdkAgent.connectError = new Error('boom');
    const agent = new AntigravityAgent({
      name: 'agy',
      antigravityConfig: makeConfig(),
      agentFactory: () => sdkAgent,
    });

    const {events, error} = await drain(agent, runCtx());

    expect(error).toBeInstanceOf(Error);
    expect(deltas(events)).toEqual([]);
  });

  it('test_resume_index_survives_a_harness_error_mid_turn', async () => {
    // The harness dies mid-turn, once a conversation with history and an id
    // exists but before any event recorded it. The block after the loop is
    // skipped on the error path, so the id would be lost without this.
    const failure = new Error('harness died');
    const sdkAgent = new FakeSdkAgent(stepsOnce, CID, [textStep(0, 'earlier')]);
    sdkAgent.conversation.sendError = failure;
    const agent = new AntigravityAgent({
      name: 'agy',
      antigravityConfig: makeConfig(),
      agentFactory: () => sdkAgent,
    });

    const {events, error} = await drain(agent, runCtx());

    expect(error).toBe(failure);
    expect(deltas(events)).toEqual([{[STATE_KEY]: CID}]);
    // The Antigravity agent is still closed on the error path.
    expect(sdkAgent.closeCount).toBe(1);
    expect(sdkAgent.closeErrors).toEqual([failure]);
  });

  it('records nothing on a mid-turn error when the conversation has no history', async () => {
    const failure = new Error('harness died');
    const sdkAgent = new FakeSdkAgent(stepsOnce, CID);
    sdkAgent.conversation.sendError = failure;
    const agent = new AntigravityAgent({
      name: 'agy',
      antigravityConfig: makeConfig(),
      agentFactory: () => sdkAgent,
    });

    const {events, error} = await drain(agent, runCtx());

    expect(error).toBe(failure);
    expect(deltas(events)).toEqual([]);
  });

  it('test_a_local_resume_with_no_history_fails_the_turn', async () => {
    // Local forgets silently; an empty history is the only signal there is.
    const sdkAgent = new FakeSdkAgent(stepsOnce, CID);
    const agent = new AntigravityAgent({
      name: 'agy',
      antigravityConfig: makeConfig(),
      agentFactory: () => sdkAgent,
    });

    const {events, error} = await drain(agent, runCtx({[STATE_KEY]: CID}));

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/Could not resume conversation/);
    expect(deltas(events)).toEqual([{[STATE_KEY]: undefined}]);
    // The turn is abandoned, not half-run.
    expect(sdkAgent.conversation.sendCount).toBe(0);
    expect(sdkAgent.closeCount).toBe(1);
  });

  it('test_a_local_resume_with_history_proceeds', async () => {
    const agent = new AntigravityAgent({
      name: 'agy',
      antigravityConfig: makeConfig(),
      agentFactory: () =>
        new FakeSdkAgent(stepsOnce, CID, [textStep(0, 'earlier')]),
    });

    const {events, error} = await drain(agent, runCtx({[STATE_KEY]: CID}));

    expect(error).toBeUndefined();
    expect(texts(events)).toEqual(['done']);
  });

  it('test_a_non_local_resume_with_no_history_proceeds', async () => {
    // Only a local connection populates the conversation history; applying the
    // check elsewhere would fail every resumed turn those connections run.
    const agent = new AntigravityAgent({
      name: 'agy',
      antigravityConfig: {connection: 'remote'},
      agentFactory: () => new FakeSdkAgent(stepsOnce, CID),
    });

    const {events, error} = await drain(agent, runCtx({[STATE_KEY]: CID}));

    expect(error).toBeUndefined();
    expect(texts(events)).toEqual(['done']);
  });

  it('test_a_fresh_local_conversation_with_no_history_proceeds', async () => {
    // Checking the history without also checking that a resume was asked for
    // would fail every first turn.
    const agent = new AntigravityAgent({
      name: 'agy',
      antigravityConfig: makeConfig(),
      agentFactory: () => new FakeSdkAgent(stepsOnce, CID),
    });

    const {events, error} = await drain(agent, runCtx());

    expect(error).toBeUndefined();
    expect(deltas(events)).toEqual([{[STATE_KEY]: CID}]);
  });
});

describe('AntigravityAgent config building', () => {
  it('test_no_sub_agents_leaves_the_config_tools_alone', async () => {
    const config = makeConfig({tools: [userTool]});
    const {factory, configs} = capturingFactory(new FakeSdkAgent(stepsOnce));
    const agent = new AntigravityAgent({
      name: 'agy',
      antigravityConfig: config,
      agentFactory: factory,
    });

    await runOnce(agent, runCtx());

    // The tool object itself stays identical; only the array is new.
    expect(configs[0]).not.toBe(config);
    expect(configs[0].tools).not.toBe(config.tools);
    expect(configs[0].tools).toEqual([userTool]);
    expect(config.tools).toEqual([userTool]);
  });

  it('test_sub_agents_reach_the_sdk_config_as_tools', async () => {
    const child = new StubChild({
      name: 'reviewer',
      description: 'Reviews a diff.',
    });
    const {factory, configs} = capturingFactory(new FakeSdkAgent(stepsOnce));
    const agent = new AntigravityAgent({
      name: 'coder',
      antigravityConfig: makeConfig({tools: [userTool]}),
      agentFactory: factory,
      subAgents: [child],
    });

    await runOnce(agent, runCtx());

    // Ordering is deliberate: the caller's own tools keep their positions and
    // identities, children are appended after them.
    expect(toolNames(configs[0])).toEqual(['user_tool', 'reviewer']);
    expect(configs[0].tools?.[0]).toBe(userTool);
    expect(toolAt(configs[0], 1).description).toBe('Reviews a diff.');
  });

  it('test_a_child_appended_after_construction_is_still_checked', async () => {
    // `subAgents` is a plain array, so a push never reaches the constructor;
    // the guard has to run again when the configuration is built.
    const agent = new AntigravityAgent({
      name: 'coder',
      antigravityConfig: makeConfig(),
      agentFactory: () => new FakeSdkAgent(stepsOnce),
    });

    agent.subAgents.push(new StubChild({name: 'reviewer'}));

    await expect(runOnce(agent, runCtx())).rejects.toThrow(/description/);
  });

  it('test_a_duplicate_appended_after_construction_is_still_checked', async () => {
    const first = new StubChild({
      name: 'reviewer',
      description: 'Reviews a diff.',
    });
    const agent = new AntigravityAgent({
      name: 'coder',
      antigravityConfig: makeConfig(),
      agentFactory: () => new FakeSdkAgent(stepsOnce),
      subAgents: [first],
    });

    agent.subAgents.push(
      new StubChild({name: 'reviewer', description: 'Also.'}),
    );

    await expect(runOnce(agent, runCtx())).rejects.toThrow(/share the name/);
  });

  it('test_a_single_turn_agent_bridges_its_children_too', async () => {
    const child = new StubChild({
      name: 'reviewer',
      description: 'Reviews a diff.',
    });
    const configs: AntigravityAgentConfig[] = [];
    const agent = new AntigravityAgent({
      name: 'coder',
      antigravityConfig: makeConfig(),
      agentFactory: (config: AntigravityAgentConfig) => {
        configs.push(config);
        return new FakeSdkAgent(stepsOnce);
      },
      mode: 'single_turn',
      subAgents: [child],
    });
    const ctx = runCtx();

    await runOnce(agent, ctx);
    await runOnce(agent, ctx);

    expect(configs).toHaveLength(2);
    expect(configs.map(toolNames)).toEqual([['reviewer'], ['reviewer']]);
  });

  it('test_no_capture_hook_is_registered_without_sub_agents', async () => {
    // Registering a post-tool-call hook costs a blocking round trip per
    // successful tool call.
    const {factory, configs} = capturingFactory(new FakeSdkAgent(stepsOnce));
    const agent = new AntigravityAgent({
      name: 'agy',
      antigravityConfig: makeConfig(),
      agentFactory: factory,
    });

    await runOnce(agent, runCtx());

    expect(configs[0].hooks).toEqual([]);
  });

  it('test_both_capture_hooks_are_registered_when_there_are_sub_agents', async () => {
    // The harness routes a tool to exactly one of them, a success to
    // post-tool-call and a failure to on-tool-error.
    const child = new StubChild({
      name: 'reviewer',
      description: 'Reviews a diff.',
    });
    const {factory, configs} = capturingFactory(new FakeSdkAgent(stepsOnce));
    const agent = new AntigravityAgent({
      name: 'coder',
      antigravityConfig: makeConfig(),
      agentFactory: factory,
      subAgents: [child],
    });

    await runOnce(agent, runCtx());

    expect(hookKinds(configs[0])).toEqual(['post_tool_call', 'on_tool_error']);
  });

  it('keeps the caller hooks ahead of the two captures', async () => {
    const callerHook: AntigravityHook = {
      kind: 'post_tool_call',
      run: async () => {},
    };
    const child = new StubChild({
      name: 'reviewer',
      description: 'Reviews a diff.',
    });
    const config = makeConfig({hooks: [callerHook]});
    const {factory, configs} = capturingFactory(new FakeSdkAgent(stepsOnce));
    const agent = new AntigravityAgent({
      name: 'coder',
      antigravityConfig: config,
      agentFactory: factory,
      subAgents: [child],
    });

    await runOnce(agent, runCtx());

    expect(configs[0].hooks?.[0]).toBe(callerHook);
    expect(configs[0].hooks).toHaveLength(3);
    expect(config.hooks).toEqual([callerHook]);
  });
});

/** The names of the tools on a built configuration, in order. */
function toolNames(config: AntigravityAgentConfig): string[] {
  return (config.tools ?? []).map((tool) =>
    typeof tool === 'string' ? tool : tool.name,
  );
}

/** The tool at `index` on a built configuration. */
function toolAt(
  config: AntigravityAgentConfig,
  index: number,
): AntigravityTool {
  const tool = (config.tools ?? [])[index];
  if (typeof tool === 'string') {
    return expect.fail(`tool ${index} is a builtin name, not a tool object`);
  }
  return tool;
}

/** The kinds of the hooks on a built configuration, in order. */
function hookKinds(config: AntigravityAgentConfig): string[] {
  return (config.hooks ?? []).map((hook) => hook.kind);
}

/** The ACTIVE step the harness fabricates when it asks us to run a tool. */
function clientToolActiveStep(): AntigravityStep {
  return {
    stepIndex: 1,
    type: 'TOOL_CALL',
    source: 'MODEL',
    status: 'ACTIVE',
    toolCalls: [{name: 'reviewer', args: {request: 'go'}, id: 'call_3'}],
  };
}

/** The terminal step for a client tool, with `toolCalls` blanked. */
function clientToolDoneStep(): AntigravityStep {
  return {
    stepIndex: 1,
    type: 'TOOL_CALL',
    source: 'MODEL',
    status: 'DONE',
    content: 'Calling custom tool "reviewer"',
    toolCalls: [],
  };
}

/** Stands in for the SDK's `ToolExecutionError`. */
class ToolFailure extends Error {
  constructor(
    message: string,
    readonly toolName: string,
    readonly callId?: string,
  ) {
    super(message);
  }
}

/** When the harness delivers the tool outcome, relative to the terminal step. */
type HookArrival = 'before_done' | 'after_stream';

/**
 * A factory replaying one client-tool call, firing the hook itself.
 *
 * Hook dispatch is backgrounded, so the outcome races the terminal step;
 * `hookArrives` replays both orderings.
 */
function clientToolFactory(
  hookArrives: HookArrival,
  outcome: 'success' | 'failure' = 'success',
  built?: AntigravityAgentConfig[],
): (config: AntigravityAgentConfig) => SdkAgent {
  return (config: AntigravityAgentConfig) => {
    built?.push(config);
    const hooks = [...(config.hooks ?? [])];

    async function deliver(): Promise<void> {
      for (const hook of hooks) {
        if (outcome === 'failure' && hook.kind === 'on_tool_error') {
          await hook.run(
            new ToolFailure('child agent exploded', 'reviewer', 'call_3'),
          );
        }
        if (outcome === 'success' && hook.kind === 'post_tool_call') {
          const result: AntigravityToolResult = {
            name: 'reviewer',
            id: 'call_3',
            result: '{"result": "Looks good."}',
          };
          await hook.run(result);
        }
      }
    }

    async function* steps(): AsyncGenerator<AntigravityStep> {
      yield clientToolActiveStep();
      if (hookArrives === 'before_done') {
        await deliver();
      }
      yield clientToolDoneStep();
      if (hookArrives === 'after_stream') {
        await deliver();
      }
    }

    return new FakeSdkAgent(steps);
  };
}

describe('AntigravityAgent client tools', () => {
  const arrivals: HookArrival[] = ['before_done', 'after_stream'];

  it.each(arrivals)(
    'test_a_client_tool_call_is_answered_whichever_order_it_arrives_in [%s]',
    async (hookArrives) => {
      const child = new StubChild({
        name: 'reviewer',
        description: 'Reviews a diff.',
      });
      const agent = new AntigravityAgent({
        name: 'coder',
        antigravityConfig: makeConfig(),
        agentFactory: clientToolFactory(hookArrives),
        subAgents: [child],
      });

      const events = await runOnce(agent, runCtx());

      expect(callIds(events)).toEqual(['call_3']);
      expect(responses(events)).toEqual([
        ['reviewer', 'call_3', {result: 'Looks good.'}],
      ]);
    },
  );

  it.each(arrivals)(
    'test_a_failed_client_tool_is_answered_with_an_error_response [%s]',
    async (hookArrives) => {
      const child = new StubChild({
        name: 'reviewer',
        description: 'Reviews a diff.',
      });
      const agent = new AntigravityAgent({
        name: 'coder',
        antigravityConfig: makeConfig(),
        agentFactory: clientToolFactory(hookArrives, 'failure'),
        subAgents: [child],
      });

      const events = await runOnce(agent, runCtx());

      expect(responses(events)).toEqual([
        ['reviewer', 'call_3', {error: 'child agent exploded'}],
      ]);
    },
  );

  it.each(arrivals)(
    'test_a_single_turn_agent_answers_its_client_tool_calls_too [%s]',
    async (hookArrives) => {
      // single_turn bypasses the session-keyed path, reaching the capture by a
      // different route.
      const child = new StubChild({
        name: 'reviewer',
        description: 'Reviews a diff.',
      });
      const agent = new AntigravityAgent({
        name: 'coder',
        antigravityConfig: makeConfig(),
        agentFactory: clientToolFactory(hookArrives),
        subAgents: [child],
        mode: 'single_turn',
      });

      const events = await runOnce(agent, runCtx());

      expect(responses(events)).toEqual([
        ['reviewer', 'call_3', {result: 'Looks good.'}],
      ]);
    },
  );

  it('test_each_conversation_gets_its_own_capture', async () => {
    // Call ids are only unique within a conversation, so a shared buffer would
    // drain session A's result against session B's identically-numbered call.
    const child = new StubChild({
      name: 'reviewer',
      description: 'Reviews a diff.',
    });
    const built: AntigravityAgentConfig[] = [];
    const agent = new AntigravityAgent({
      name: 'coder',
      antigravityConfig: makeConfig(),
      agentFactory: clientToolFactory('before_done', 'success', built),
      subAgents: [child],
    });

    await runOnce(agent, runCtx());
    await runOnce(agent, runCtx());

    const first = built[0].hooks?.at(-1);
    const second = built[1].hooks?.at(-1);
    expect(first).toBeDefined();
    expect(first).not.toBe(second);
  });
});

describe('AntigravityAgent as a workflow node', () => {
  it('test_node_input_becomes_the_prompt', async () => {
    // Without the runImpl override the harness silently receives the session's
    // user content: a plausible-looking wrong prompt rather than an error.
    const sdkAgent = new FakeSdkAgent(stepsOnce);
    const agent = new AntigravityAgent({
      name: 'agy',
      antigravityConfig: makeConfig(),
      agentFactory: () => sdkAgent,
      mode: 'single_turn',
    });

    await driveNode(agent, 'Fix the flake.');

    expect(sdkAgent.conversation.sendCount).toBe(1);
    expect(sdkAgent.conversation.lastPrompt).toBe('Fix the flake.');
  });

  it('test_node_input_none_is_a_no_op', async () => {
    // A classic agent-tree run still reads the session's user content.
    const sdkAgent = new FakeSdkAgent(stepsOnce);
    const agent = new AntigravityAgent({
      name: 'agy',
      antigravityConfig: makeConfig(),
      agentFactory: () => sdkAgent,
    });

    await driveNode(agent, undefined, runCtx({}, 'the original message'));

    expect(sdkAgent.conversation.lastPrompt).toBe('the original message');
  });

  it('test_last_complete_response_becomes_node_output', async () => {
    async function* twoAnswers(): AsyncGenerator<AntigravityStep> {
      yield textStep(0, 'Let me look at the file.');
      yield textStep(1, 'Done: patch sent for review.');
    }
    const agent = new AntigravityAgent({
      name: 'agy',
      antigravityConfig: makeConfig(),
      agentFactory: () => new FakeSdkAgent(twoAnswers),
      mode: 'single_turn',
    });

    const {events} = await driveNode(agent, 'go');

    expect(
      events.filter((e) => e.output !== undefined).map((e) => e.output),
    ).toEqual(['Done: patch sent for review.']);
  });

  it('test_output_reaches_the_parent_through_node_runner', async () => {
    async function* answerThenTool(): AsyncGenerator<AntigravityStep> {
      yield textStep(0, 'Done: patch sent for review.');
      // Ending on a tool step exercises the node runner's author enrichment,
      // which would otherwise attribute the output event to 'run_command'.
      yield {
        stepIndex: 1,
        type: 'TOOL_CALL',
        source: 'SYSTEM',
        status: 'DONE',
        content: 'ok',
        toolCalls: [{name: 'run_command', args: {}, id: 'c1'}],
      };
    }
    const agent = new AntigravityAgent({
      name: 'agy',
      antigravityConfig: makeConfig(),
      agentFactory: () => new FakeSdkAgent(answerThenTool),
      mode: 'single_turn',
    });

    const {events, output} = await driveNode(agent, 'go');

    expect(output).toBe('Done: patch sent for review.');
    expect(
      events.filter((e) => e.output !== undefined).map((e) => e.author),
    ).toEqual(['agy']);
  });

  it('test_text_less_run_outputs_empty_string_not_none', async () => {
    async function* toolOnly(): AsyncGenerator<AntigravityStep> {
      // Reachable when a trajectory ends on tool calls with no closing summary.
      yield {
        stepIndex: 0,
        type: 'TOOL_CALL',
        source: 'SYSTEM',
        status: 'DONE',
        content: 'ok',
        toolCalls: [{name: 'run_command', args: {}, id: 'c0'}],
      };
    }
    const agent = new AntigravityAgent({
      name: 'agy',
      antigravityConfig: makeConfig(),
      agentFactory: () => new FakeSdkAgent(toolOnly),
      mode: 'single_turn',
    });

    const {output} = await driveNode(agent, 'go');

    // `undefined` would put `{"result": null}` in front of the parent's model.
    expect(output).toBe('');
  });
});
