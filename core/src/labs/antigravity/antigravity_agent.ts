/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Runs an Antigravity SDK agent as an ADK agent.
 *
 * Wraps a pre-configured Antigravity agent as a native ADK {@link BaseAgent}
 * node, delegating each turn to the Antigravity runner and streaming the
 * harness's steps back as ADK events.
 *
 * The harness runs the Antigravity agent's loop and owns its conversation, so
 * an {@link AntigravityAgent} must run as an ADK root agent unless it declares
 * `mode: 'single_turn'`. ADK sub-agents are allowed: each child is bridged onto
 * the Antigravity config as a client-side tool, which is the only way the
 * harness can reach one.
 */

import {BaseAgent, BaseAgentConfig} from '../../agents/base_agent.js';
import {InvocationContext} from '../../agents/invocation_context.js';
import {StreamingMode} from '../../agents/run_config.js';
import {createEvent, Event} from '../../events/event.js';
import {logger} from '../../utils/logger.js';
import {NodeContext} from '../../workflow/node_context.js';
import {
  convertStepToEvents,
  drainToolResults,
  finalModelText,
} from './event_converter.js';
import {toNodeInputContent} from './node_input_utils.js';
import {
  AntigravityAgentConfig,
  isLocalAntigravityConfig,
  SdkAgent,
} from './sdk_types.js';
import {makeSubAgentTool} from './sub_agent_tools.js';
import {
  createToolErrorCapture,
  createToolResultCapture,
  ToolResultBuffer,
} from './tool_result_capture.js';

const CONVERSATION_ID_STATE_KEY_PREFIX = '_antigravity_conversation_id_';

/** The error an {@link AntigravityAgent} throws when an ADK parent adopts it. */
export const PARENT_REQUIRES_SINGLE_TURN_MESSAGE =
  'AntigravityAgent may only be an ADK sub-agent when it sets ' +
  "mode: 'single_turn', where the ADK parent composes a self-contained " +
  'request. Otherwise it must run as an ADK root agent.';

/**
 * The composition mode an {@link AntigravityAgent} runs in under an ADK parent.
 *
 * `'single_turn'` is what allows this agent to have a parent at all. Each call
 * is an independent conversation: no conversation id is stored, and the id an
 * earlier turn stored is not read back.
 *
 * What supplies the request differs from adk-python. As a workflow node the
 * parent composes it, and the node input becomes the prompt. In an agent tree
 * it is still `ctx.userContent`, because adk-js has no `_SingleTurnAgentTool`
 * equivalent: an `LlmAgent` parent neither exposes a single-turn child as an
 * inline `request` tool nor excludes it from its transfer targets.
 */
export type AntigravityAgentMode = 'single_turn';

/** Constructor options for {@link AntigravityAgent}. */
export interface AntigravityAgentOptions extends BaseAgentConfig {
  /**
   * The Antigravity agent configuration.
   *
   * Named `antigravityConfig` rather than `config` because `BaseAgent` already
   * owns a `config` used by `clone()`.
   */
  antigravityConfig: AntigravityAgentConfig;

  /**
   * Builds the Antigravity agent each turn runs on.
   *
   * Required, and called once per ADK turn with a fresh copy of
   * {@link antigravityConfig}. There is no default: no Antigravity SDK is
   * published for JavaScript, so there is no class to fall back to.
   */
  agentFactory: (config: AntigravityAgentConfig) => SdkAgent;

  /**
   * Composition mode when this agent has an ADK parent.
   *
   * Leave unset for a standalone root agent. Read once, at construction, by the
   * guard that rejects adoption.
   */
  mode?: AntigravityAgentMode;
}

/** An entered Antigravity agent and its scoped tool-result capture. */
interface ActiveConversation {
  /** The connected Antigravity agent. */
  agent: SdkAgent;
  /** This conversation's client-tool outcomes, when children are bridged. */
  toolResults?: ToolResultBuffer;
}

