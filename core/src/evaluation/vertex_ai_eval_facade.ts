/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content, Tool} from '@google/genai';

import {ConversationScenario} from './conversation_scenarios.js';
import {Invocation} from './eval_case.js';
import {EvalStatus} from './eval_metrics.js';
import {
  emptyEvaluationResult,
  EvaluationResult,
  Evaluator,
  getEvalStatus,
  PerInvocationResult,
  validateInvocationLengths,
} from './evaluator.js';

/** The author the service expects on the event that carries a user message. */
const USER_AUTHOR = 'user';

/** The author the service expects on the event that carries the reply. */
const AGENT_AUTHOR = 'agent';

/** One agent of the app under test, as the service describes it. */
export interface VertexAgentConfig {
  agentId: string;
  instruction?: string;
  tools?: Tool[];
}

/** One event inside a conversation turn. */
export interface VertexAgentEvent {
  author: string;
  content?: Content;
}

/** One turn of the conversation, from the user's message to the reply. */
export interface VertexConversationTurn {
  turnIndex: number;
  events: VertexAgentEvent[];
  turnId?: string;
}

/** The agent-centric view of a conversation. */
export interface VertexAgentData {
  /** The agents of the app, keyed by agent name. */
  agents: Record<string, VertexAgentConfig>;
  turns: VertexConversationTurn[];
}

/** One eval case of a multi-turn request. */
export interface VertexEvalCase {
  agentData: VertexAgentData;
}

/** The data submitted in one evaluation request. */
export interface VertexEvaluationDataset {
  evalCases: VertexEvalCase[];
}

/** The name of a metric to run over the dataset. */
export interface VertexEvalMetricSpec {
  name: string;
}

/** A metric result aggregated over the rows of the dataset. */
export interface VertexAggregatedMetricResult {
  meanScore?: number;
}

/** The result of one evaluation request. */
export interface VertexEvaluationResult {
  summaryMetrics?: VertexAggregatedMetricResult[];
}

/** One evaluation request. */
export interface VertexAiEvalRequest {
  dataset: VertexEvaluationDataset;
  metrics: VertexEvalMetricSpec[];
}

/**
 * The Vertex AI Gen AI evaluation service, as this package uses it.
 *
 * The service has no JavaScript SDK, so the caller supplies the transport and
 * owns authentication.
 */
export interface VertexAiEvalClient {
  evaluate(request: VertexAiEvalRequest): Promise<VertexEvaluationResult>;
}

/** Options for a {@link MultiTurnVertexAiEvalFacade}. */
export interface VertexAiEvalFacadeOptions {
  /** The score at or above which an invocation passes. */
  threshold: number;

  /** The name of the metric to request from the service. */
  metricName: string;

  /** The client that reaches the service. */
  client: VertexAiEvalClient;
}

/** Reads the mean score of the first summary metric, when there is one. */
function getScore(result: VertexEvaluationResult): number | undefined {
  const meanScore = result.summaryMetrics?.[0]?.meanScore;
  return Number.isFinite(meanScore) ? meanScore : undefined;
}

/**
 * Collects the agents that served the conversation, keyed by agent name.
 *
 * An agent that several turns declare is described by the first turn that
 * declares it.
 */
function getAgentConfigs(
  invocations: Invocation[],
): Record<string, VertexAgentConfig> {
  const agentConfigs: Record<string, VertexAgentConfig> = {};
  for (const invocation of invocations) {
    for (const [name, details] of Object.entries(
      invocation.appDetails?.agentDetails ?? {},
    )) {
      if (!(name in agentConfigs)) {
        agentConfigs[name] = {
          agentId: details.name,
          instruction: details.instructions,
          tools: details.toolDeclarations,
        };
      }
    }
  }
  return agentConfigs;
}

/** Maps one invocation onto a turn, as `[user, ...intermediate, agent]`. */
function mapInvocationTurn(
  turnIndex: number,
  invocation: Invocation,
): VertexConversationTurn {
  const events: VertexAgentEvent[] = [
    {author: USER_AUTHOR, content: invocation.userContent},
  ];

  for (const event of invocation.intermediateData?.invocationEvents ?? []) {
    events.push({author: event.author, content: event.content});
  }

  events.push({author: AGENT_AUTHOR, content: invocation.finalResponse});

  return {turnIndex, events, turnId: invocation.invocationId};
}

/** Maps a conversation onto the agent-centric view the service scores. */
function getAgentData(invocations: Invocation[]): VertexAgentData {
  return {
    agents: getAgentConfigs(invocations),
    turns: invocations.map((invocation, index) =>
      mapInvocationTurn(index, invocation),
    ),
  };
}

/**
 * Scores a whole conversation with a multi-turn metric of the Vertex AI Gen AI
 * evaluation service.
 *
 * The service reads every turn but scores the conversation as a whole, so one
 * request covers the conversation and only its last turn carries the score.
 * The leading turns come back `NOT_EVALUATED`.
 *
 * The facade reaches the service through the {@link VertexAiEvalClient} it is
 * given, and the caller owns how that client is built and authenticated.
 */
export class MultiTurnVertexAiEvalFacade implements Evaluator {
  private readonly threshold: number;
  private readonly metricName: string;
  private readonly client: VertexAiEvalClient;

  constructor(options: VertexAiEvalFacadeOptions) {
    this.threshold = options.threshold;
    this.metricName = options.metricName;
    this.client = options.client;
  }

  /**
   * @param _conversationScenario Ignored: the service derives what it needs
   *   from the turns themselves. The parameter is on the shared contract, so
   *   the same caller drives a scenario-aware metric and this one.
   * @throws InputValidationError if the two lists have different lengths.
   */
  async evaluateInvocations(
    actualInvocations: Invocation[],
    expectedInvocations?: Invocation[],
    _conversationScenario?: ConversationScenario,
  ): Promise<EvaluationResult> {
    validateInvocationLengths(actualInvocations, expectedInvocations);
    if (actualInvocations.length === 0) {
      return emptyEvaluationResult();
    }

    const perInvocationResults: PerInvocationResult[] = actualInvocations
      .slice(0, -1)
      .map((actual, index) => ({
        actualInvocation: actual,
        expectedInvocation: expectedInvocations?.[index],
        evalStatus: EvalStatus.NOT_EVALUATED,
      }));

    const result = await this.client.evaluate({
      dataset: {evalCases: [{agentData: getAgentData(actualInvocations)}]},
      metrics: [{name: this.metricName}],
    });

    const score = getScore(result);
    if (score === undefined) {
      // Parity with adk-python: an unscored conversation reports nothing at
      // all, so the leading turns collected above are discarded too.
      return emptyEvaluationResult();
    }

    const evalStatus = getEvalStatus(score, this.threshold);
    const lastTurn = actualInvocations.length - 1;
    perInvocationResults.push({
      actualInvocation: actualInvocations[lastTurn],
      expectedInvocation: expectedInvocations?.[lastTurn],
      score,
      evalStatus,
    });

    return {
      overallScore: score,
      overallEvalStatus: evalStatus,
      perInvocationResults,
    };
  }
}
