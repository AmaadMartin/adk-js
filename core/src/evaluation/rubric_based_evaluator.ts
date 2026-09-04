/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {InputValidationError} from '../errors/input_validation_error.js';
import {BaseLlm} from '../models/base_llm.js';
import {LlmResponse} from '../models/llm_response.js';
import {experimental} from '../utils/experimental.js';
import {logger} from '../utils/logger.js';
import {
  EvalMetric,
  ParsedRubricsBasedCriterion,
  parseRubricsBasedCriterion,
} from './eval_metrics.js';
import {Rubric, RubricScore} from './eval_rubrics.js';
import {
  EvaluationResult,
  PerInvocationResult,
  getEvalStatus,
  getTextFromContent,
} from './evaluator.js';
import {AutoRaterScore, LlmAsJudge} from './llm_as_judge.js';
import {getAverageRubricScore} from './llm_as_judge_utils.js';

/** One rubric's verdict, as read out of the auto-rater's response text. */
export interface RubricResponse {
  /** The rubric id the auto-rater echoed, when it echoed one. */
  rubricId?: string;

  /** The property text the auto-rater echoed. */
  propertyText?: string;

  /** The auto-rater's reasoning for its verdict. */
  rationale?: string;

  /** 1.0 for a `yes`, 0.0 for a `no`, absent for anything else. */
  score?: number;
}

/** Reads rubric verdicts out of an auto-rater's response text. */
export interface AutoRaterResponseParser {
  parse(autoRaterResponse: string): RubricResponse[];
}

/**
 * Folds the repeated samples of one invocation into a single result.
 *
 * A judge model is unreliable enough that one invocation is sampled several
 * times, and the samples have to be reconciled into one verdict.
 */
export interface PerInvocationResultsAggregator {
  aggregate(
    perInvocationSamples: PerInvocationResult[],
    threshold: number,
  ): PerInvocationResult;
}

/** Folds the per-invocation results of an eval case into one result. */
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

/** Returns the score a verdict line carries, absent when it carries none. */
function scoreFromVerdict(verdict: string): number | undefined {
  const lowered = verdict.toLowerCase();
  if (lowered.includes('yes')) {
    return 1.0;
  }
  if (lowered.includes('no')) {
    return 0.0;
  }
  return undefined;
}

/**
 * Returns the id the auto-rater wrote for the property starting at
 * `propertyStart`, which is the last id between the previous property and
 * this one.
 *
 * Matching by offset rather than by index keeps a later id from shifting onto
 * an earlier property whose own id the auto-rater omitted.
 */
function findRubricId(
  idMatches: RegExpExecArray[],
  previousPropertyStart: number,
  propertyStart: number,
): string | undefined {
  let rubricId: string | undefined;
  for (const idMatch of idMatches) {
    if (
      previousPropertyStart < idMatch.index &&
      idMatch.index < propertyStart
    ) {
      rubricId = idMatch[1].trim() || undefined;
    }
  }
  return rubricId;
}

/** Reads the `ID`/`Property`/`Rationale`/`Verdict` blocks a judge writes. */
export class DefaultAutoRaterResponseParser implements AutoRaterResponseParser {
  parse(autoRaterResponse: string): RubricResponse[] {
    const propertyMatches = [...autoRaterResponse.matchAll(PROPERTY_PATTERN)];
    const idMatches = [...autoRaterResponse.matchAll(ID_PATTERN)];
    const rationales = [...autoRaterResponse.matchAll(RATIONALE_PATTERN)];
    const verdicts = [...autoRaterResponse.matchAll(VERDICT_PATTERN)];

    // A partial parse would silently omit a failed rubric and inflate the
    // score, so an incomplete response scores nothing at all.
    if (
      propertyMatches.length !== rationales.length ||
      propertyMatches.length !== verdicts.length
    ) {
      return [];
    }

    return propertyMatches.map((propertyMatch, index) => ({
      rubricId: findRubricId(
        idMatches,
        index > 0 ? propertyMatches[index - 1].index : -1,
        propertyMatch.index,
      ),
      propertyText: propertyMatch[1].trim(),
      rationale: rationales[index][0].trim(),
      score: scoreFromVerdict(verdicts[index][0]),
    }));
  }
}

/** How the samples of one rubric voted. */
interface RubricVotes {
  /** Samples that scored nothing. */
  unscored: RubricScore[];

  /** Samples that scored 1.0. */
  positives: RubricScore[];

  /** Samples that scored anything else. */
  negatives: RubricScore[];
}

