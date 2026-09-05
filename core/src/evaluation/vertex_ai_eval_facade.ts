/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content, Tool} from '@google/genai';

import {InputValidationError} from '../errors/input_validation_error.js';
import {ConversationScenario} from './conversation_scenarios.js';
import {Invocation, isInvocationEvents} from './eval_case.js';
import {EvalStatus} from './eval_metrics.js';
import {
  emptyEvaluationResult,
  EvaluationResult,
  Evaluator,
  getEvalStatus,
  getTextFromContent,
  PerInvocationResult,
  validateInvocationLengths,
} from './evaluator.js';

/** The author the service expects on the event that carries a user message. */
const USER_AUTHOR = 'user';

/** The author the service expects on the event that carries the reply. */
const AGENT_AUTHOR = 'agent';

const ERROR_MESSAGE_SUFFIX = `
You should specify both project id and location. This metric uses the Vertex AI
Gen AI evaluation service, and it requires google cloud credentials.

If using an .env file add the values there, or explicitly set in the code using
the template below:

process.env.GOOGLE_CLOUD_LOCATION = '<LOCATION>'
process.env.GOOGLE_CLOUD_PROJECT = '<PROJECT ID>'
`;

/** One prompt/response pair to score, with an optional golden reference. */
export interface VertexEvalCaseRow {
  prompt: string;
  reference?: string;
  response: string;
}

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

/**
 * The data submitted in one evaluation request. Exactly one field is set: a
 * single-turn metric scores the rows of {@link evalDataset}, a multi-turn
 * metric scores the conversation in {@link evalCases}.
 */
export interface VertexEvaluationDataset {
  evalDataset?: VertexEvalCaseRow[];
  evalCases?: VertexEvalCase[];
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

/** How a client reaches the service, as read from the environment. */
export type VertexAiEvalClientConfig =
  | {apiKey: string}
  | {project: string; location: string};

/** Options for a {@link VertexAiEvalFacade}. */
export interface VertexAiEvalFacadeOptions {
  /** The score at or above which an invocation passes. */
  threshold: number;

  /** The name of the metric to request from the service. */
  metricName: string;

  /** Whether the metric needs golden invocations. Defaults to false. */
  expectedInvocationsRequired?: boolean;

