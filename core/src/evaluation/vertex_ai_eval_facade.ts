/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content, Tool} from '@google/genai';
import {AgentDetails} from './app_details.js';
import {Invocation, InvocationEvent} from './eval_case.js';
import {
  EvalStatus,
  EvaluationResult,
  Evaluator,
  PerInvocationResult,
  validateInvocationLengths,
} from './evaluator.js';

// The Vertex Gen AI Eval SDK (the `vertexai` package's `.evals` API) has no
// equivalent in the JS ecosystem: adk-js's `@google-cloud/vertexai` dependency
// is the *generative* SDK, not the eval SDK. The interfaces below are minimal
// local stand-ins for that SDK's request/response contract (field names mapped
// to camelCase). They should be swapped for the native SDK types if a JS Vertex
// Gen AI Eval SDK is ever added.

/** Identifies a metric exposed by the Vertex Gen AI Eval SDK. */
export interface Metric {
  name: string;
}

/** The rubric-based multi-turn metrics exposed by the Vertex Gen AI Eval SDK. */
export const RubricMetric = {
  MULTI_TURN_TASK_SUCCESS: {name: 'MULTI_TURN_TASK_SUCCESS'},
  MULTI_TURN_TOOL_USE_QUALITY: {name: 'MULTI_TURN_TOOL_USE_QUALITY'},
  MULTI_TURN_TRAJECTORY_QUALITY: {name: 'MULTI_TURN_TRAJECTORY_QUALITY'},
} as const satisfies Record<string, Metric>;

/**
 * A single event within a conversation turn.
 *
 * Deliberately kept distinct from `InvocationEvent` even though the two are
 * structurally identical today: this is the eval SDK's wire shape, whereas
 * `InvocationEvent` is ADK's own. `mapInvocationEventToAgentEvent` is the seam
 * where they are expected to diverge once a real SDK type replaces this
 * stand-in, so please do not collapse them into an alias.
 */
export interface AgentEvent {
  author: string;
  content?: Content;
}

/** A single turn in a multi-turn conversation. */
export interface ConversationTurn {
  turnIndex: number;
  events: AgentEvent[];
  turnId: string;
}

/** Configuration describing an agent participating in the conversation. */
export interface AgentConfig {
  agentId: string;
  instruction: string;
  tools: Tool[];
}

/** The agent-centric view of a conversation handed to the eval SDK. */
export interface AgentData {
  agents: Record<string, AgentConfig>;
  turns: ConversationTurn[];
}

/** A single eval case in the request dataset. */
export interface EvalCaseRequest {
  agentData: AgentData;
}

/** The dataset handed to the eval SDK. */
export interface EvaluationDataset {
  evalCases: EvalCaseRequest[];
}

/** An aggregated (summary) metric result returned by the eval SDK. */
export interface AggregatedMetricResult {
  meanScore?: number | null;
}

/** The response returned by the eval SDK. */
export interface VertexEvaluationResult {
  summaryMetrics: AggregatedMetricResult[];
}

/**
 * Extracts the score from an eval result.
 *
 * Returns `summaryMetrics[0].meanScore` only when it is a finite number;
 * otherwise (empty summary metrics, `null`/`undefined`, or `NaN`) returns
 * `null`.
 */
function getScore(result: VertexEvaluationResult): number | null {
  const meanScore = result.summaryMetrics[0]?.meanScore;
  if (typeof meanScore === 'number' && !Number.isNaN(meanScore)) {
    return meanScore;
  }
  return null;
}

/** Derives the pass/fail status of a score against a threshold. */
function getEvalStatus(score: number | null, threshold: number): EvalStatus {
  if (score != null) {
    return score >= threshold ? EvalStatus.PASSED : EvalStatus.FAILED;
  }
  return EvalStatus.NOT_EVALUATED;
}

/** Maps `AgentDetails` (eval base type) to the SDK's `AgentConfig`. */
function mapAgentDetailsToAgentConfig(agentDetails: AgentDetails): AgentConfig {
  return {
    agentId: agentDetails.name,
    instruction: agentDetails.instructions,
    tools: agentDetails.toolDeclarations,
  };
}

/**
 * Collects the agent configs across all invocations, keyed by agent name.
 *
 * Dedup is first-wins: the first invocation that declares a given agent name
 * determines that agent's config.
 */
function getAgentDetails(
  invocations: Invocation[],
): Record<string, AgentConfig> {
  const agentConfigs: Record<string, AgentConfig> = {};
  for (const invocation of invocations) {
    const agentDetails = invocation.appDetails?.agentDetails;
    if (!agentDetails) {
      continue;
    }
    for (const [agentName, details] of Object.entries(agentDetails)) {
      if (!(agentName in agentConfigs)) {
        agentConfigs[agentName] = mapAgentDetailsToAgentConfig(details);
      }
    }
  }
  return agentConfigs;
}

/** Maps an `InvocationEvent` (eval base type) to the SDK's `AgentEvent`. */
function mapInvocationEventToAgentEvent(event: InvocationEvent): AgentEvent {
  return {author: event.author, content: event.content};
}

