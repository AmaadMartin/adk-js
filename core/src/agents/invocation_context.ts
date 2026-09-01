/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content} from '@google/genai';
import {isEmpty} from 'lodash-es';

import {ResumabilityConfig} from '../apps/resumability_config.js';
import {SessionArtifactService} from '../artifacts/session_artifact_service.js';
import {BaseCredentialService} from '../auth/credential_service/base_credential_service.js';
import {LlmCallsLimitExceededError} from '../errors/llm_calls_limit_exceeded_error.js';
import {Event, getFunctionCalls} from '../events/event.js';
import {
  filterSessionEvents,
  findMatchingFunctionCall,
  SessionEventFilterOptions,
} from '../events/event_filters.js';
import {BaseMemoryService} from '../memory/base_memory_service.js';
import {PluginManager} from '../plugins/plugin_manager.js';
import {BaseSessionService} from '../sessions/base_session_service.js';
import {Session} from '../sessions/session.js';
import {AsyncQueue} from '../utils/async_queue.js';
import {randomUUID} from '../utils/env_aware_utils.js';
import {branchPathFromString} from '../workflow/branch_path.js';

import {ActiveStreamingTool} from './active_streaming_tool.js';
import {BaseAgent} from './base_agent.js';
import {LiveRequestQueue} from './live_request_queue.js';
import {RunConfig} from './run_config.js';
import {TranscriptionEntry} from './transcription_entry.js';

/**
 * Workflow: data exposed to `{Class.field}` and `<Class.field from source_node>`
 * instruction placeholders when an LlmAgent runs as a workflow node. Populated by
 * `LLMAgentWrapper`; absent for ordinary (non-workflow) agent runs, in which case
 * those placeholders are left untouched.
 */
export interface WorkflowInstructionScope {
  /** The current node's input, exposing fields for `{Class.field}`. */
  input?: unknown;
  /** Predecessor node outputs keyed by node name, for `<Class.field from node>`. */
  outputsByNode?: Record<string, unknown>;
}

/** How {@link InvocationContext.setAgentState} updates one agent's state. */
export interface SetAgentStateOptions {
  /** The state to record. Ignored when `endOfAgent` is true. */
  agentState?: Record<string, unknown>;

  /** Whether the agent has finished running. */
  endOfAgent?: boolean;
}

/**
 * The parameters for creating an invocation context.
 */
export interface InvocationContextParams {
  artifactService?: SessionArtifactService;
  sessionService?: BaseSessionService;
  memoryService?: BaseMemoryService;
  credentialService?: BaseCredentialService;
  invocationId: string;
  branch?: string;
  agent?: BaseAgent;
  userContent?: Content;
  session: Session;
  endInvocation?: boolean;
  transcriptionCache?: TranscriptionEntry[];
  runConfig?: RunConfig;
  activeStreamingTools?: Record<string, ActiveStreamingTool>;
  pluginManager: PluginManager;
  abortSignal?: AbortSignal;
  workflowInstructionScope?: WorkflowInstructionScope;
  isolationScope?: string;
  /** Nesting depth of node-as-tool executions; used to bound recursion. */
  nodeToolDepth?: number;
  liveRequestQueue?: LiveRequestQueue;
  liveSessionResumptionHandle?: string;
  /**
   * Request-level metadata passed from an incoming A2A request or caller.
   */
  a2aMetadata?: Record<string, unknown>;
  resumabilityConfig?: ResumabilityConfig;
  agentStates?: Record<string, Record<string, unknown>>;
  endOfAgents?: Record<string, boolean>;
}

/**
 * A container to keep track of the cost of invocation.
 *
 * While we don't expect the metrics captured here to be a direct
 * representative of monetary cost incurred in executing the current
 * invocation, they in some ways have an indirect effect.
 */
class InvocationCostManager {
  private numberOfLlmCalls: number = 0;

  /**
   * Increments the number of llm calls and enforces the limit.
   *
   * @param runConfig the run config of the invocation.
   * @throws If number of llm calls made exceed the set threshold.
   */
  incrementAndEnforceLlmCallsLimit(runConfig?: RunConfig) {
    this.numberOfLlmCalls++;

    if (
      runConfig &&
      runConfig.maxLlmCalls! > 0 &&
      this.numberOfLlmCalls > runConfig.maxLlmCalls!
    ) {
      throw new LlmCallsLimitExceededError(
        `Max number of llm calls limit of ${runConfig.maxLlmCalls!} exceeded`,
      );
    }
  }
}