/**
 * Runs a Google Antigravity agent as an ADK agent node.
 *
 * Each turn of an ADK session runs on a fresh Antigravity agent, resuming the
 * conversation the previous turn created. The conversation id is kept in ADK
 * session state, so resumption survives a restart; under `mode: 'single_turn'`
 * no id is stored. Persisting the id needs the ADK `Runner`, which is what
 * applies a yielded event's `stateDelta`.
 *
 * Any ADK sub-agents are bridged onto the Antigravity config as client-side
 * tools named after the child, so every child needs a non-empty `description`
 * and a name unique among its siblings.
 *
 * Must be an ADK root agent unless `mode: 'single_turn'`.
 */
export class AntigravityAgent extends BaseAgent<AntigravityAgentOptions> {
  /** The Antigravity agent configuration this agent wraps. */
  readonly antigravityConfig: AntigravityAgentConfig;

  private readonly agentFactory: (config: AntigravityAgentConfig) => SdkAgent;

  constructor(options: AntigravityAgentOptions) {
    super(options);
    this.antigravityConfig = options.antigravityConfig;
    this.agentFactory = options.agentFactory;
    validateMode(options.mode);
    guardParentAdoption(this);
    this.validateSubAgents();
    this.warnIfLocalWithoutSaveDir();
  }

  /**
   * The composition mode, which cannot change after construction: the adoption
   * guard only gets to check it once.
   */
  get mode(): AntigravityAgentMode | undefined {
    return this.config.mode;
  }

  protected async *runAsyncImpl(
    ctx: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    const storedId =
      this.mode === 'single_turn' ? undefined : this.storedConversationId(ctx);
    const active = await this.enterSdkAgent(storedId);

    let failure: unknown;
    try {
      if (this.mode === 'single_turn') {
        yield* this.runTurn(active, ctx);
      } else {
        yield* this.runTrackedTurn(active, ctx, storedId);
      }
    } catch (error: unknown) {
      failure = error;
      throw error;
    } finally {
      await active.agent.close(failure);
    }
  }

  /**
   * Refuses a live run.
   *
   * Deliberately not a generator: there is nothing to stream, and a generator
   * whose body only throws is what `require-yield` exists to reject.
   */
  protected runLiveImpl(): AsyncGenerator<Event, void, void> {
    throw new Error(
      'AntigravityAgent does not support live (audio/video) runs: the ' +
        'Antigravity harness drives a text trajectory. Use runAsync instead.',
    );
  }

  /**
   * Runs the agent as a workflow node, threading `nodeInput` in and the node
   * output back out.
   *
   * Unlike {@link BaseAgent.runImpl} this override is needed twice over:
   * without it the harness silently receives `ctx.userContent`, a
   * plausible-looking wrong prompt rather than an error, and the node produces
   * no output for its parent.
   */
  protected override async *runImpl(
    ctx: NodeContext,
    nodeInput: unknown,
  ): AsyncGenerator<Event, void, void> {
    let parentContext = ctx.getInvocationContext();
    // An absent node input means a classic agent-tree run.
    if (nodeInput !== undefined && nodeInput !== null) {
      parentContext = parentContext.clone({
        userContent: toNodeInputContent(nodeInput),
      });
    }

    let lastText: string | undefined;
    for await (const event of this.runAsync(parentContext)) {
      const text = finalModelText(event, this.name);
      if (text !== undefined) {
        lastText = text;
      }
      yield event;
    }

    // Never `undefined`: that would put `{"result": null}` in front of the
    // parent's model.
    yield createEvent({
      invocationId: parentContext.invocationId,
      author: this.name,
      branch: parentContext.branch,
      output: lastText ?? '',
    });
  }

