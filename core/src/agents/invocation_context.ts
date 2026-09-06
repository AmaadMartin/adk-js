/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content} from '@google/genai';

import {ResumabilityConfig} from '../apps/resumability_config.js';
import {SessionArtifactService} from '../artifacts/session_artifact_service.js';
import {BaseCredentialService} from '../auth/credential_service/base_credential_service.js';
import {Event, getFunctionCalls} from '../events/event.js';
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
  agentStates?: Record<string, AgentState>;
  endOfAgents?: Record<string, boolean>;
  resumabilityConfig?: ResumabilityConfig;
}

/**
 * The resumption checkpoint one agent records for an invocation.
 *
 * A workflow agent describes its own progress here — which sub-agent is
 * running, how many times a loop has run — and the record is persisted verbatim
 * on `EventActions.agentState`, so the shape is open rather than closed. An
 * agent with nothing more specific to restore records the empty object, which
 * still says "this agent started".
 */
export type AgentState = Record<string, unknown>;

/**
 * The checkpoint {@link InvocationContext.setAgentState} records for one agent:
 * where it got to, or that it has finished. The two are exclusive, so a caller
 * cannot ask for a state that would be discarded.
 */
export type AgentStateUpdate =
  | {
      /** The agent's state at this point in the invocation. */
      agentState: AgentState;
      endOfAgent?: false;
    }
  | {
      agentState?: undefined;
      /** The agent has finished running in this invocation. */
      endOfAgent: true;
    };

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
      throw new Error(
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

  /**
   * The resumption checkpoint of each agent in this invocation, keyed by agent
   * name.
   *
   * Every context of one invocation shares this record by reference, because
   * both {@link clone} and `BaseAgent.createInvocationContext` build a child by
   * spreading the parent. A checkpoint a sub-agent writes on its own branch is
   * therefore visible to the parent that fanned out. `readonly` protects the
   * reference, not the entries.
   */
  readonly agentStates: Record<string, AgentState>;

  /**
   * Whether each agent in this invocation has finished, keyed by agent name.
   * Shared by reference with child contexts, like {@link agentStates}.
   */
  readonly endOfAgents: Record<string, boolean>;

  /**
   * The resumability config that applies to every agent under this invocation.
   */
  readonly resumabilityConfig?: ResumabilityConfig;

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
    // Read from params for the same reason as the cost manager above: a child
    // context must share the parent's records, so one agent's checkpoint is
    // recorded once for the whole invocation.
    this.agentStates = params.agentStates ?? {};
    this.endOfAgents = params.endOfAgents ?? {};
    this.resumabilityConfig = params.resumabilityConfig;
  }

  /**
   * Whether this invocation can be paused and resumed later.
   *
   * A getter rather than a field, so the `{...this}` spread that builds a child
   * context cannot carry a stale copy: it is always recomputed from
   * {@link resumabilityConfig}.
   */
  get isResumable(): boolean {
    return this.resumabilityConfig?.isResumable ?? false;
  }

  /**
   * Records the state of one agent in this invocation.
   *
   * - `endOfAgent: true` marks the agent finished and drops its checkpoint.
   * - An `agentState` is recorded, and the finished flag is cleared.
   *
   * @param agentName The name of the agent.
   * @param update The checkpoint to record.
   */
  setAgentState(agentName: string, update: AgentStateUpdate): void {
    if (update.endOfAgent) {
      this.endOfAgents[agentName] = true;
      delete this.agentStates[agentName];
    } else {
      this.agentStates[agentName] = update.agentState;
      this.endOfAgents[agentName] = false;
    }
  }

  /**
   * Whether to pause this invocation right after `event`.
   *
   * Pausing differs from ending: a paused invocation can be resumed later. An
   * event pauses the invocation when it requests a long-running tool call that
   * nothing has answered yet. A later user event published on a sub-branch of
   * the call answers it, which is how a nested human-in-the-loop turn resumes
   * without pausing again.
   *
   * @param event The event to inspect.
   * @return Whether the invocation should pause after this event.
   */
  shouldPauseInvocation(event: Event): boolean {
    const longRunningToolIds = event.longRunningToolIds ?? [];
    const callIds = getFunctionCalls(event)
      .map((call) => call.id)
      .filter((id): id is string => id !== undefined)
      .filter((id) => longRunningToolIds.includes(id));
    // An early return, so an ordinary event does not pay for a session scan.
    if (callIds.length === 0) {
      return false;
    }
    const laterEvents = eventsAfter(this.session.events, event.id);
    return callIds.some((id) => !isAnsweredOnSubBranch(laterEvents, id));
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
   * Tracks number of llm calls made.
   *
   * @throws If number of llm calls made exceed the set threshold.
   */
  incrementLlmCallCount() {
    this.invocationCostManager.incrementAndEnforceLlmCallsLimit(this.runConfig);
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
 * The events recorded after `eventId`, or none when the session does not hold
 * it. The scan runs backwards because the event being checked is normally the
 * most recent one.
 */
function eventsAfter(events: Event[], eventId: string): Event[] {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].id === eventId) {
      return events.slice(i + 1);
    }
  }
  return [];
}

/**
 * Whether a user event on a sub-branch of `functionCallId` follows it, which
 * means the long-running call is already being answered.
 */
function isAnsweredOnSubBranch(
  laterEvents: Event[],
  functionCallId: string,
): boolean {
  return laterEvents.some(
    (event) =>
      event.author === 'user' &&
      branchPathFromString(event.branch).getRunIds().has(functionCallId),
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
