/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {LlmResponse} from '../models/llm_response.js';
import {experimental} from '../utils/experimental.js';
import {logger} from '../utils/logger.js';

import {
  EvalMetric,
  RubricsBasedCriterion,
  RubricsBasedCriterionSchema,
} from './eval_metrics.js';
import {Rubric, RubricScore} from './eval_rubrics.js';
import {EvaluationResult, PerInvocationResult} from './evaluator.js';
import {AutoRaterScore, LlmAsJudge} from './llm_as_judge.js';
import {
  getAverageRubricScore,
  getEvalStatus,
  getTextFromContent,
} from './llm_as_judge_utils.js';

const AGGREGATED_RATIONALE =
  'This is an aggregated score derived from individual entries. Please refer' +
  ' to individual entries in each invocation for actual rationale from the' +
  ' model.';

const ID_PATTERN = /^\s*ID: (.*)$/gm;
const PROPERTY_PATTERN = /^\s*Property: (.*)$/gm;
const RATIONALE_PATTERN = /(?<=Rationale: )(.*)/g;
const VERDICT_PATTERN = /(?<=Verdict: )(.*)/g;

/** A single rubric's response parsed from the auto-rater output. */
export interface RubricResponse {
  rubricId?: string;
  propertyText?: string;
  rationale?: string;
  score?: number;
}

/** Parses an auto-rater's textual response into per-rubric responses. */
export interface AutoRaterResponseParser {
  parse(autoRaterResponse: string): RubricResponse[];
}

/** Returns the start index of a regex match (always present for `matchAll`). */
function matchStart(match: RegExpMatchArray): number {
  return match.index ?? 0;
}

/** The default {@link AutoRaterResponseParser} implementation. */
export class DefaultAutoRaterResponseParser implements AutoRaterResponseParser {
  parse(autoRaterResponse: string): RubricResponse[] {
    const propertyMatches = [...autoRaterResponse.matchAll(PROPERTY_PATTERN)];
    const idMatches = [...autoRaterResponse.matchAll(ID_PATTERN)];
    const rationales = [...autoRaterResponse.matchAll(RATIONALE_PATTERN)].map(
      (match) => match[0],
    );
    const scores: Array<number | undefined> = [];
    for (const verdictMatch of autoRaterResponse.matchAll(VERDICT_PATTERN)) {
      const verdict = verdictMatch[0].toLowerCase();
      if (verdict.includes('yes')) {
        scores.push(1.0);
      } else if (verdict.includes('no')) {
        scores.push(0.0);
      } else {
        scores.push(undefined);
      }
    }

    // A partial parse can silently omit a failed rubric and inflate the score.
    if (
      !(
        propertyMatches.length === rationales.length &&
        rationales.length === scores.length
      )
    ) {
      return [];
    }

    const rubricResponses: RubricResponse[] = [];
    for (let i = 0; i < propertyMatches.length; i++) {
      const propertyMatch = propertyMatches[i];
      // Match each id to the property it immediately precedes (not by index) so
      // an omitted id line can't shift a later id onto an earlier property.
      const previousStart = i > 0 ? matchStart(propertyMatches[i - 1]) : -1;
      let rubricId: string | undefined;
      for (const idMatch of idMatches) {
        const start = matchStart(idMatch);
        if (previousStart < start && start < matchStart(propertyMatch)) {
          rubricId = idMatch[1].trim() || undefined;
        }
      }
      rubricResponses.push({
        rubricId,
        propertyText: propertyMatch[1].trim(),
        rationale: rationales[i].trim(),
        score: scores[i],
      });
    }
    return rubricResponses;
  }
}

/**
 * Aggregates repeated per-invocation samples into a single result.
 *
 * LLM-backed auto-raters have some degree of unreliability, so an invocation is
 * sampled more than once; this converts those samples into one result.
 */
export interface PerInvocationResultsAggregator {
  aggregate(
    perInvocationSamples: PerInvocationResult[],
    threshold: number,
  ): PerInvocationResult;
}

