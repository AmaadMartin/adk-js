/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The bundled GEPA search: its input guards, its budget accounting, its
 * keep-if-better rule, its Pareto parent selection and its result file.
 */

import {
  DefaultGepaEngine,
  type EvaluationBatch,
  type GepaAdapter,
  type GepaOptimizeParams,
  type ReflectionLm,
} from '@google/adk';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';

const AGENT_PROMPT = 'agent_prompt';
const TRAIN_IDS = ['train1', 'train2'];
const VALIDATION_IDS = ['val1', 'val2'];
const SEED_CANDIDATE = {[AGENT_PROMPT]: 'Seed'};

/** One `evaluate` call, as the tests read it back. */
interface EvaluateCall {
  /** The example UIDs the engine scored. */
  batch: string[];

  /** The candidate the engine scored. */
  candidate: Record<string, string>;

  /** Whether the engine asked for trajectories. */
  captureTraces: boolean;
}

/** Options for {@link ScriptedAdapter}. */
interface ScriptedAdapterOptions {
  /** The score of each example UID, by the candidate's agent prompt. */
  scores: Record<string, Record<string, number>>;

  /** Whether the adapter proposes rewrites itself. */
  proposes?: boolean;

  /** The agent prompt each successive proposal returns. */
  proposals?: string[];
}

/** An adapter that scores from a table and records every call. */
class ScriptedAdapter implements GepaAdapter<
  string,
  Record<string, unknown>,
  Record<string, unknown>
> {
  /** Every `evaluate` call, in order. */
  readonly evaluations: EvaluateCall[] = [];

  /** Every candidate `proposeNewTexts` was asked to rewrite, in order. */
  readonly proposalRequests: Array<Record<string, string>> = [];

  readonly proposeNewTexts?: (
    candidate: Record<string, string>,
    reflectiveDataset: Record<string, Array<Record<string, unknown>>>,
    componentsToUpdate: string[],
  ) => Promise<Record<string, string>>;

  private readonly scores: Record<string, Record<string, number>>;
  private readonly proposals: string[];
  private proposalIndex = 0;

  constructor({
    scores,
    proposes = true,
    proposals = [],
  }: ScriptedAdapterOptions) {
    this.scores = scores;
    this.proposals = proposals;
    if (proposes) {
      this.proposeNewTexts = async (candidate) => {
        this.proposalRequests.push(candidate);
        expect(this.proposalIndex).toBeLessThan(this.proposals.length);
        return {[AGENT_PROMPT]: this.proposals[this.proposalIndex++]};
      };
    }
  }

  async evaluate(
    batch: string[],
    candidate: Record<string, string>,
    captureTraces = false,
  ): Promise<
    EvaluationBatch<Record<string, unknown>, Record<string, unknown>>
  > {
    this.evaluations.push({batch, candidate, captureTraces});
    const table = this.scores[candidate[AGENT_PROMPT]];
    expect(table).toBeDefined();
    const scores = batch.map((id) => table[id]);
    return {
      outputs: batch.map(() => ({})),
      scores,
      trajectories: batch.map(() => ({})),
    };
  }

  makeReflectiveDataset(
    _candidate: Record<string, string>,
    evalBatch: EvaluationBatch<
      Record<string, unknown>,
      Record<string, unknown>
    >,
    componentsToUpdate: string[],
  ): Record<string, Array<Record<string, unknown>>> {
    return Object.fromEntries(
      componentsToUpdate.map((component) => [
        component,
        evalBatch.scores.map((score) => ({score})),
      ]),
    );
  }
}

/** An adapter that never touches the engine, to prove a guard ran first. */
const UNTOUCHED_ADAPTER: GepaAdapter<
  string,
  Record<string, unknown>,
  Record<string, unknown>
> = {
  evaluate: () =>
    expect.unreachable('The engine must reject before it scores.'),
  makeReflectiveDataset: () =>
    expect.unreachable('The engine must reject before it reflects.'),
};

/** A reflection model that fails: the tests that use it never reflect. */
const UNUSED_REFLECTION_LM: ReflectionLm = () =>
  expect.unreachable('This run must not reflect.');

/**
 * Builds the engine parameters, defaulting everything the test does not pin.
 *
 * @param overrides The fields the test cares about.
 */