  /**
   * Runs one turn, recording the conversation id so the next turn resumes it.
   */
  private async *runTrackedTurn(
    active: ActiveConversation,
    ctx: InvocationContext,
    storedId: string | undefined,
  ): AsyncGenerator<Event, void, void> {
    if (storedId && this.resumeWasSilentlyDropped(active)) {
      yield this.conversationIdEvent(ctx, undefined);
      throw new Error(
        `Could not resume conversation '${storedId}': it is no longer ` +
          'available. The stored id has been cleared, so the next turn will ' +
          'start a new conversation, but the earlier turns of this session ' +
          'are not recoverable.',
      );
    }

    // The id is recorded from inside the loop as soon as it changes. "Did we
    // yield an event" is not the same question as "does this conversation have
    // history": a turn whose steps carry no user-visible content (compaction)
    // yields no events yet still has history, and must record its id or the
    // next turn orphans it. A genuinely empty turn (no history) must NOT
    // record, or the next resume looks silently dropped.
    let recorded = false;
    try {
      for await (const event of this.runTurn(active, ctx)) {
        yield event;
        if (!recorded) {
          const delta = this.idDeltaIfChanged(ctx, active, storedId);
          if (delta) {
            recorded = true;
            yield delta;
          }
        }
      }
      yield* this.flushIdIfPending(ctx, active, storedId, recorded);
    } catch (error: unknown) {
      // A harness error mid-turn leaves a resumable conversation behind, so the
      // block after the loop never runs on that path; the id is persisted here
      // before re-raising, or the next turn orphans it. A consumer that
      // abandons the generator lands on `finally`, never here, so no yield can
      // answer it — which is why this is not a `finally`.
      yield* this.flushIdIfPending(ctx, active, storedId, recorded);
      throw error;
    }
  }

  /**
   * Records the conversation id if the turn ended without recording it.
   *
   * Only when the conversation has history: "did we yield an event" is not the
   * same question as "does this conversation exist", and recording an id for a
   * genuinely empty turn makes the next resume look silently dropped.
   */
  private async *flushIdIfPending(
    ctx: InvocationContext,
    active: ActiveConversation,
    storedId: string | undefined,
    recorded: boolean,
  ): AsyncGenerator<Event, void, void> {
    if (recorded || active.agent.conversation.history.length === 0) {
      return;
    }
    const delta = this.idDeltaIfChanged(ctx, active, storedId);
    if (delta) {
      yield delta;
    }
  }

  /** Sends the prompt and streams the harness's steps back as ADK events. */
  private async *runTurn(
    active: ActiveConversation,
    ctx: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    const seenToolCalls = new Set<string>();
    const seenToolResults = new Set<string>();
    const streaming = ctx.runConfig?.streamingMode === StreamingMode.SSE;

    await active.agent.conversation.send(extractUserPrompt(ctx));

    for await (const step of active.agent.conversation.receiveSteps()) {
      yield* convertStepToEvents(step, {
        ctx,
        author: this.name,
        seenToolCalls,
        seenToolResults,
        toolResults: active.toolResults,
        streaming,
      });
    }

    // A client tool's terminal step carries empty `toolCalls`: its result
    // arrives on the post-tool-call hook, not in a step, so pair it up after
    // the loop. The hook is a blocking round trip the harness completes before
    // the turn goes idle, so every result owed a response is buffered by now.
    yield* drainToolResults({
      ctx,
      seenToolCalls,
      seenToolResults,
      toolResults: active.toolResults,
    });

    // Whatever is left was never owed a response.
    active.toolResults?.clear();
  }

  /** Builds and connects the Antigravity agent this turn runs on. */
  private async enterSdkAgent(
    conversationId?: string,
  ): Promise<ActiveConversation> {
    // Gated on sub-agents: ADK children are the only client tools, and a
    // post-tool-call hook costs a blocking round trip per successful call. Its
    // call ids only mean anything within this conversation.
    const toolResults =
      this.subAgents.length > 0 ? new ToolResultBuffer() : undefined;
    const config = this.buildSdkConfig(toolResults);
    if (conversationId) {
      config.conversationId = conversationId;
      config.sessionContinuationMode = 'create_or_resume';
    }

    const agent = this.agentFactory(config);
    try {
      return {agent: await agent.connect(), toolResults};
    } catch (error: unknown) {
      // A failed or cancelled connect would otherwise orphan the harness
      // subprocess.
      await agent.close(error);
      throw error;
    }
  }

