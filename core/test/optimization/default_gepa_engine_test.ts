/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The bundled GEPA search engine: the budget it spends, the children it keeps,
 * the parent it reflects on, and the artifact it writes.
 */

import {
  AGENT_PROMPT_NAME,
  DefaultGepaEngine,
  proposeWithReflection,
  renderReflectionPrompt,
  type GepaOptimizeParams,
  type GepaRunResult,
} from '@google/adk';
import {mkdtemp, readdir, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {
  metricCalls,
  parentPrompts,
  ProposingTableAdapter,
  ScriptedReflector,
  TableAdapter,
  type EvaluateCall,
  type ScoreTable,
} from './gepa_engine_test_utils.js';

const SEED_PROMPT = 'Answer the question.';
const BETTER_PROMPT = 'Answer the question with the order id.';
const WORSE_PROMPT = 'Say nothing.';

const VALSET = ['v1', 'v2'];
const TRAINSET = ['t1'];

/** A rewrite that outscores the seed on both example sets. */
const IMPROVING_SCORES: ScoreTable = {
  [SEED_PROMPT]: {v1: 0.2, v2: 0.4, t1: 0.2},
  [BETTER_PROMPT]: {v1: 0.8, v2: 1, t1: 0.9},
};

/** A rewrite the training minibatch rejects. */
const REGRESSING_SCORES: ScoreTable = {
  [SEED_PROMPT]: {v1: 0.2, v2: 0.4, t1: 0.5},
  [WORSE_PROMPT]: {v1: 0.1, v2: 0, t1: 0.1},
};

/** Temp directories a test created, removed after it. */
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, {recursive: true, force: true})),
  );
});

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'adk-gepa-'));
  tempDirs.push(dir);
  return dir;
}

/** Builds the params an engine run takes, with the fields a test overrides. */
function optimizeParams(
  adapter: TableAdapter,
  reflector: ScriptedReflector,
  overrides: Partial<GepaOptimizeParams> = {},
): GepaOptimizeParams {
  return {
    seedCandidate: {[AGENT_PROMPT_NAME]: SEED_PROMPT},
    trainset: TRAINSET,
    valset: VALSET,
    adapter,
    maxMetricCalls: 6,
    reflectionLm: reflector.reflect,
    reflectionMinibatchSize: 1,
    ...overrides,
  };
}

/** Returns the prompt of every candidate the run reported. */
function prompts(result: GepaRunResult): string[] {
  return result.candidates.map((candidate) => candidate[AGENT_PROMPT_NAME]);
}

describe('DefaultGepaEngine input validation', () => {
  const adapter = new TableAdapter(IMPROVING_SCORES);
  const reflector = new ScriptedReflector([BETTER_PROMPT]);

  it('rejects an empty validation set', async () => {
    await expect(
      new DefaultGepaEngine().optimize(
        optimizeParams(adapter, reflector, {valset: []}),
      ),
    ).rejects.toThrow('A GEPA run needs at least one validation example.');
  });

  it('rejects an empty training set', async () => {
    await expect(
      new DefaultGepaEngine().optimize(
        optimizeParams(adapter, reflector, {trainset: []}),
      ),
    ).rejects.toThrow('A GEPA run needs at least one training example.');
  });

  it('rejects a budget too small to score the seed candidate', async () => {
    await expect(
      new DefaultGepaEngine().optimize(
        optimizeParams(adapter, reflector, {maxMetricCalls: 1}),
      ),
    ).rejects.toThrow(
      'A GEPA run needs a budget of at least 2 metric calls to score the ' +
        'seed candidate on the validation set, but maxMetricCalls is 1.',
    );
  });

  it('evaluates nothing when it rejects its inputs', async () => {
    const rejected = new TableAdapter(IMPROVING_SCORES);

    await expect(
      new DefaultGepaEngine().optimize(
        optimizeParams(rejected, reflector, {valset: []}),
      ),
    ).rejects.toThrow();

    expect(rejected.evaluations).toEqual([]);
  });
});