/** Aggregates per-invocation samples using majority vote (tie => negative). */
export class MajorityVotePerInvocationResultsAggregator implements PerInvocationResultsAggregator {
  aggregate(
    perInvocationSamples: PerInvocationResult[],
    threshold: number,
  ): PerInvocationResult {
    // Per rubric id, bucket scores into: no-score, positive (1.0), negative.
    const scoresByRubricId = new Map<
      string,
      [RubricScore[], RubricScore[], RubricScore[]]
    >();
    for (const sample of perInvocationSamples) {
      if (!sample.rubricScores) {
        continue;
      }
      for (const rubricScore of sample.rubricScores) {
        let buckets = scoresByRubricId.get(rubricScore.rubricId);
        if (!buckets) {
          buckets = [[], [], []];
          scoresByRubricId.set(rubricScore.rubricId, buckets);
        }
        if (rubricScore.score === undefined) {
          buckets[0].push(rubricScore);
        } else if (rubricScore.score === 1.0) {
          buckets[1].push(rubricScore);
        } else {
          buckets[2].push(rubricScore);
        }
      }
    }

    const aggregatedRubricScores: RubricScore[] = [];
    for (const [, [noScores, positives, negatives]] of scoresByRubricId) {
      if (positives.length === 0 && negatives.length === 0) {
        // There has to be at least a no-score rubric here.
        aggregatedRubricScores.push(noScores[0]);
      } else if (positives.length > negatives.length) {
        aggregatedRubricScores.push(positives[0]);
      } else {
        aggregatedRubricScores.push(negatives[0]);
      }
    }

    const aggregatedOverallScore = getAverageRubricScore(
      aggregatedRubricScores,
    );
    return {
      actualInvocation: perInvocationSamples[0].actualInvocation,
      expectedInvocation: perInvocationSamples[0].expectedInvocation,
      score: aggregatedOverallScore,
      rubricScores: aggregatedRubricScores,
      evalStatus: getEvalStatus(aggregatedOverallScore, threshold),
    };
  }
}

/** Summarizes per-invocation results into a single case-level result. */
export interface InvocationResultsSummarizer {
  summarize(
    perInvocationResults: PerInvocationResult[],
    threshold: number,
  ): EvaluationResult;
}

/** Summarizes per-invocation results using the mean rubric score. */
export class MeanInvocationResultsSummarizer implements InvocationResultsSummarizer {
  summarize(
    perInvocationResults: PerInvocationResult[],
    threshold: number,
  ): EvaluationResult {
    const unaggregatedRubricScores: RubricScore[] = [];
    const rubricScoresById = new Map<string, RubricScore[]>();
    for (const sample of perInvocationResults) {
      if (!sample.rubricScores) {
        continue;
      }
      for (const rubricScore of sample.rubricScores) {
        let scores = rubricScoresById.get(rubricScore.rubricId);
        if (!scores) {
          scores = [];
          rubricScoresById.set(rubricScore.rubricId, scores);
        }
        scores.push(rubricScore);
        unaggregatedRubricScores.push(rubricScore);
      }
    }

    const aggregatedRubricScores: RubricScore[] = [];
    for (const [rubricId, rubricScores] of rubricScoresById) {
      aggregatedRubricScores.push({
        rubricId,
        score: getAverageRubricScore(rubricScores),
        rationale: AGGREGATED_RATIONALE,
      });
    }

    // Use the unaggregated rubric scores to compute the overall score.
    const aggregatedOverallScore = getAverageRubricScore(
      unaggregatedRubricScores,
    );
    return {
      overallScore: aggregatedOverallScore,
      overallEvalStatus: getEvalStatus(aggregatedOverallScore, threshold),
      perInvocationResults,
      overallRubricScores: aggregatedRubricScores,
    };
  }
}

/** Returns a normalized version of the given text (non-strings become ''). */
function normalizeText(text: unknown): string {
  if (typeof text !== 'string') {
    return '';
  }
  return text.toLowerCase().trim();
}

/**
 * Base class for rubric-based evaluators.
 */
@experimental
export abstract class RubricBasedEvaluator extends LlmAsJudge<RubricsBasedCriterion> {
  private readonly rubricType?: string;
  private readonly autoRaterResponseParser: AutoRaterResponseParser;
  private readonly perInvocationResultsAggregator: PerInvocationResultsAggregator;
  private readonly invocationResultsSummarizer: InvocationResultsSummarizer;
  private readonly rubrics: Rubric[];
  private effectiveRubricsList?: Rubric[];