function optimizeParams(
  overrides: Partial<GepaOptimizeParams> & Pick<GepaOptimizeParams, 'adapter'>,
): GepaOptimizeParams {
  return {
    seedCandidate: SEED_CANDIDATE,
    trainset: TRAIN_IDS,
    valset: VALIDATION_IDS,
    maxMetricCalls: 100,
    reflectionLm: UNUSED_REFLECTION_LM,
    reflectionMinibatchSize: 2,
    ...overrides,
  };
}

/** Scores every example in `ids` the same. */
function flatScores(ids: string[], score: number): Record<string, number> {
  return Object.fromEntries(ids.map((id) => [id, score]));
}

const ALL_IDS = [...TRAIN_IDS, ...VALIDATION_IDS];

describe('input guards', () => {
  it('rejects an empty validation set before it scores anything', async () => {
    await expect(
      new DefaultGepaEngine().optimize(
        optimizeParams({adapter: UNTOUCHED_ADAPTER, valset: []}),
      ),
    ).rejects.toThrow('A GEPA run needs at least one validation example.');
  });

  it('rejects an empty training set before it scores anything', async () => {
    await expect(
      new DefaultGepaEngine().optimize(
        optimizeParams({adapter: UNTOUCHED_ADAPTER, trainset: []}),
      ),
    ).rejects.toThrow('A GEPA run needs at least one training example.');
  });

  it('rejects a budget below the validation set size', async () => {
    await expect(
      new DefaultGepaEngine().optimize(
        optimizeParams({adapter: UNTOUCHED_ADAPTER, maxMetricCalls: 1}),
      ),
    ).rejects.toThrow(
      'A GEPA run needs a budget of at least 2 metric calls to score the ' +
        'seed candidate on the validation set, but maxMetricCalls is 1.',
    );
  });
});

describe('the search loop', () => {
  it('returns the seed alone when the budget covers only its validation', async () => {
    const adapter = new ScriptedAdapter({
      scores: {Seed: flatScores(ALL_IDS, 0.5)},
      proposes: false,
    });

    const result = await new DefaultGepaEngine().optimize(
      optimizeParams({adapter, maxMetricCalls: 2}),
    );

    expect(result.candidates).toEqual([SEED_CANDIDATE]);
    expect(result.valAggregateScores).toEqual([0.5]);
    expect(adapter.evaluations).toHaveLength(1);
    expect(adapter.evaluations[0].captureTraces).toBe(false);
  });

  it('validates a child that beats its parent and adds it to the pool', async () => {
    const adapter = new ScriptedAdapter({
      scores: {
        Seed: flatScores(ALL_IDS, 0.5),
        Better: flatScores(ALL_IDS, 0.9),
      },
      proposals: ['Better'],
    });

    const result = await new DefaultGepaEngine({seed: 1}).optimize(
      optimizeParams({adapter, maxMetricCalls: 8}),
    );

    expect(result.candidates).toEqual([
      SEED_CANDIDATE,
      {[AGENT_PROMPT]: 'Better'},
    ]);
    expect(result.valAggregateScores).toEqual([0.5, 0.9]);
    expect(adapter.evaluations.map((call) => call.batch)).toEqual([
      VALIDATION_IDS,
      TRAIN_IDS,
      TRAIN_IDS,
      VALIDATION_IDS,
    ]);
    expect(adapter.evaluations[1].captureTraces).toBe(true);
  });

  it('discards a child that ties its parent, without a validation pass', async () => {
    const adapter = new ScriptedAdapter({
      scores: {Seed: flatScores(ALL_IDS, 0.5), Tied: flatScores(ALL_IDS, 0.5)},
      proposals: ['Tied'],
    });

    const result = await new DefaultGepaEngine({seed: 1}).optimize(
      optimizeParams({adapter, maxMetricCalls: 6}),
    );

    expect(result.candidates).toEqual([SEED_CANDIDATE]);
    expect(adapter.evaluations).toHaveLength(3);
  });

  it('discards a child that loses to its parent', async () => {
    const adapter = new ScriptedAdapter({
      scores: {Seed: flatScores(ALL_IDS, 0.5), Worse: flatScores(ALL_IDS, 0.1)},
      proposals: ['Worse'],
    });

    const result = await new DefaultGepaEngine({seed: 1}).optimize(
      optimizeParams({adapter, maxMetricCalls: 6}),
    );

    expect(result.candidates).toEqual([SEED_CANDIDATE]);
    expect(adapter.evaluations).toHaveLength(3);
  });

  it('drops a winning child it cannot afford to validate', async () => {
    const adapter = new ScriptedAdapter({
      scores: {
        Seed: flatScores(ALL_IDS, 0.5),
        Better: flatScores(ALL_IDS, 0.9),
      },
      proposals: ['Better'],
    });

    const result = await new DefaultGepaEngine({seed: 1}).optimize(
      optimizeParams({adapter, maxMetricCalls: 7}),
    );

    expect(result.candidates).toEqual([SEED_CANDIDATE]);
    expect(result.toDict()).toMatchObject({totalMetricCalls: 6});
  });

  it('never spends more metric calls than the budget allows', async () => {
    const adapter = new ScriptedAdapter({
      scores: {Seed: flatScores(ALL_IDS, 0.5), Tied: flatScores(ALL_IDS, 0.5)},
      proposals: Array.from({length: 8}, () => 'Tied'),
    });

    const result = await new DefaultGepaEngine({seed: 1}).optimize(
      optimizeParams({adapter, maxMetricCalls: 15}),
    );

    const spent = adapter.evaluations.reduce(
      (total, call) => total + call.batch.length,
      0,
    );
    expect(spent).toBeLessThanOrEqual(15);
    expect(result.toDict()).toMatchObject({totalMetricCalls: spent});
  });

  it('reflects over the whole training set when it is no larger than the minibatch', async () => {
    const adapter = new ScriptedAdapter({
      scores: {Seed: flatScores(ALL_IDS, 0.5), Tied: flatScores(ALL_IDS, 0.5)},
      proposals: ['Tied'],
    });

    await new DefaultGepaEngine({seed: 1}).optimize(
      optimizeParams({adapter, maxMetricCalls: 6, reflectionMinibatchSize: 5}),
    );

    expect(adapter.evaluations[1].batch).toEqual(TRAIN_IDS);
  });

  it('samples a minibatch smaller than the training set', async () => {
    const trainset = ['t1', 't2', 't3', 't4'];
    const adapter = new ScriptedAdapter({
      scores: {
        Seed: flatScores([...trainset, ...VALIDATION_IDS], 0.5),
        Tied: flatScores([...trainset, ...VALIDATION_IDS], 0.5),
      },
      proposals: ['Tied'],
    });

    await new DefaultGepaEngine({seed: 7}).optimize(
      optimizeParams({
        adapter,
        trainset,
        maxMetricCalls: 6,
        reflectionMinibatchSize: 2,
      }),
    );

    const minibatch = adapter.evaluations[1].batch;
    expect(minibatch).toHaveLength(2);
    expect(new Set(minibatch).size).toBe(2);
    expect(trainset).toEqual(expect.arrayContaining(minibatch));
  });
});