describe('DefaultGepaEngine search', () => {
  it('scores the seed candidate on the validation set first', async () => {
    const adapter = new TableAdapter(IMPROVING_SCORES);

    const result = await new DefaultGepaEngine().optimize(
      optimizeParams(adapter, new ScriptedReflector([BETTER_PROMPT])),
    );

    expect(adapter.evaluations[0]).toEqual({
      batch: VALSET,
      prompt: SEED_PROMPT,
      captureTraces: false,
    });
    expect(prompts(result)[0]).toBe(SEED_PROMPT);
    expect(result.valAggregateScores[0]).toBeCloseTo(0.3);
  });

  it('returns the seed alone when the budget stops at the seed', async () => {
    const adapter = new TableAdapter(IMPROVING_SCORES);

    const result = await new DefaultGepaEngine().optimize(
      optimizeParams(adapter, new ScriptedReflector([BETTER_PROMPT]), {
        maxMetricCalls: 2,
      }),
    );

    expect(prompts(result)).toEqual([SEED_PROMPT]);
    expect(adapter.evaluations).toHaveLength(1);
  });

  it('stops before a round it cannot finish', async () => {
    const adapter = new TableAdapter(IMPROVING_SCORES);

    const result = await new DefaultGepaEngine().optimize(
      optimizeParams(adapter, new ScriptedReflector([BETTER_PROMPT]), {
        maxMetricCalls: 3,
      }),
    );

    expect(prompts(result)).toEqual([SEED_PROMPT]);
    expect(metricCalls(adapter)).toBe(2);
  });

  it('keeps a child that beats its parent and scores it on validation', async () => {
    const adapter = new TableAdapter(IMPROVING_SCORES);

    const result = await new DefaultGepaEngine().optimize(
      optimizeParams(adapter, new ScriptedReflector([BETTER_PROMPT])),
    );

    expect(prompts(result)).toEqual([SEED_PROMPT, BETTER_PROMPT]);
    expect(result.valAggregateScores[1]).toBeCloseTo(0.9);
    expect(adapter.evaluations.at(-1)).toEqual({
      batch: VALSET,
      prompt: BETTER_PROMPT,
      captureTraces: false,
    });
  });

  it('discards a child that does not beat its parent', async () => {
    const adapter = new TableAdapter(REGRESSING_SCORES);

    const result = await new DefaultGepaEngine().optimize(
      optimizeParams(adapter, new ScriptedReflector([WORSE_PROMPT]), {
        maxMetricCalls: 4,
      }),
    );

    expect(prompts(result)).toEqual([SEED_PROMPT]);
    expect(metricCalls(adapter)).toBe(4);
  });

  it('never spends more than maxMetricCalls', async () => {
    const adapter = new TableAdapter(IMPROVING_SCORES);

    await new DefaultGepaEngine().optimize(
      optimizeParams(adapter, new ScriptedReflector([BETTER_PROMPT]), {
        maxMetricCalls: 5,
      }),
    );

    expect(metricCalls(adapter)).toBeLessThanOrEqual(5);
    expect(
      adapter.evaluations.filter(
        (call) => call.prompt === BETTER_PROMPT && !call.captureTraces,
      ),
    ).toEqual([]);
  });

  it('passes the whole training set through when it fits the minibatch', async () => {
    const adapter = new TableAdapter(IMPROVING_SCORES);

    await new DefaultGepaEngine().optimize(
      optimizeParams(adapter, new ScriptedReflector([BETTER_PROMPT]), {
        reflectionMinibatchSize: 5,
      }),
    );

    expect(adapter.evaluations[1].batch).toEqual(TRAINSET);
  });

  it('samples a minibatch when the training set is larger', async () => {
    const scores: ScoreTable = {
      [SEED_PROMPT]: {v1: 0.2, v2: 0.4, t1: 0.1, t2: 0.1, t3: 0.1, t4: 0.1},
      [BETTER_PROMPT]: {v1: 0.8, v2: 1, t1: 0.9, t2: 0.9, t3: 0.9, t4: 0.9},
    };
    const adapter = new TableAdapter(scores);

    await new DefaultGepaEngine({seed: 7}).optimize(
      optimizeParams(adapter, new ScriptedReflector([BETTER_PROMPT]), {
        trainset: ['t1', 't2', 't3', 't4'],
        reflectionMinibatchSize: 2,
        maxMetricCalls: 8,
      }),
    );

    const minibatch = adapter.evaluations[1].batch;
    expect(minibatch).toHaveLength(2);
    expect(new Set(minibatch).size).toBe(2);
    expect(['t1', 't2', 't3', 't4']).toEqual(expect.arrayContaining(minibatch));
  });
});