/**
 * An invocation context represents the data of a single invocation of an agent.
 *
 * An invocation:
 *     1. Starts with a user message and ends with a final response.
 *     2. Can contain one or multiple agent calls.
 *     3. Is handled by runner.runAsync().
 *
 *   An invocation runs an agent until it does not request to transfer to
 * another agent.
 *
 *   An agent call:
 *     1. Is handled by agent.runAsync().
 *     2. Ends when agent.runAsync() ends.
 *
 *   An LLM agent call is an agent with a BaseLLMFlow.
 *  An LLM agent call can contain one or multiple steps.
 *
 *  An LLM agent runs steps in a loop until:
 *    1. A final response is generated.
 *    2. The agent transfers to another agent.
 *    3. The end_invocation is set to true by any callbacks or tools.
 *
 *  A step:
 *    1. Calls the LLM only once and yields its response.
 *   2. Calls the tools and yields their responses if requested.
 *
 *  The summarization of the function response is considered another step, since
 *  it is another llm call.
 *  A step ends when it's done calling llm and tools, or if the end_invocation
 *  is set to true at any time.
 *
 *  ```
 *     ┌─────────────────────── invocation ──────────────────────────┐
 *     ┌──────────── llm_agent_call_1 ────────────┐ ┌─ agent_call_2 ─┐
 *     ┌──── step_1 ────────┐ ┌───── step_2 ──────┐
 *     [call_llm] [call_tool] [call_llm] [transfer]
 *  ```
 */
export class InvocationContext {
  readonly artifactService?: SessionArtifactService;
  readonly sessionService?: BaseSessionService;
  readonly memoryService?: BaseMemoryService;
  readonly credentialService?: BaseCredentialService;

  /**
   * The id of this invocation context.
   */
  readonly invocationId: string;

  /**
   * The branch of the invocation context.
   *
   * The format is like agent_1.agent_2.agent_3, where agent_1 is the parent of
   * agent_2, and agent_2 is the parent of agent_3.
   *
   * Branch is used when multiple sub-agents shouldn't see their peer agents'
   * conversation history.
   */
  branch?: string;

  /**
   * The agent driving this invocation.
   *
   * Unset when the root being run is a bare {@link BaseNode} — a `Workflow`
   * handed straight to the `Runner` — because there is no agent in play at
   * that level. Nodes deeper in the graph that *are* agents get their own
   * contexts with this set. Mirrors adk-python, whose field is
   * `BaseAgent | BaseNode | None` and which passes `None` on the node path.
   *
   * Most code reaches this from inside an agent's own execution, where it is
   * always set; prefer {@link requireAgent} there, so a broken invariant
   * fails by name rather than as a property access on `undefined`.
   */
  agent?: BaseAgent;

  /**
   * The user content that started this invocation.
   */
  readonly userContent?: Content;

  /**
   * The current session of this invocation context.
   */
  readonly session: Session;

  /**
   * Whether to end this invocation.
   * Set to True in callbacks or tools to terminate this invocation.
   */
  endInvocation: boolean;

  /**
   * Caches necessary, data audio or contents, that are needed by transcription.
   */
  transcriptionCache?: TranscriptionEntry[];

  /**
   * Configurations for live agents under this invocation.
   */
  runConfig?: RunConfig;

  /**
   * A container to keep track of different kinds of costs incurred as a part of
   * this invocation.
   *
   * This is shared across every agent context of the same invocation (see the
   * constructor) so run-wide limits such as `maxLlmCalls` are enforced for the
   * whole invocation rather than resetting for each agent/sub-agent.
   */
  private readonly invocationCostManager: InvocationCostManager;

  /**
   * The running streaming tools of this invocation.
   */
  activeStreamingTools?: Record<string, ActiveStreamingTool>;

  /**
   * The manager for keeping track of plugins in this invocation.
   */
  pluginManager: PluginManager;

