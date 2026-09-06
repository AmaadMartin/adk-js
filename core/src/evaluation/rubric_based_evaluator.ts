/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {InputValidationError} from '../errors/input_validation_error.js';
import type {LlmResponse} from '../models/llm_response.js';
import {experimental} from '../utils/experimental.js';
import {logger} from '../utils/logger.js';
import type {RubricsBasedCriterion} from './eval_metrics.js';
import type {Rubric, RubricScore} from './eval_rubrics.js';
import type {EvaluationResult, PerInvocationResult} from './evaluator.js';
import {getEvalStatus, getTextFromContent} from './evaluator.js';
import type {AutoRaterScore, LlmAsJudgeOptions} from './llm_as_judge.js';
import {LlmAsJudge} from './llm_as_judge.js';
import {getAverageRubricScore} from './llm_as_judge_utils.js';

/** One rubric's verdict, as parsed out of the auto-rater's response. */
export interface RubricResponse {
  /** The rubric id the auto-rater echoed back, when it echoed one. */
  rubricId?: string;

  /** The rubric text the auto-rater assessed, as it wrote it. */
  propertyText?: string;

  /** The auto-rater's reasoning for its verdict. */
  rationale?: string;

  /** 1 for a yes verdict, 0 for a no one, absent for anything else. */
  score?: number;
}

/** Parses the auto-rater's response text into per-rubric verdicts. */
export interface AutoRaterResponseParser {
  /** Returns one entry per rubric the auto-rater assessed. */
  parse(autoRaterResponse: string): RubricResponse[];
}

/**
 * Folds the repeated samples of one invocation into a single result.
 *
 * A judge model carries a degree of unreliability, so a rubric metric asks it
 * the same question several times. An aggregator decides what those samples
 * say together.
 */
export interface PerInvocationResultsAggregator {
  aggregate(
    perInvocationSamples: PerInvocationResult[],
    threshold: number,
  ): PerInvocationResult;
}

/** Folds the per-invocation results of one eval case into the overall one. */
export interface InvocationResultsSummarizer {
  summarize(
    perInvocationResults: PerInvocationResult[],
    threshold: number,
  ): EvaluationResult;
}

const ID_PATTERN = /^\s*ID: (.*)$/gm;
const PROPERTY_PATTERN = /^\s*Property: (.*)$/gm;
const RATIONALE_PATTERN = /(?<=Rationale: )(.*)/g;
const VERDICT_PATTERN = /(?<=Verdict: )(.*)/g;

/** Returns the score a verdict line awards, absent when it awards none. */
function parseVerdictScore(verdict: string): number | undefined {
  const lowered = verdict.toLowerCase();
  if (lowered.includes('yes')) {
    return 1;
  }
  if (lowered.includes('no')) {
    return 0;
  }
  return undefined;
}

/**
 * Returns the id the auto-rater wrote for the property at `propertyIndex`.
 *
 * An id belongs to the property it immediately precedes, not to the property
 * at the same ordinal, so that a property that omits its id cannot take the
 * next property's id.
 */
function findRubricIdForProperty(
  idMatches: RegExpExecArray[],
  propertyMatches: RegExpExecArray[],
  propertyIndex: number,
): string | undefined {
  const previousStart =
    propertyIndex > 0 ? propertyMatches[propertyIndex - 1].index : -1;
  const propertyStart = propertyMatches[propertyIndex].index;

  let rubricId: string | undefined;
  for (const idMatch of idMatches) {
    if (idMatch.index > previousStart && idMatch.index < propertyStart) {
      rubricId = idMatch[1].trim() || undefined;
    }
  }
  return rubricId;
}

/**
 * Reads the `Property` / `ID` / `Rationale` / `Verdict` blocks a judge model
 * is asked to write.
 */
export class DefaultAutoRaterResponseParser implements AutoRaterResponseParser {
  parse(autoRaterResponse: string): RubricResponse[] {
    const propertyMatches = [...autoRaterResponse.matchAll(PROPERTY_PATTERN)];
    const idMatches = [...autoRaterResponse.matchAll(ID_PATTERN)];
    const rationales = [...autoRaterResponse.matchAll(RATIONALE_PATTERN)];
    const scores = [...autoRaterResponse.matchAll(VERDICT_PATTERN)].map(
      (verdict) => parseVerdictScore(verdict[1]),
    );

    // A partial parse can silently omit a failed rubric and inflate the score.
    if (
      propertyMatches.length !== rationales.length ||
      propertyMatches.length !== scores.length
    ) {
      return [];
    }

    return propertyMatches.map((propertyMatch, index) => ({
      rubricId: findRubricIdForProperty(idMatches, propertyMatches, index),
      propertyText: propertyMatch[1].trim(),
      rationale: rationales[index][1].trim(),
      score: scores[index],
    }));
  }
}