describe('determinism', () => {
  /** Runs one search and reports the minibatch of each reflection round. */
  async function minibatchSequence(seed: number): Promise<string[][]> {
    const trainset = ['t1', 't2', 't3', 't4', 't5'];
    const adapter = new ScriptedAdapter({
      scores: {
        Seed: flatScores([...trainset, ...VALIDATION_IDS], 0.5),
        Tied: flatScores([...trainset, ...VALIDATION_IDS], 0.5),
      },
      proposals: Array.from({length: 6}, () => 'Tied'),
    });

    await new DefaultGepaEngine({seed}).optimize(
      optimizeParams({
        adapter,
        trainset,
        maxMetricCalls: 18,
        reflectionMinibatchSize: 2,
      }),
    );
    return adapter.evaluations.slice(1).map((call) => call.batch);
  }

  it('repeats the same sequence for the same seed', async () => {
    expect(await minibatchSequence(42)).toEqual(await minibatchSequence(42));
  });

  it('is free to differ between two seeds', async () => {
    const first = await minibatchSequence(1);
    const second = await minibatchSequence(2);

    expect(first).toHaveLength(second.length);
  });
});

describe('Pareto selection', () => {
  it('keeps a candidate that is worse on average but better on one example', async () => {
    // Seed scores [1, 0]; Specialist scores [0, 1] on the validation set.
    // Neither dominates the other, so both stay on the front.
    const adapter = new ScriptedAdapter({
      scores: {
        Seed: {train1: 0.1, train2: 0.1, val1: 1, val2: 0},
        Specialist: {train1: 0.9, train2: 0.9, val1: 0, val2: 1},
      },
      proposals: ['Specialist'],
    });

    const result = await new DefaultGepaEngine({seed: 1}).optimize(
      optimizeParams({adapter, maxMetricCalls: 8}),
    );

    expect(result.candidates).toHaveLength(2);
    expect(result.valAggregateScores).toEqual([0.5, 0.5]);
  });

  it('reflects on the surviving candidate when one dominates the other', async () => {
    const adapter = new ScriptedAdapter({
      scores: {
        Seed: {train1: 0.1, train2: 0.1, val1: 0.2, val2: 0.2},
        Dominant: {train1: 0.9, train2: 0.9, val1: 0.8, val2: 0.8},
        Third: flatScores(ALL_IDS, 0.95),
      },
      proposals: ['Dominant', 'Third'],
    });

    await new DefaultGepaEngine({seed: 1}).optimize(
      optimizeParams({adapter, maxMetricCalls: 12}),
    );

    expect(adapter.proposalRequests[1]).toEqual({[AGENT_PROMPT]: 'Dominant'});
  });
});