  /**
   * The client that reaches the service. Build one from the environment with
   * {@link resolveVertexAiEvalClientConfig}.
   */
  client: VertexAiEvalClient;
}

/**
 * Reads the service configuration from the environment.
 *
 * An API key wins over a project and location, as in `google/adk-python`. An
 * empty value reads as an absent one.
 *
 * @throws {InputValidationError} When the environment names neither an API
 *   key nor both a project and a location.
 */
export function resolveVertexAiEvalClientConfig(
  env: Record<string, string | undefined> = process.env,
): VertexAiEvalClientConfig {
  const apiKey = env['GOOGLE_API_KEY'];
  const project = env['GOOGLE_CLOUD_PROJECT'];
  const location = env['GOOGLE_CLOUD_LOCATION'];

  if (apiKey) {
    return {apiKey};
  }
  if (project || location) {
    if (!project) {
      throw new InputValidationError(
        'Missing project id.' + ERROR_MESSAGE_SUFFIX,
      );
    }
    if (!location) {
      throw new InputValidationError(
        'Missing location.' + ERROR_MESSAGE_SUFFIX,
      );
    }
    return {project, location};
  }

  throw new InputValidationError(
    'Either API Key or Google cloud Project id and location should be' +
      ' specified.',
  );
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

  const intermediateData = invocation.intermediateData;
  if (intermediateData !== undefined && isInvocationEvents(intermediateData)) {
    for (const event of intermediateData.invocationEvents) {
      events.push({author: event.author, content: event.content});
    }
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
 * The state both facades over the Vertex AI Gen AI evaluation service share.
 *
 * A facade reaches the service through the {@link VertexAiEvalClient} it is
 * given, and the caller owns how that client is built and authenticated.
 */
export abstract class VertexAiEvalFacade implements Evaluator {
  protected readonly threshold: number;
  protected readonly metricName: string;
  protected readonly expectedInvocationsRequired: boolean;
  protected readonly client: VertexAiEvalClient;

  constructor(options: VertexAiEvalFacadeOptions) {
    this.threshold = options.threshold;
    this.metricName = options.metricName;
    this.expectedInvocationsRequired =
      options.expectedInvocationsRequired ?? false;
    this.client = options.client;
  }

  abstract evaluateInvocations(
    actualInvocations: Invocation[],
    expectedInvocations?: Invocation[],
    conversationScenario?: ConversationScenario,
  ): Promise<EvaluationResult>;
}

/**
 * Scores invocations one at a time with a single-turn metric of the Vertex AI
 * Gen AI evaluation service.
 */
export class SingleTurnVertexAiEvalFacade extends VertexAiEvalFacade {
  /**
   * @param _conversationScenario Ignored: a single-turn metric scores one
   *   invocation at a time, so the scenario the conversation followed says
   *   nothing about the score.
   * @throws InputValidationError if the metric needs golden invocations and
   *     none are given, or if the two lists have different lengths.
   */
  async evaluateInvocations(
    actualInvocations: Invocation[],
    expectedInvocations?: Invocation[],
    _conversationScenario?: ConversationScenario,
  ): Promise<EvaluationResult> {
    if (this.expectedInvocationsRequired && expectedInvocations === undefined) {
      throw new InputValidationError(
        'expectedInvocations is needed by this metric.',
      );
    }
    validateInvocationLengths(actualInvocations, expectedInvocations);

    const perInvocationResults: PerInvocationResult[] = [];
    let totalScore = 0;
    let scoredInvocations = 0;
    for (const [index, actual] of actualInvocations.entries()) {
      const expected = expectedInvocations?.[index];
      const result = await this.client.evaluate({
        dataset: {
          evalDataset: [
            {
              prompt: getTextFromContent(actual.userContent),
              reference: expected
                ? getTextFromContent(expected.finalResponse)
                : undefined,
              response: getTextFromContent(actual.finalResponse),
            },
          ],
        },
        metrics: [{name: this.metricName}],
      });

      const score = getScore(result);
      if (score !== undefined) {
        totalScore += score;
        scoredInvocations++;
      }
      perInvocationResults.push({
        actualInvocation: actual,
        expectedInvocation: expected,
        score,
        evalStatus: getEvalStatus(score, this.threshold),
      });
    }

    if (perInvocationResults.length === 0) {
      return emptyEvaluationResult();
    }

    const overallScore =
      scoredInvocations > 0 ? totalScore / scoredInvocations : undefined;
    return {
      overallScore,
      overallEvalStatus: getEvalStatus(overallScore, this.threshold),
      perInvocationResults,
    };
  }
}

/**
 * Scores a whole conversation with a multi-turn metric of the Vertex AI Gen AI
 * evaluation service.
 *
 * The service reads every turn but scores the conversation as a whole, so one
 * request covers the conversation and only its last turn carries the score.
 * The leading turns come back `NOT_EVALUATED`.
 */
export class MultiTurnVertexAiEvalFacade extends VertexAiEvalFacade {
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
        score: undefined,
        evalStatus: EvalStatus.NOT_EVALUATED,
      }));

    const result = await this.client.evaluate({
      dataset: {evalCases: [{agentData: getAgentData(actualInvocations)}]},
      metrics: [{name: this.metricName}],
    });

    const lastTurn = actualInvocations.length - 1;
    const score = getScore(result);
    perInvocationResults.push({
      actualInvocation: actualInvocations[lastTurn],
      expectedInvocation: expectedInvocations?.[lastTurn],
      score,
      evalStatus: getEvalStatus(score, this.threshold),
    });

    if (score === undefined) {
      // Parity with adk-python: an unscored conversation reports nothing at
      // all, and the per-invocation results accumulated above are discarded.
      return emptyEvaluationResult();
    }

    return {
      overallScore: score,
      overallEvalStatus: getEvalStatus(score, this.threshold),
      perInvocationResults,
    };
  }
}