/**
 * Maps a single invocation to a conversation turn.
 *
 * The turn's events are ordered `[user, ...intermediate, agent]`.
 */
function mapInvocationTurn(
  turnIndex: number,
  invocation: Invocation,
): ConversationTurn {
  const events: AgentEvent[] = [
    {author: 'user', content: invocation.userContent},
  ];
  for (const event of invocation.intermediateData?.invocationEvents ?? []) {
    events.push(mapInvocationEventToAgentEvent(event));
  }
  events.push({author: 'agent', content: invocation.finalResponse});
  return {turnIndex, events, turnId: invocation.invocationId};
}

/** Maps a list of invocations to conversation turns, preserving order. */
function getTurns(invocations: Invocation[]): ConversationTurn[] {
  return invocations.map((invocation, index) =>
    mapInvocationTurn(index, invocation),
  );
}

/** Builds the SDK `AgentData` (agents + turns) from a list of invocations. */
function getAgentData(invocations: Invocation[]): AgentData {
  return {
    agents: getAgentDetails(invocations),
    turns: getTurns(invocations),
  };
}

function createEmptyResult(): EvaluationResult {
  return {
    overallScore: null,
    overallEvalStatus: EvalStatus.NOT_EVALUATED,
    perInvocationResults: [],
  };
}

/**
 * A facade for the multi-turn metrics exposed by the Vertex Gen AI Eval SDK.
 *
 * This flattens adk-python's abstract-base + single-subclass hierarchy
 * (`_VertexAiEvalFacade` / `_MultiTurnVertexiAiEvalFacade`) into one class,
 * since only the multi-turn facade is in scope; a future single-turn sub-port
 * can extract a shared base if needed.
 *
 * The credential-resolving `vertexai.Client` constructor from the Python
 * reference is intentionally omitted: there is no eval SDK client to construct
 * in JS. Credential/SDK wiring belongs behind the `performEval()` seam if and
 * when a JS Vertex Gen AI Eval SDK exists.
 */
export class MultiTurnVertexAiEvalFacade extends Evaluator {
  constructor(
    private readonly threshold: number,
    private readonly metric: Metric,
  ) {
    super();
  }

  /**
   * The single external boundary of this facade.
   *
   * Asynchronous because a real implementation is an HTTP round-trip to the
   * eval service. The default implementation rejects, because the Vertex Gen AI
   * Eval SDK is not available in adk-js. Override it (by subclassing or
   * stubbing) to wire in a real implementation.
   */
  protected async performEval(
    _dataset: EvaluationDataset,
    _metrics: Metric[],
  ): Promise<VertexEvaluationResult> {
    throw new Error(
      'This metric requires the Vertex Gen AI Eval SDK, which is not available' +
        ' in adk-js. Provide an implementation of performEval() (e.g. by' +
        ' subclassing/stubbing) to use this metric.',
    );
  }

  override async evaluateInvocations(
    actualInvocations: Invocation[],
    expectedInvocations?: Invocation[],
    // Accepted for interface parity but ignored, matching the reference (which
    // does `del conversation_scenario`).
    _conversationScenario?: unknown,
  ): Promise<EvaluationResult> {
    validateInvocationLengths(actualInvocations, expectedInvocations);
    if (actualInvocations.length === 0) {
      return createEmptyResult();
    }

    // Mark all n-1 leading turns as NOT_EVALUATED for these metrics.
    const perInvocationResults: PerInvocationResult[] = [];
    for (let i = 0; i < actualInvocations.length - 1; i++) {
      perInvocationResults.push({
        actualInvocation: actualInvocations[i],
        expectedInvocation: expectedInvocations?.[i],
        score: null,
        evalStatus: EvalStatus.NOT_EVALUATED,
      });
    }

    // Only the last turn is scored; the SDK call accounts for all prior turns.
    const lastIndex = actualInvocations.length - 1;
    const dataset: EvaluationDataset = {
      evalCases: [{agentData: getAgentData(actualInvocations)}],
    };
    const result = await this.performEval(dataset, [this.metric]);
    const score = getScore(result);
    perInvocationResults.push({
      actualInvocation: actualInvocations[lastIndex],
      expectedInvocation: expectedInvocations?.[lastIndex],
      score,
      evalStatus: getEvalStatus(score, this.threshold),
    });

    if (score !== null) {
      return {
        overallScore: score,
        overallEvalStatus: getEvalStatus(score, this.threshold),
        perInvocationResults,
      };
    }

    // Parity quirk: when there is no score, the reference discards the
    // accumulated per-invocation results and returns an empty result.
    return createEmptyResult();
  }
}

/**
 * The pure mapping and score-extraction helpers, exposed as a single object for
 * unit testing (they are otherwise module-internal). Not part of the supported
 * public API.
 */
export const evalFacadeExportedForTestingOnly = {
  getScore,
  getEvalStatus,
  mapAgentDetailsToAgentConfig,
  getAgentDetails,
  mapInvocationEventToAgentEvent,
  mapInvocationTurn,
  getTurns,
  getAgentData,
};