describe('the fallback proposer', () => {
  it('asks the reflection model when the adapter proposes nothing', async () => {
    const prompts: string[] = [];
    const adapter = new ScriptedAdapter({
      scores: {
        Seed: flatScores(ALL_IDS, 0.5),
        Rewritten: flatScores(ALL_IDS, 0.9),
      },
      proposes: false,
    });

    const result = await new DefaultGepaEngine({seed: 1}).optimize(
      optimizeParams({
        adapter,
        maxMetricCalls: 8,
        reflectionLm: async (prompt) => {
          prompts.push(prompt);
          return '  Rewritten  ';
        },
      }),
    );

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain(`a component named "${AGENT_PROMPT}"`);
    expect(prompts[0]).toContain('Seed');
    expect(prompts[0]).toContain('Example 1: {"score":0.5}');
    expect(result.candidates[1]).toEqual({[AGENT_PROMPT]: 'Rewritten'});
  });

  it('renders an empty reflection dataset for a component it has no rows for', async () => {
    const prompts: string[] = [];
    const adapter: GepaAdapter<
      string,
      Record<string, unknown>,
      Record<string, unknown>
    > = {
      evaluate: async (batch) => ({
        outputs: batch.map(() => ({})),
        scores: batch.map(() => 0.5),
        trajectories: batch.map(() => ({})),
      }),
      makeReflectiveDataset: () => ({}),
    };

    await new DefaultGepaEngine({seed: 1}).optimize(
      optimizeParams({
        adapter,
        maxMetricCalls: 6,
        reflectionLm: async (prompt) => {
          prompts.push(prompt);
          return 'Rewritten';
        },
      }),
    );

    expect(prompts[0]).toContain('score (higher is better)');
  });
});

describe('the result file', () => {
  let runDir: string | undefined;

  afterEach(async () => {
    if (runDir !== undefined) {
      await rm(runDir, {recursive: true, force: true});
      runDir = undefined;
    }
  });

  it('writes gepa_result.json under a nested runDir', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'adk-gepa-run-'));
    runDir = parent;
    const nested = join(parent, 'run', 'one');
    const adapter = new ScriptedAdapter({
      scores: {Seed: flatScores(ALL_IDS, 0.5)},
      proposes: false,
    });

    const result = await new DefaultGepaEngine().optimize(
      optimizeParams({adapter, maxMetricCalls: 2, runDir: nested}),
    );

    const written = JSON.parse(
      await readFile(join(nested, 'gepa_result.json'), 'utf8'),
    );
    expect(written).toEqual(result.toDict());
    expect(written).toEqual({
      candidates: [SEED_CANDIDATE],
      valAggregateScores: [0.5],
      bestScore: 0.5,
      totalMetricCalls: 2,
    });
  });

  it('writes nothing when no runDir is configured', async () => {
    const adapter = new ScriptedAdapter({
      scores: {Seed: flatScores(ALL_IDS, 0.5)},
      proposes: false,
    });

    const result = await new DefaultGepaEngine().optimize(
      optimizeParams({adapter, maxMetricCalls: 2}),
    );

    expect(result.toDict()).toEqual({
      candidates: [SEED_CANDIDATE],
      valAggregateScores: [0.5],
      bestScore: 0.5,
      totalMetricCalls: 2,
    });
  });
});

describe('the unseeded generator', () => {
  it('runs the search with Math.random', async () => {
    const adapter = new ScriptedAdapter({
      scores: {Seed: flatScores(ALL_IDS, 0.5), Tied: flatScores(ALL_IDS, 0.5)},
      proposals: ['Tied'],
    });

    const result = await new DefaultGepaEngine().optimize(
      optimizeParams({adapter, maxMetricCalls: 6}),
    );

    expect(result.candidates).toEqual([SEED_CANDIDATE]);
  });
});