describe('DefaultGepaEngine proposal', () => {
  it("uses the adapter's proposeNewTexts when it supplies one", async () => {
    const adapter = new ProposingTableAdapter(IMPROVING_SCORES, [
      BETTER_PROMPT,
    ]);
    const reflector = new ScriptedReflector(['never used']);

    const result = await new DefaultGepaEngine().optimize(
      optimizeParams(adapter, reflector),
    );

    expect(adapter.proposals).toBe(1);
    expect(reflector.prompts).toEqual([]);
    expect(prompts(result)).toEqual([SEED_PROMPT, BETTER_PROMPT]);
  });

  it('reflects when the adapter supplies no proposer', async () => {
    const adapter = new TableAdapter(IMPROVING_SCORES);
    const reflector = new ScriptedReflector([`  ${BETTER_PROMPT}  `]);

    const result = await new DefaultGepaEngine().optimize(
      optimizeParams(adapter, reflector),
    );

    expect(reflector.prompts).toHaveLength(1);
    expect(reflector.prompts[0]).toContain(AGENT_PROMPT_NAME);
    expect(reflector.prompts[0]).toContain(SEED_PROMPT);
    expect(prompts(result)).toEqual([SEED_PROMPT, BETTER_PROMPT]);
  });

  it('renders the current text and every feedback row', () => {
    const prompt = renderReflectionPrompt('agent_prompt', 'Current text', [
      {score: 0.5},
      {score: 1},
    ]);

    expect(prompt).toContain('a component named "agent_prompt"');
    expect(prompt).toContain('Current text');
    expect(prompt).toContain('Example 1: {"score":0.5}');
    expect(prompt).toContain('Example 2: {"score":1}');
  });

  it('reflects with no feedback when the dataset holds no rows', async () => {
    const reflector = new ScriptedReflector(['Rewritten']);

    const proposals = await proposeWithReflection(
      {[AGENT_PROMPT_NAME]: SEED_PROMPT},
      {},
      [AGENT_PROMPT_NAME],
      reflector.reflect,
    );

    expect(proposals).toEqual({[AGENT_PROMPT_NAME]: 'Rewritten'});
    expect(reflector.prompts[0]).toContain(SEED_PROMPT);
    expect(reflector.prompts[0]).not.toContain('Example 1');
  });
});