  constructor(
    evalMetric: EvalMetric,
    rubricType?: string,
    autoRaterResponseParser: AutoRaterResponseParser = new DefaultAutoRaterResponseParser(),
    perInvocationResultsAggregator: PerInvocationResultsAggregator = new MajorityVotePerInvocationResultsAggregator(),
    invocationResultsSummarizer: InvocationResultsSummarizer = new MeanInvocationResultsSummarizer(),
  ) {
    super(evalMetric, RubricsBasedCriterionSchema, 'RubricsBasedCriterion');
    this.rubricType = rubricType;
    this.autoRaterResponseParser = autoRaterResponseParser;
    this.perInvocationResultsAggregator = perInvocationResultsAggregator;
    this.invocationResultsSummarizer = invocationResultsSummarizer;
    // RubricsBasedCriterion always defaults `rubrics` to an array via its schema.
    this.rubrics = this.criterion.rubrics;
  }

  createEffectiveRubricsList(invocationRubrics?: Rubric[]): void {
    const rubricsById = new Map<string, Rubric>();
    const addRubrics = (rubricsToAdd: Rubric[], scopeName: string): void => {
      for (const rubric of rubricsToAdd) {
        if (rubricsById.has(rubric.rubricId)) {
          throw new Error(
            `Rubric with rubric_id '${rubric.rubricId}' already exists. Rubric` +
              ` defined in ${scopeName} conflicts with an existing rubric.`,
          );
        }
        rubricsById.set(rubric.rubricId, rubric);
      }
    };

    addRubrics(this.rubrics, 'criterion');
    if (invocationRubrics) {
      const filtered = this.rubricType
        ? invocationRubrics.filter((rubric) => rubric.type === this.rubricType)
        : invocationRubrics;
      addRubrics(filtered, 'invocation');
    }

    this.effectiveRubricsList = [...rubricsById.values()];
    if (this.effectiveRubricsList.length === 0) {
      throw new Error('Rubrics are required.');
    }
  }

  getEffectiveRubricsList(): Rubric[] {
    if (this.effectiveRubricsList === undefined) {
      throw new Error(
        'Effective rubrics list not initialized. Call' +
          ' createEffectiveRubricsList() first.',
      );
    }
    return this.effectiveRubricsList;
  }

  override convertAutoRaterResponseToScore(
    autoRaterResponse: LlmResponse,
  ): AutoRaterScore {
    const responseText = getTextFromContent(autoRaterResponse.content);
    let rubricResponses: RubricResponse[];
    if (!responseText) {
      logger.warn(
        'Auto-rater returned an empty response; no rubric verdicts could be' +
          ' parsed and this sample will not be scored.',
      );
      rubricResponses = [];
    } else {
      rubricResponses = this.autoRaterResponseParser.parse(responseText);
      if (rubricResponses.length === 0) {
        logger.warn(
          'Auto-rater response did not match the expected' +
            ' Property/Rationale/Verdict format; no rubric verdicts were' +
            ' parsed. Raw auto-rater response:',
          responseText,
        );
      }
    }

    const normalizedRubricToRubric = new Map<string, Rubric>();
    const rubricById = new Map<string, Rubric>();
    for (const rubric of this.getEffectiveRubricsList()) {
      normalizedRubricToRubric.set(
        normalizeText(rubric.rubricContent.textProperty),
        rubric,
      );
      rubricById.set(rubric.rubricId, rubric);
    }

    const rubricScores: RubricScore[] = [];
    for (const rubricResponse of rubricResponses) {
      let rubric: Rubric | undefined;
      if (rubricResponse.rubricId) {
        rubric = rubricById.get(rubricResponse.rubricId);
      }
      if (!rubric) {
        rubric = normalizedRubricToRubric.get(
          normalizeText(rubricResponse.propertyText),
        );
      }
      if (rubric) {
        rubricScores.push({
          rubricId: rubric.rubricId,
          rationale: rubricResponse.rationale,
          score: rubricResponse.score,
        });
      } else {
        logger.warn(
          `Rubric ${rubricResponse.propertyText} not found in the rubrics` +
            ' provided to the metric.',
        );
      }
    }

    const aggregatedScore = getAverageRubricScore(rubricScores);
    return {score: aggregatedScore, rubricScores};
  }

  override aggregatePerInvocationSamples(
    perInvocationSamples: PerInvocationResult[],
  ): PerInvocationResult {
    return this.perInvocationResultsAggregator.aggregate(
      perInvocationSamples,
      this.threshold,
    );
  }

  override aggregateInvocationResults(
    perInvocationResults: PerInvocationResult[],
  ): EvaluationResult {
    return this.invocationResultsSummarizer.summarize(
      perInvocationResults,
      this.threshold,
    );
  }
}