function votesFor(
  votesByRubricId: Map<string, RubricVotes>,
  rubricId: string,
): RubricVotes {
  const votes = votesByRubricId.get(rubricId) ?? {
    unscored: [],
    positives: [],
    negatives: [],
  };
  votesByRubricId.set(rubricId, votes);
  return votes;
}

/** Returns the sample that wins the vote for one rubric. */
function winningVote(votes: RubricVotes): RubricScore {
  if (votes.positives.length === 0 && votes.negatives.length === 0) {
    return votes.unscored[0];
  }
  // A tie goes to the negative verdict.
  return votes.positives.length > votes.negatives.length
    ? votes.positives[0]
    : votes.negatives[0];
}

/**
 * Settles each rubric by majority vote across the samples of one invocation.
 *
 * A rubric that no sample scored stays unscored, rather than counting as a
 * failure.
 */
export class MajorityVotePerInvocationResultsAggregator implements PerInvocationResultsAggregator {
  aggregate(
    perInvocationSamples: PerInvocationResult[],
    threshold: number,
  ): PerInvocationResult {
    const votesByRubricId = new Map<string, RubricVotes>();
    for (const sample of perInvocationSamples) {
      for (const rubricScore of sample.rubricScores ?? []) {
        const votes = votesFor(votesByRubricId, rubricScore.rubricId);
        if (rubricScore.score === undefined) {
          votes.unscored.push(rubricScore);
        } else if (rubricScore.score === 1.0) {
          votes.positives.push(rubricScore);
        } else {
          votes.negatives.push(rubricScore);
        }
      }
    }

    const rubricScores = [...votesByRubricId.values()].map(winningVote);
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
 * The rationale reported for an aggregated rubric score. A mean has no model
 * reasoning behind it, so the summarizer says so instead of promoting one
 * sample's rationale to the whole set.
 */
const AGGREGATED_SCORE_RATIONALE =
  'This is an aggregated score derived from individual entries. Please refer' +
  ' to individual entries in each invocation for actual rationale from the' +
  ' model.';

/**
 * Averages each rubric's score across the invocations of an eval case.
 *
 * The overall score is the mean over every rubric observation rather than the
 * mean of the per-rubric means, so a rubric that was assessed more often
 * weighs more.
 */
export class MeanInvocationResultsSummarizer implements InvocationResultsSummarizer {
  summarize(
    perInvocationResults: PerInvocationResult[],
    threshold: number,
  ): EvaluationResult {
    const everyRubricScore: RubricScore[] = [];
    const scoresByRubricId = new Map<string, RubricScore[]>();
    for (const result of perInvocationResults) {
      for (const rubricScore of result.rubricScores ?? []) {
        const scores = scoresByRubricId.get(rubricScore.rubricId) ?? [];
        scores.push(rubricScore);
        scoresByRubricId.set(rubricScore.rubricId, scores);
        everyRubricScore.push(rubricScore);
      }
    }

    const overallRubricScores = [...scoresByRubricId].map(
      ([rubricId, scores]) => ({
        rubricId,
        score: getAverageRubricScore(scores),
        rationale: AGGREGATED_SCORE_RATIONALE,
      }),
    );
    const overallScore = getAverageRubricScore(everyRubricScore);
    return {
      overallScore,
      overallEvalStatus: getEvalStatus(overallScore, threshold),
      perInvocationResults,
      overallRubricScores,
    };
  }
}

const SMART_CHARS: Record<string, string> = {
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
 * Returns a normalized form of a rubric property, for matching one the judge
 * echoed against one the metric supplied.
 *
 * Judge models routinely wrap the rubric text they echo back in markdown and
 * typographic decoration, which would otherwise defeat the exact-match
 * lookup.
 */
function normalizeText(text?: string): string {
  if (text === undefined) {
    return '';
  }
  return text
    .normalize('NFKC')
    .replace(SMART_CHARS_PATTERN, (char) => SMART_CHARS[char])
    .replace(WHITESPACE_PATTERN, ' ')
    .replace(DECORATION_PATTERN, '')
    .toLowerCase();
}

/** How a {@link RubricBasedEvaluator} is configured. */
export interface RubricBasedEvaluatorOptions {
  evalMetric: EvalMetric;

  /** Reads rubric verdicts out of the judge's response text. */
  autoRaterResponseParser?: AutoRaterResponseParser;

  /** Folds the repeated samples of one invocation into a single result. */
  perInvocationResultsAggregator?: PerInvocationResultsAggregator;

  /** Folds the per-invocation results into the overall result. */
  invocationResultsSummarizer?: InvocationResultsSummarizer;

  /** Invocation and case level rubrics are filtered by this type. */
  rubricType?: string;

  /**
   * The judge model to grade with. Resolved from `LLMRegistry` when absent.
   */
  judgeModel?: BaseLlm;
}

/**
 * A base class for metrics that grade an agent against written rubrics.
 *
 * A concrete metric supplies the judge prompt; this class owns the rubrics
 * the prompt names, reads the judge's verdicts back, and folds them into a
 * score. Each rubric scores 1.0 or 0.0, and the invocation scores the mean of
 * the rubrics that were assessed.
 */
@experimental
export abstract class RubricBasedEvaluator extends LlmAsJudge<ParsedRubricsBasedCriterion> {
  private readonly rubricType?: string;
  private readonly autoRaterResponseParser: AutoRaterResponseParser;
  private readonly perInvocationResultsAggregator: PerInvocationResultsAggregator;
  private readonly invocationResultsSummarizer: InvocationResultsSummarizer;

  /** The rubrics the criterion carries. */
  private readonly criterionRubrics: Rubric[];

  /** The rubrics of the invocation being graded, once they are known. */
  private effectiveRubrics?: Rubric[];

  constructor(options: RubricBasedEvaluatorOptions) {
    super({
      evalMetric: options.evalMetric,
      parseCriterion: parseRubricsBasedCriterion,
      judgeModel: options.judgeModel,
    });
    this.rubricType = options.rubricType;
    this.autoRaterResponseParser =
      options.autoRaterResponseParser ?? new DefaultAutoRaterResponseParser();
    this.perInvocationResultsAggregator =
      options.perInvocationResultsAggregator ??
      new MajorityVotePerInvocationResultsAggregator();
    this.invocationResultsSummarizer =
      options.invocationResultsSummarizer ??
      new MeanInvocationResultsSummarizer();
    this.criterionRubrics = this.criterion.rubrics;
  }

  /**
   * Resolves the rubrics that apply to one invocation: the criterion's own,
   * plus the invocation's that carry the metric's rubric type.
   *
   * Calling it again replaces the previous list, so the same evaluator grades
   * a series of invocations that each carry their own rubrics.
   *
   * @throws {InputValidationError} When two rubrics share an id, or no rubric
   *   applies.
   */
  createEffectiveRubricsList(invocationRubrics?: Rubric[]): void {
    const rubricsById = new Map<string, Rubric>();
    addRubrics(rubricsById, this.criterionRubrics, 'criterion');
    if (invocationRubrics !== undefined) {
      addRubrics(
        rubricsById,
        this.rubricType === undefined
          ? invocationRubrics
          : invocationRubrics.filter((r) => r.type === this.rubricType),
        'invocation',
      );
    }

    if (rubricsById.size === 0) {
      throw new InputValidationError('Rubrics are required.');
    }
    this.effectiveRubrics = [...rubricsById.values()];
  }

  /**
   * Returns the rubrics that apply to the invocation being graded.
   *
   * @throws {InputValidationError} When called before
   *   {@link createEffectiveRubricsList}.
   */
  getEffectiveRubricsList(): Rubric[] {
    if (this.effectiveRubrics === undefined) {
      throw new InputValidationError(
        'Effective rubrics list not initialized. Call' +
          ' createEffectiveRubricsList() first.',
      );
    }
    return this.effectiveRubrics;
  }

  /**
   * Scores one judge response: one verdict per rubric the judge named, and
   * their mean as the sample's score.
   *
   * A verdict naming a rubric the metric did not supply is logged and
   * dropped, so a judge that invents a rubric cannot move the score.
   */
  override convertAutoRaterResponseToScore(
    autoRaterResponse: LlmResponse,
  ): AutoRaterScore {
    const rubricResponses = this.parseRubricResponses(
      getTextFromContent(autoRaterResponse.content),
    );

    const rubricById = new Map<string, Rubric>();
    const rubricByNormalizedText = new Map<string, Rubric>();
    for (const rubric of this.getEffectiveRubricsList()) {
      rubricById.set(rubric.rubricId, rubric);
      rubricByNormalizedText.set(
        normalizeText(rubric.rubricContent.textProperty),
        rubric,
      );
    }

    const rubricScores: RubricScore[] = [];
    for (const rubricResponse of rubricResponses) {
      const rubric =
        (rubricResponse.rubricId
          ? rubricById.get(rubricResponse.rubricId)
          : undefined) ??
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

  /** Reads the judge's verdicts, reporting a response it cannot read. */
  private parseRubricResponses(responseText: string): RubricResponse[] {
    if (!responseText) {
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
}

/**
 * Adds each rubric under its id.
 *
 * @throws {InputValidationError} When an id is already taken.
 */
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