  /**
   * Copies the caller's Antigravity configuration and adds this agent's
   * children and capture hooks to the copy.
   *
   * Copied because an Antigravity agent's connection is single-use, so each
   * turn needs a fresh configuration, and to avoid mutating the caller's.
   */
  private buildSdkConfig(
    toolResults?: ToolResultBuffer,
  ): AntigravityAgentConfig {
    this.validateSubAgents();
    const tools = [...(this.antigravityConfig.tools ?? [])];
    const hooks = [...(this.antigravityConfig.hooks ?? [])];
    if (this.subAgents.length > 0) {
      tools.push(...this.subAgents.map(makeSubAgentTool));
    }
    if (toolResults) {
      // Both halves: success reports on the post-tool-call hook, failure on the
      // on-tool-error hook, and registering the error hook is what puts the
      // failure lifecycle on the wire at all.
      hooks.push(
        createToolResultCapture(toolResults),
        createToolErrorCapture(toolResults),
      );
    }
    return {...this.antigravityConfig, tools, hooks};
  }

  /**
   * Rejects a child the harness cannot register.
   *
   * Called again from {@link buildSdkConfig} because `subAgents` can be mutated
   * after construction.
   */
  private validateSubAgents(): void {
    // Seeded with the configuration's own tool names: a child is added to the
    // same `tools`, so one sharing a name with a tool already there collides
    // just as two children do. Builtins enabled by name elsewhere in the
    // configuration are not enumerated here.
    const toolNames = new Set(
      (this.antigravityConfig.tools ?? []).map((tool) =>
        typeof tool === 'string' ? tool : tool.name,
      ),
    );
    const seenNames = new Set<string>();
    for (const child of this.subAgents) {
      if (!child.description) {
        throw new Error(
          `ADK sub-agent '${child.name}' needs a description: it is offered ` +
            'to the harness as a tool, and the description is the only thing ' +
            'the Antigravity model reads when deciding whether to call it.',
        );
      }
      if (toolNames.has(child.name)) {
        throw new Error(
          `ADK sub-agent '${child.name}' collides with a tool already on the ` +
            'config: it is added to the same `tools`, and the harness ' +
            'registers one tool per name and rejects the second with an error ' +
            'naming only the tool. Rename the child or the tool.',
        );
      }
      if (seenNames.has(child.name)) {
        throw new Error(
          `Two ADK sub-agents share the name '${child.name}': the harness ` +
            'registers one tool per name and rejects the second with an error ' +
            'naming only the tool, not the ADK agent it came from. Rename one ' +
            'of the children.',
        );
      }
      seenNames.add(child.name);
    }
  }

  /** Warns about the one configuration that loses history with no error. */
  private warnIfLocalWithoutSaveDir(): void {
    if (this.mode === 'single_turn') {
      return;
    }
    // A local config with no saveDir mints a fresh temporary directory per
    // connection, so every turn writes somewhere the next turn will not look.
    if (!isLocalAntigravityConfig(this.antigravityConfig)) {
      return;
    }
    if (this.antigravityConfig.saveDir) {
      return;
    }
    logger.warn(
      'This Antigravity agent will not remember anything across turns: its ' +
        'config runs the harness locally with no saveDir, so each turn gets a ' +
        'fresh temporary directory, and the conversation from the previous ' +
        'turn is not there to resume. Set saveDir to a stable path, or set ' +
        "mode: 'single_turn' if independent turns are what you want.",
    );
  }

  /** Whether we asked to resume and got a new conversation instead. */
  private resumeWasSilentlyDropped(active: ActiveConversation): boolean {
    // An empty history after a resume is the only silent-drop signal there is,
    // and it is only reliable for the local connection, which creates a fresh
    // conversation when the stored one is missing and reports success. A remote
    // backend that quietly does the same cannot be told apart without SDK
    // support, so this is gated to the local config to avoid falsely failing
    // every remote resume.
    if (!isLocalAntigravityConfig(this.antigravityConfig)) {
      return false;
    }
    return active.agent.conversation.history.length === 0;
  }