  readonly abortSignal?: AbortSignal;

  /**
   * An optional channel into which a running tool can push events to be
   * interleaved into the agent's output stream. Set by the LLM flow around tool
   * execution so a {@link NodeTool} (running a node/workflow) can surface the
   * node's intermediate and interrupt events. Cleared once tools finish.
   */
  eventQueue?: AsyncQueue<Event>;

  /**
   * Workflow: field-resolution scope for `{Class.field}` /
   * `<Class.field from node>` instruction placeholders (set by
   * `LLMAgentWrapper`).
   */
  workflowInstructionScope?: WorkflowInstructionScope;

  /**
   * Workflow: the isolation scope of the node this context runs in. Events
   * carrying a different scope are withheld from this agent's LLM request.
   */
  isolationScope?: string;

  /**
   * Nesting depth of node-as-tool ({@link NodeTool}) executions in this
   * invocation. Incremented each time a node runs as a tool (via a depth+1
   * clone), so `NodeTool` can bound `node -> tool -> node` recursion.
   */
  readonly nodeToolDepth: number;

  /**
   * The live request queue feeding the model on the bidirectional (live) path.
   * Set only for invocations started via `runner.runLive`.
   */
  readonly liveRequestQueue?: LiveRequestQueue;

  /**
   * The most recent session resumption handle observed on the live path.
   * Updated as the server emits resumption updates so a reconnect can restore
   * server-side state instead of replaying history. Mutable by design.
   */
  liveSessionResumptionHandle?: string;

  /**
   * Request-level metadata passed from an incoming A2A request or caller.
   */
  readonly a2aMetadata?: Record<string, unknown>;

  /** Resumability for every agent under this invocation. */
  resumabilityConfig?: ResumabilityConfig;

  /**
   * The recorded state of each agent in this invocation, keyed by the agent's
   * node path or name. Shared by reference with contexts made by
   * {@link clone}, so a sub-agent's checkpoint is visible to its parent.
   */
  agentStates: Record<string, Record<string, unknown>>;

  /** Which agents have finished running, keyed like {@link agentStates}. */
  endOfAgents: Record<string, boolean>;

  /**
   * @param params The parameters for creating an invocation context.
   */
  constructor(params: InvocationContextParams) {
    this.artifactService = params.artifactService;
    this.sessionService = params.sessionService;
    this.memoryService = params.memoryService;
    this.invocationId = params.invocationId;
    this.branch = params.branch;
    this.agent = params.agent;
    this.userContent = params.userContent;
    this.session = params.session;
    this.endInvocation = params.endInvocation || false;
    this.transcriptionCache = params.transcriptionCache;
    this.runConfig = params.runConfig;
    this.activeStreamingTools = params.activeStreamingTools;
    this.pluginManager = params.pluginManager;
    this.abortSignal = params.abortSignal;
    this.workflowInstructionScope = params.workflowInstructionScope;
    this.isolationScope = params.isolationScope;
    this.nodeToolDepth = params.nodeToolDepth ?? 0;
    this.a2aMetadata = params.a2aMetadata;
    // Inherit the parent invocation's cost manager when one is available.

    // Child contexts created for sub-agents, agent transfers and loop
    // iterations (via createInvocationContext / createBranchCtxForSubAgent)
    // carry the parent context's fields over, so reusing its cost manager
    // keeps a single, shared LLM-call counter for the entire invocation.
    // Only a brand-new invocation (e.g. from the Runner) starts a fresh one.
    this.invocationCostManager =
      (params as {invocationCostManager?: InvocationCostManager})
        .invocationCostManager ?? new InvocationCostManager();
    this.liveRequestQueue = params.liveRequestQueue;
    this.liveSessionResumptionHandle = params.liveSessionResumptionHandle;
    this.resumabilityConfig = params.resumabilityConfig;
    this.agentStates = params.agentStates ?? {};
    this.endOfAgents = params.endOfAgents ?? {};
  }

  /**
   * The app name of the current session.
   */
  get appName() {
    return this.session.appName;
  }

  /**
   * The user ID of the current session.
   */
  get userId() {
    return this.session.userId;
  }