/** The samples of one rubric, split by the verdict they carry. */
interface VerdictBuckets {
  /** Samples the auto-rater did not score. */
  unscored: RubricScore[];

  /** Samples scored 1. */
  positives: RubricScore[];

  /** Samples scored anything else. */
  negatives: RubricScore[];
}

/**
 * Groups every sample's rubric scores by rubric id, in the order the ids were
 * first seen.
 */
function bucketSamplesByRubricId(
  perInvocationSamples: PerInvocationResult[],
): Map<string, VerdictBuckets> {
  const bucketsByRubricId = new Map<string, VerdictBuckets>();

  for (const sample of perInvocationSamples) {
    for (const rubricScore of sample.rubricScores ?? []) {
      let buckets = bucketsByRubricId.get(rubricScore.rubricId);
      if (buckets === undefined) {
        buckets = {unscored: [], positives: [], negatives: []};
        bucketsByRubricId.set(rubricScore.rubricId, buckets);
      }

      if (rubricScore.score === undefined) {
        buckets.unscored.push(rubricScore);
      } else if (rubricScore.score === 1) {
        buckets.positives.push(rubricScore);
      } else {
        buckets.negatives.push(rubricScore);
      }
    }
  }

  return bucketsByRubricId;
}

/** Returns the sample that wins the vote for one rubric. */
function winningSample(buckets: VerdictBuckets): RubricScore {
  if (buckets.positives.length === 0 && buckets.negatives.length === 0) {
    return buckets.unscored[0];
  }
  // A tie loses: the metric only reports a rubric as met when more samples say
  // it was met than say it was not.
  return buckets.positives.length > buckets.negatives.length
    ? buckets.positives[0]
    : buckets.negatives[0];
}

/**
 * Settles each rubric by majority vote over the samples of one invocation.
 *
 * The winning sample is carried over whole, so the invocation keeps a
 * rationale the judge model actually wrote.
 */
export class MajorityVotePerInvocationResultsAggregator implements PerInvocationResultsAggregator {
  aggregate(
    perInvocationSamples: PerInvocationResult[],
    threshold: number,
  ): PerInvocationResult {
    const rubricScores = [
      ...bucketSamplesByRubricId(perInvocationSamples).values(),
    ].map(winningSample);
    const score = getAverageRubricScore(rubricScores);

    return {
      actualInvocation: perInvocationSamples[0].actualInvocation,
      expectedInvocation: perInvocationSamples[0].expectedInvocation,
      score,
      rubricScores,
      evalStatus: getEvalStatus(score, threshold),
    };
  }
}

/**
 * The rationale reported for an aggregated rubric score.
 *
 * A mean has no reasoning behind it, so the summarizer says so rather than
 * promote one sample's rationale to the whole set.
 */
const AGGREGATED_RATIONALE =
  'This is an aggregated score derived from individual entries. Please refer' +
  ' to individual entries in each invocation for actual rationale from the' +
  ' model.';

/** Groups every rubric score of an eval case by rubric id, in first-seen order. */
function groupScoresByRubricId(
  perInvocationResults: PerInvocationResult[],
): Map<string, RubricScore[]> {
  const scoresByRubricId = new Map<string, RubricScore[]>();

  for (const result of perInvocationResults) {
    for (const rubricScore of result.rubricScores ?? []) {
      const scores = scoresByRubricId.get(rubricScore.rubricId) ?? [];
      scores.push(rubricScore);
      scoresByRubricId.set(rubricScore.rubricId, scores);
    }
  }

  return scoresByRubricId;
}

/**
 * Averages each rubric across the invocations of one eval case.
 *
 * The overall score is the mean over every observation, so an invocation that
 * assessed more rubrics counts for more than one that assessed fewer.
 */