  /** The session-state key this agent keeps its conversation id under. */
  private conversationIdStateKey(): string {
    // Scoped by agent name so two AntigravityAgents in one ADK session do not
    // resume each other's conversation.
    return CONVERSATION_ID_STATE_KEY_PREFIX + this.name;
  }

  /** The conversation id an earlier turn of this session recorded. */
  private storedConversationId(ctx: InvocationContext): string | undefined {
    const stored = ctx.session.state[this.conversationIdStateKey()];
    return typeof stored === 'string' && stored ? stored : undefined;
  }

  /** Builds the event that writes `conversationId` into session state. */
  private conversationIdEvent(
    ctx: InvocationContext,
    conversationId: string | undefined,
  ): Event {
    // Its own event rather than folded into a model event, because a partial
    // event is not appended to the session — which is where `stateDelta` is
    // applied. An undefined id clears the stored one.
    return createEvent({
      invocationId: ctx.invocationId,
      author: this.name,
      branch: ctx.branch,
      actions: {
        // `null`, not `undefined`, so the clearing entry survives being
        // serialized with the event and replayed. Both read back as "no stored
        // id", but `JSON.stringify` drops an `undefined` value.
        stateDelta: {[this.conversationIdStateKey()]: conversationId ?? null},
      },
    });
  }

  /** Returns an event persisting the conversation id, if it is new. */
  private idDeltaIfChanged(
    ctx: InvocationContext,
    active: ActiveConversation,
    storedId: string | undefined,
  ): Event | undefined {
    // Asked per event rather than at connect, because the runtime need not have
    // published an id by then, nor by the first step.
    const conversationId = active.agent.conversationId;
    if (!conversationId || conversationId === storedId) {
      return undefined;
    }
    return this.conversationIdEvent(ctx, conversationId);
  }
}

/**
 * Rejects a composition mode this agent does not have.
 *
 * `AntigravityAgent` is not an `LlmAgent`, so `LlmAgent`'s other modes have no
 * meaning here. The check runs at construction as well as in the type, because
 * a plain JavaScript caller and a config loaded from YAML both reach the
 * constructor without the compiler having seen the value.
 */
function validateMode(mode: AntigravityAgentMode | undefined): void {
  if (mode !== undefined && mode !== 'single_turn') {
    throw new Error(
      `AntigravityAgent mode must be 'single_turn' or unset, got '${mode}'.`,
    );
  }
}

/** The first text part of the user's message, or `''` when there is none. */
function extractUserPrompt(ctx: InvocationContext): string {
  for (const part of ctx.userContent?.parts ?? []) {
    if (part.text) {
      return part.text;
    }
  }
  return '';
}

/** Throws unless `agent` may be adopted by `parent`. */
function assertAdoptable(
  agent: AntigravityAgent,
  parent: BaseAgent | undefined,
): void {
  if (parent !== undefined && agent.mode !== 'single_turn') {
    throw new Error(PARENT_REQUIRES_SINGLE_TURN_MESSAGE);
  }
}

/**
 * Rejects adoption of `agent` by an ADK parent unless it runs single-turn.
 *
 * The check has to intercept the assignment, because that is the only moment
 * it happens: a parent's constructor adopts its children through
 * `setParentAgentForSubAgents`, which writes the field directly. Checking at
 * run time instead would let a mis-built agent tree construct cleanly and fail
 * a turn later, and it is `BaseAgent(...)` that the stack trace should name.
 *
 * `BaseAgent` declares `parentAgent` as a plain field, and a subclass may not
 * override a field with an accessor pair (TS2611), so the descriptor is
 * installed on the instance instead. The value the constructor already applied
 * is checked too, not only later assignments.
 */
function guardParentAdoption(agent: AntigravityAgent): void {
  let parent = agent.parentAgent;
  assertAdoptable(agent, parent);
  Object.defineProperty(agent, 'parentAgent', {
    configurable: true,
    enumerable: true,
    get: () => parent,
    set: (value: BaseAgent | undefined) => {
      assertAdoptable(agent, value);
      parent = value;
    },
  });
}