describe('DefaultGepaEngine parent selection', () => {
  /** Scores that keep every candidate on the Pareto front. */
  const FRONT_SCORES: ScoreTable = {
    [SEED_PROMPT]: {v1: 1, v2: 0, t1: 0.2},
    'Rewrite one': {v1: 0.4, v2: 1, t1: 0.5},
    'Rewrite two': {v1: 1, v2: 0, t1: 0.9},
  };

  it("'current-best' reflects on the highest-mean candidate", async () => {
    const adapter = new TableAdapter(FRONT_SCORES);
    const reflector = new ScriptedReflector([
      'Rewrite one',
      'Rewrite two',
      'Rewrite two',
    ]);

    await new DefaultGepaEngine({
      candidateSelectionStrategy: 'current-best',
    }).optimize(
      optimizeParams(adapter, reflector, {
        maxMetricCalls: 12,
      }),
    );

    // Means: seed 0.5, 'Rewrite one' 0.7, 'Rewrite two' 0.5. Round three picks
    // 'Rewrite one' again, which needs both arms of the running maximum.
    expect(parentPrompts(adapter)).toEqual([
      SEED_PROMPT,
      'Rewrite one',
      'Rewrite one',
    ]);
  });

  it("'pareto' keeps every non-dominated candidate selectable", async () => {
    const adapter = new TableAdapter(FRONT_SCORES);
    const reflector = new ScriptedReflector([
      'Rewrite one',
      'Rewrite two',
      'Rewrite two',
    ]);

    const result = await new DefaultGepaEngine({seed: 11}).optimize(
      optimizeParams(adapter, reflector, {maxMetricCalls: 12}),
    );

    expect(prompts(result)).toEqual([
      SEED_PROMPT,
      'Rewrite one',
      'Rewrite two',
    ]);
  });

  it('repeats a run exactly when it is given the same seed', async () => {
    const scores: ScoreTable = {
      ...FRONT_SCORES,
      [SEED_PROMPT]: {v1: 1, v2: 0, t1: 0.2, t2: 0.2, t3: 0.2, t4: 0.2},
      'Rewrite one': {v1: 0.4, v2: 1, t1: 0.5, t2: 0.5, t3: 0.5, t4: 0.5},
      'Rewrite two': {v1: 1, v2: 0, t1: 0.9, t2: 0.9, t3: 0.9, t4: 0.9},
    };
    const params = {
      trainset: ['t1', 't2', 't3', 't4'],
      reflectionMinibatchSize: 2,
      maxMetricCalls: 20,
    };
    const runs: Array<{
      evaluations: EvaluateCall[];
      result: Record<string, unknown>;
    }> = [];
    for (const _run of [0, 1]) {
      const adapter = new TableAdapter(scores);
      const result = await new DefaultGepaEngine({seed: 42}).optimize(
        optimizeParams(
          adapter,
          new ScriptedReflector(['Rewrite one', 'Rewrite two']),
          params,
        ),
      );
      runs.push({evaluations: adapter.evaluations, result: result.toDict()});
    }

    expect(runs[0]).toEqual(runs[1]);
  });
});

describe('DefaultGepaEngine result', () => {
  it('reports the candidates, the best score and the budget spent', async () => {
    const adapter = new TableAdapter(IMPROVING_SCORES);

    const result = await new DefaultGepaEngine().optimize(
      optimizeParams(adapter, new ScriptedReflector([BETTER_PROMPT])),
    );

    expect(result.toDict()).toEqual({
      candidates: [
        {[AGENT_PROMPT_NAME]: SEED_PROMPT},
        {[AGENT_PROMPT_NAME]: BETTER_PROMPT},
      ],
      valAggregateScores: result.valAggregateScores,
      bestScore: Math.max(...result.valAggregateScores),
      totalMetricCalls: 6,
    });
  });

  it('writes the result into runDir', async () => {
    const runDir = await createTempDir();
    const adapter = new TableAdapter(IMPROVING_SCORES);

    const result = await new DefaultGepaEngine().optimize(
      optimizeParams(adapter, new ScriptedReflector([BETTER_PROMPT]), {
        runDir: join(runDir, 'nested'),
      }),
    );

    const written = await readFile(
      join(runDir, 'nested', 'gepa_result.json'),
      'utf8',
    );
    expect(JSON.parse(written)).toEqual(result.toDict());
  });

  it('writes nothing when no runDir is set', async () => {
    const runDir = await createTempDir();

    await new DefaultGepaEngine().optimize(
      optimizeParams(
        new TableAdapter(IMPROVING_SCORES),
        new ScriptedReflector([BETTER_PROMPT]),
      ),
    );

    expect(await readdir(runDir)).toEqual([]);
  });
});