export class MeanInvocationResultsSummarizer implements InvocationResultsSummarizer {
  summarize(
    perInvocationResults: PerInvocationResult[],
    threshold: number,
  ): EvaluationResult {
    const scoresByRubricId = groupScoresByRubricId(perInvocationResults);

    const overallRubricScores = [...scoresByRubricId.entries()].map(
      ([rubricId, rubricScores]) => ({
        rubricId,
        score: getAverageRubricScore(rubricScores),
        rationale: AGGREGATED_RATIONALE,
      }),
    );
    const overallScore = getAverageRubricScore(
      [...scoresByRubricId.values()].flat(),
    );

    return {
      overallScore,
      overallEvalStatus: getEvalStatus(overallScore, threshold),
      perInvocationResults,
      overallRubricScores,
    };
  }
}

const SMART_CHARS: Readonly<Record<string, string>> = {
  '\u2018': "'",
  '\u2019': "'",
  '\u201c': '"',
  '\u201d': '"',
  '\u2013': '-',
  '\u2014': '-',
};
const SMART_CHARS_PATTERN = /[\u2018\u2019\u201c\u201d\u2013\u2014]/g;
const WHITESPACE_PATTERN = /\s+/g;
const DECORATION_PATTERN = /^[ *_`#>\-\u2022"']+|[ *_`#>\-\u2022"']+$/g;

/**
 * Returns a comparable form of judge output or rubric text.
 *
 * Judge models routinely wrap the rubric text they echo back in markdown and
 * typographic decoration, which would otherwise defeat the exact-match lookup.
 */
function normalizeText(text?: string): string {
  if (text === undefined) {
    return '';
  }
  return text
    .normalize('NFKC')
    .replace(SMART_CHARS_PATTERN, (smartChar) => SMART_CHARS[smartChar])
    .replace(WHITESPACE_PATTERN, ' ')
    .replace(DECORATION_PATTERN, '')
    .toLowerCase();
}

/** How a {@link RubricBasedEvaluator} is configured. */
export interface RubricBasedEvaluatorOptions extends LlmAsJudgeOptions<RubricsBasedCriterion> {
  /** Reads the auto-rater's text. Defaults to the Property/Verdict parser. */
  autoRaterResponseParser?: AutoRaterResponseParser;

  /** Settles one invocation's samples. Defaults to majority vote. */
  perInvocationResultsAggregator?: PerInvocationResultsAggregator;

  /** Settles the eval case. Defaults to the mean over every observation. */
  invocationResultsSummarizer?: InvocationResultsSummarizer;

  /** Invocation and case level rubrics are filtered by this type. */
  rubricType?: string;
}

/** Adds `rubricsToAdd` to `rubricsById`, rejecting an id it already holds. */
function addRubrics(
  rubricsById: Map<string, Rubric>,
  rubricsToAdd: Rubric[],
  scopeName: string,
): void {
  for (const rubric of rubricsToAdd) {
    if (rubricsById.has(rubric.rubricId)) {
      throw new InputValidationError(
        `Rubric with rubric_id '${rubric.rubricId}' already exists. Rubric` +
          ` defined in ${scopeName} conflicts with an existing rubric.`,
      );
    }
    rubricsById.set(rubric.rubricId, rubric);
  }
}

/**
 * A base class for metrics that score an agent against written rubrics.
 *
 * A subclass supplies only the auto-rater prompt. This class asks the judge
 * model for one Property/Rationale/Verdict block per rubric, reads the
 * verdicts back, settles each invocation by majority vote over its samples,
 * and averages the invocations into the eval case's score.
 */
@experimental
export abstract class RubricBasedEvaluator extends LlmAsJudge<RubricsBasedCriterion> {
  private readonly rubrics: Rubric[];
  private readonly rubricType?: string;
  private readonly autoRaterResponseParser: AutoRaterResponseParser;
  private readonly perInvocationResultsAggregator: PerInvocationResultsAggregator;
  private readonly invocationResultsSummarizer: InvocationResultsSummarizer;
  private effectiveRubricsList?: Rubric[];

  constructor(options: RubricBasedEvaluatorOptions) {
    super(options);
    this.rubricType = options.rubricType;
    this.autoRaterResponseParser =
      options.autoRaterResponseParser ?? new DefaultAutoRaterResponseParser();
    this.perInvocationResultsAggregator =
      options.perInvocationResultsAggregator ??
      new MajorityVotePerInvocationResultsAggregator();
    this.invocationResultsSummarizer =
      options.invocationResultsSummarizer ??
      new MeanInvocationResultsSummarizer();
    this.rubrics = this.criterion.rubrics ?? [];
  }

  /**
   * Combines the criterion's rubrics with the invocation's own, replacing any
   * list a previous call built.
   *
   * @param invocationRubrics The rubrics carried by the invocation being
   *   graded. Filtered by `rubricType` when the metric names one.
   * @throws {InputValidationError} When a rubric id appears twice, or the
   *   combined list is empty.
   */
  createEffectiveRubricsList(invocationRubrics?: Rubric[]): void {
    const rubricsById = new Map<string, Rubric>();
    addRubrics(rubricsById, this.rubrics, 'criterion');

    if (invocationRubrics) {
      const filtered =
        this.rubricType === undefined
          ? invocationRubrics
          : invocationRubrics.filter(
              (rubric) => rubric.type === this.rubricType,
            );
      addRubrics(rubricsById, filtered, 'invocation');
    }

    if (rubricsById.size === 0) {
      throw new InputValidationError('Rubrics are required.');
    }
    this.effectiveRubricsList = [...rubricsById.values()];
  }

  /**
   * Returns the rubrics this metric grades against.
   *
   * @throws {InputValidationError} When called before
   *   {@link createEffectiveRubricsList}.
   */
  getEffectiveRubricsList(): Rubric[] {
    if (this.effectiveRubricsList === undefined) {
      throw new InputValidationError(
        'Effective rubrics list not initialized. Call' +
          ' createEffectiveRubricsList() first.',
      );
    }
    return this.effectiveRubricsList;
  }

  /**
   * Reads one auto-rater response into a score per rubric.
   *
   * The response is model output, so nothing here throws: text that carries no
   * verdicts, and a verdict naming a rubric the metric does not hold, are
   * logged and dropped.
   */
  override convertAutoRaterResponseToScore(
    autoRaterResponse: LlmResponse,
  ): AutoRaterScore {
    const rubricScores = this.resolveRubricResponses(
      this.parseAutoRaterResponse(
        getTextFromContent(autoRaterResponse.content),
      ),
    );
    return {score: getAverageRubricScore(rubricScores), rubricScores};
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

  /** Parses the auto-rater's text, reporting text that yielded no verdicts. */
  private parseAutoRaterResponse(responseText: string): RubricResponse[] {
    if (responseText === '') {
      logger.warn(
        'Auto-rater returned an empty response; no rubric verdicts could be' +
          ' parsed and this sample will not be scored.',
      );
      return [];
    }

    const rubricResponses = this.autoRaterResponseParser.parse(responseText);
    if (rubricResponses.length === 0) {
      logger.warn(
        'Auto-rater response did not match the expected' +
          ' Property/Rationale/Verdict format; no rubric verdicts were' +
          ` parsed. Raw auto-rater response: ${responseText}`,
      );
    }
    return rubricResponses;
  }

  /**
   * Binds each parsed verdict to the rubric it assessed, by echoed id first
   * and by normalized rubric text second. A verdict that names neither is
   * logged and dropped.
   */
  private resolveRubricResponses(
    rubricResponses: RubricResponse[],
  ): RubricScore[] {
    const effectiveRubrics = this.getEffectiveRubricsList();
    const rubricById = new Map(
      effectiveRubrics.map((rubric) => [rubric.rubricId, rubric]),
    );
    const rubricByNormalizedText = new Map(
      effectiveRubrics.map((rubric) => [
        normalizeText(rubric.rubricContent.textProperty),
        rubric,
      ]),
    );

    const rubricScores: RubricScore[] = [];
    for (const rubricResponse of rubricResponses) {
      const rubric =
        (rubricResponse.rubricId === undefined
          ? undefined
          : rubricById.get(rubricResponse.rubricId)) ??
        rubricByNormalizedText.get(normalizeText(rubricResponse.propertyText));

      if (rubric === undefined) {
        logger.warn(
          `Rubric ${rubricResponse.propertyText} not found in the rubrics` +
            ' provided to the metric.',
        );
        continue;
      }
      rubricScores.push({
        rubricId: rubric.rubricId,
        rationale: rubricResponse.rationale,
        score: rubricResponse.score,
      });
    }

    return rubricScores;
  }
}