  /**
   * Whether this invocation can be paused and resumed later.
   *
   * A getter rather than a field, so {@link clone}'s spread of own fields
   * cannot shadow it with a stale value.
   */
  get isResumable(): boolean {
    return this.resumabilityConfig?.isResumable ?? false;
  }

  /**
   * Tracks number of llm calls made.
   *
   * @throws {LlmCallsLimitExceededError} If number of llm calls made exceed the
   *   set threshold.
   */
  incrementLlmCallCount() {
    this.invocationCostManager.incrementAndEnforceLlmCallsLimit(this.runConfig);
  }

  /**
   * The session's events, optionally narrowed to this invocation and this
   * branch's subtree.
   *
   * @param options Which filters to apply. With none, every session event is
   *   returned, in order.
   */
  getEvents(options: SessionEventFilterOptions = {}): Event[] {
    return filterSessionEvents(
      this.session.events,
      {invocationId: this.invocationId, branch: this.branch},
      options,
    );
  }

  /**
   * Whether to pause the invocation right after `event`.
   *
   * Pausing differs from ending: a paused invocation can be resumed. An event
   * pauses when it issues a long-running function call that nothing has
   * answered yet. A later user event on a sub-branch of the call means the user
   * is already answering it, so the run continues.
   *
   * Pausing does not depend on {@link isResumable}: adk-python pauses on a
   * long-running call whatever the app's resumability setting.
   *
   * @param event The event just produced.
   */
  shouldPauseInvocation(event: Event): boolean {
    const longRunningToolIds = event.longRunningToolIds;
    const functionCalls = getFunctionCalls(event);
    if (!longRunningToolIds?.length || functionCalls.length === 0) {
      return false;
    }

    const events = this.session.events;
    const eventIndex = lastIndexOfEventId(events, event.id);
    return functionCalls.some(
      (call) =>
        !!call.id &&
        longRunningToolIds.includes(call.id) &&
        !isAnsweredInSubBranch(events, eventIndex, call.id),
    );
  }

  /**
   * The event in this invocation that issued the call `functionResponseEvent`
   * answers, or `undefined` when there is none.
   *
   * Public, unlike adk-python's `_find_matching_function_call`: this repository
   * does not mark members private by name, and the same five call sites exist
   * here.
   */
  findMatchingFunctionCall(functionResponseEvent: Event): Event | undefined {
    const events = this.getEvents({currentInvocation: true});
    // The free function reads the response off the last event and searches
    // everything before it, so an event that is not already last is appended.
    const isLastEvent =
      events[events.length - 1]?.id === functionResponseEvent.id;
    return findMatchingFunctionCall(
      isLastEvent ? events : [...events, functionResponseEvent],
    );
  }

  /**
   * Copies the branch, and where absent the isolation scope, of the function
   * call `event` answers onto `event` itself.
   *
   * The branch is overwritten because the response belongs wherever its call
   * was issued. The isolation scope is only filled in, because an event that
   * already carries one is inside an active task and must stay there.
   *
   * @param event The function-response event to stamp, mutated in place.
   */
  stampEventBranchContext(event: Event): void {
    const functionCall = this.findMatchingFunctionCall(event);
    if (!functionCall) {
      return;
    }
    event.branch = functionCall.branch;
    if (
      event.isolationScope === undefined &&
      functionCall.isolationScope !== undefined
    ) {
      event.isolationScope = functionCall.isolationScope;
    }
  }

  /**
   * Records the state of one agent in this invocation.
   *
   * With `endOfAgent`, the agent is marked finished and its state is dropped.
   * With `agentState`, the state is recorded and the finished flag is cleared.
   * With neither, both are dropped, which lets the agent run again.
   *
   * @param agentName The agent's name, or its node path in a workflow.
   * @param options The state to record. `endOfAgent` wins over `agentState`.
   */
  setAgentState(agentName: string, options: SetAgentStateOptions = {}): void {
    if (options.endOfAgent) {
      this.endOfAgents[agentName] = true;
      delete this.agentStates[agentName];
    } else if (options.agentState !== undefined) {
      this.agentStates[agentName] = options.agentState;
      this.endOfAgents[agentName] = false;
    } else {
      delete this.endOfAgents[agentName];
      delete this.agentStates[agentName];
    }
  }

  /**
   * Drops the recorded state of every agent below `agentName`, so each one
   * starts fresh when the agent runs again.
   *
   * @param agentName The agent whose descendants are reset. Unknown names and
   *   a context with no agent are no-ops.
   */
  resetSubAgentStates(agentName: string): void {
    const agent = this.agent?.findAgent(agentName);
    if (!agent) {
      return;
    }
    for (const subAgent of agent.subAgents) {
      this.setAgentState(subAgent.name);
      this.resetSubAgentStates(subAgent.name);
    }
  }

  /**
   * Rebuilds {@link agentStates} and {@link endOfAgents} from the events this
   * invocation already produced, so a resumed run knows which agents finished
   * and where the others stopped.
   *
   * An authored event carrying content but no state records an empty state:
   * the agent produced something, so a resumed run must not treat it as never
   * having started.
   */
  populateInvocationAgentStates(): void {
    if (!this.isResumable) {
      return;
    }
    for (const event of this.getEvents({currentInvocation: true})) {
      const key = event.nodeInfo?.path || event.author;
      if (!key) {
        continue;
      }
      const agentState = event.actions?.agentState;
      if (event.actions?.endOfAgent) {
        this.endOfAgents[key] = true;
        delete this.agentStates[key];
      } else if (agentState !== undefined) {
        this.agentStates[key] = agentState;
        this.endOfAgents[key] = false;
      } else if (
        event.author !== 'user' &&
        event.content &&
        // An already-recorded empty state counts as absent, mirroring the
        // falsy-dict test adk-python makes here.
        isEmpty(this.agentStates[key])
      ) {
        this.agentStates[key] = {};
        this.endOfAgents[key] = false;
      }
    }
  }

  /**
   * Returns a copy of this context with `overrides` applied. The spread carries
   * every own field over (including the shared cost manager), so the copy keeps
   * a single LLM-call counter for the invocation.
   *
   * Note: this copies own enumerable fields by value — scalar mutable fields
   * (e.g. `endInvocation`) are decoupled from the original, while object-valued
   * fields (`session`, …) stay shared by reference.
   */
  clone(overrides: Partial<InvocationContextParams> = {}): InvocationContext {
    return new InvocationContext({...this, ...overrides});
  }
}

export function newInvocationContextId(): string {
  return `e-${randomUUID()}`;
}

/**
 * The index of the last event with id `eventId`, or `-1`.
 *
 * The search runs backwards because the event being looked up is normally the
 * one just appended.
 */
function lastIndexOfEventId(events: Event[], eventId: string): number {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].id === eventId) {
      return i;
    }
  }
  return -1;
}

/**
 * Whether a user event after `eventIndex` sits on a branch spawned by the call
 * `callId`, which means the user is already answering that call.
 *
 * An `eventIndex` of `-1` means the issuing event is not in the session, so
 * nothing can have answered it.
 */
function isAnsweredInSubBranch(
  events: Event[],
  eventIndex: number,
  callId: string,
): boolean {
  if (eventIndex === -1) {
    return false;
  }
  return events
    .slice(eventIndex + 1)
    .some(
      (event) =>
        event.author === 'user' &&
        !!event.branch &&
        branchPathFromString(event.branch).getRunIds().has(callId),
    );
}

/**
 * The agent driving `ctx`, for code that only runs because one is.
 *
 * An LLM flow, an agent transfer, a tool call: each is reached from inside an
 * agent's own execution, so {@link InvocationContext.agent} is set by
 * construction. Going through here says that out loud, and turns a violated
 * assumption into a named error rather than a property access on `undefined`
 * several frames away.
 *
 * A free function rather than an accessor on the class, because a good deal of
 * code (and most tests) passes a duck-typed context object; a getter would be
 * simply absent on those, which fails less clearly than not having the agent.
 *
 * @throws if the invocation is driving a bare node rather than an agent.
 */
export function requireAgent(ctx: InvocationContext): BaseAgent {
  if (!ctx.agent) {
    throw new Error(
      'InvocationContext.agent is not set: this invocation is running a node ' +
        'directly, so there is no agent at this level.',
    );
  }
  return ctx.agent;
}
