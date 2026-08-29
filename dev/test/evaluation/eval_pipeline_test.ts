/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseLlm,
  BaseLlmConnection,
  FunctionTool,
  InMemorySessionService,
  LlmAgent,
  LlmRequest,
  LlmResponse,
} from '@google/adk';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {z} from 'zod';
import {
  getEvaluationCriteriaOrDefault,
  parseAndGetEvalsToRun,
} from '../../src/cli/cli_eval.js';
import {runEvals} from '../../src/evaluation/eval_runner.js';
import {
  EvalResult,
  EvalStatus,
  RESPONSE_MATCH_SCORE_KEY,
  TOOL_TRAJECTORY_SCORE_KEY,
} from '../../src/evaluation/eval_types.js';

/**
 * The whole eval flow over a real `LlmAgent`, a real `Runner` and a real
 * `InMemorySessionService`, with only the model replaced. The unit tests stub
 * the generator, so nothing else proves the pieces fit together.
 */

/** The number of sides the stub model always asks for. */
const ROLLED_SIDES = 6;

/**
 * A model that calls `roll_die` once, then answers with the die's result.
 *
 * It decides which to do from the conversation rather than from a call
 * counter, so it behaves the same however many eval cases run through it.
 */
class RollDieLlm extends BaseLlm {
  constructor() {
    super({model: 'roll-die-stub'});
  }

  async *generateContentAsync(
    request: LlmRequest,
  ): AsyncGenerator<LlmResponse, void, void> {
    const answer = findToolAnswer(request);
    yield answer === undefined
      ? {
          content: {
            role: 'model',
            parts: [
              {
                functionCall: {
                  id: 'fc-roll-die',
                  name: 'roll_die',
                  args: {sides: ROLLED_SIDES},
                },
              },
            ],
          },
        }
      : {content: {role: 'model', parts: [{text: `You rolled a ${answer}.`}]}};
  }

  async connect(_request: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error('RollDieLlm does not support live mode.');
  }
}

/** The `roll` the tool (or its mock) already returned, if it has. */
function findToolAnswer(request: LlmRequest): unknown {
  for (const content of request.contents ?? []) {
    for (const part of content.parts ?? []) {
      const response = part.functionResponse?.response;
      if (response && 'result' in response) {
        return (response as {result: unknown}).result;
      }
    }
  }
  return undefined;
}

/** Every `sides` value the real tool was asked for, newest last. */
let realToolCalls: number[];

function buildAgent(): LlmAgent {
  return new LlmAgent({
    name: 'hello_world',
    model: new RollDieLlm(),
    instruction: 'Roll dice for the user.',
    tools: [
      new FunctionTool({
        name: 'roll_die',
        description: 'Rolls a die with the given number of sides.',
        parameters: z.object({sides: z.number()}),
        execute: ({sides}) => {
          realToolCalls.push(sides);
          return {result: 1};
        },
      }),
    ],
  });
}

/**
 * Two cases over the same agent. `passing_case` expects the call the model
 * makes; `failing_case` expects a 20-sided die, which the model never rolls.
 */
const EVAL_SET = [
  {
    name: 'passing_case',
    data: [
      {
        query: 'Roll a die.',
        expected_tool_use: [
          {
            tool_name: 'roll_die',
            tool_input: {sides: ROLLED_SIDES},
            mock_tool_output: {result: 4},
          },
        ],
      },
    ],
  },
  {
    name: 'failing_case',
    data: [
      {
        query: 'Roll a twenty-sided die.',
        expected_tool_use: [
          {
            tool_name: 'roll_die',
            tool_input: {sides: 20},
            mock_tool_output: {result: 17},
          },
        ],
      },
    ],
  },
];

let tempDir: string;
let evalSetPath: string;
let configPath: string;

beforeEach(async () => {
  realToolCalls = [];
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eval-pipeline-'));
  evalSetPath = path.join(tempDir, 'roll_die.evalset.json');
  configPath = path.join(tempDir, 'test_config.json');
  await fs.writeFile(evalSetPath, JSON.stringify(EVAL_SET));
  await fs.writeFile(
    configPath,
    JSON.stringify({criteria: {[TOOL_TRAJECTORY_SCORE_KEY]: 1.0}}),
  );
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(tempDir, {recursive: true, force: true});
});

async function collectResults(inputs: string[]): Promise<EvalResult[]> {
  const criteria = await getEvaluationCriteriaOrDefault(configPath);
  return runEvals({
    evalSetToEvals: parseAndGetEvalsToRun(inputs),
    rootAgent: buildAgent(),
    evalMetrics: Object.entries(criteria).map(([metricName, threshold]) => ({
      metricName,
      threshold,
    })),
    sessionService: new InMemorySessionService(),
  });
}

describe('adk eval over a real agent', () => {
  it('passes the case whose expected trajectory the agent follows', async () => {
    const results = await collectResults([evalSetPath]);

    expect(
      results.map((result) => [result.evalId, result.finalEvalStatus]),
    ).toEqual([
      ['passing_case', EvalStatus.PASSED],
      ['failing_case', EvalStatus.FAILED],
    ]);
  });

  it('answers the mocked call from the eval data, not from the tool', async () => {
    await collectResults([`${evalSetPath}:passing_case`]);

    expect(realToolCalls).toEqual([]);
  });

  it('runs the real tool when no mock matches the arguments', async () => {
    await collectResults([`${evalSetPath}:failing_case`]);

    expect(realToolCalls).toEqual([ROLLED_SIDES]);
  });

  it('records the trajectory the agent actually produced', async () => {
    const [result] = await collectResults([`${evalSetPath}:passing_case`]);

    expect(result.evalMetricResults).toEqual([
      [
        {metricName: TOOL_TRAJECTORY_SCORE_KEY, threshold: 1},
        {score: 1, evalStatus: EvalStatus.PASSED},
      ],
    ]);
  });

  it('scores the failing case zero on the trajectory metric', async () => {
    const [result] = await collectResults([`${evalSetPath}:failing_case`]);

    expect(result.evalMetricResults[0][1]).toEqual({
      score: 0,
      evalStatus: EvalStatus.FAILED,
    });
  });

  it('restores the agent callback after the run', async () => {
    const agent = buildAgent();
    const criteria = await getEvaluationCriteriaOrDefault(configPath);

    await runEvals({
      evalSetToEvals: parseAndGetEvalsToRun([evalSetPath]),
      rootAgent: agent,
      evalMetrics: Object.entries(criteria).map(([metricName, threshold]) => ({
        metricName,
        threshold,
      })),
      sessionService: new InMemorySessionService(),
    });

    expect(agent.beforeToolCallback).toBeUndefined();
  });
});

/**
 * The model answers `You rolled a 4.` once the mocked tool has returned 4, so
 * these cases pin the response metric against text the agent really produced.
 */
const REFERENCE_EVAL_SET = [
  {
    name: 'reference_matches',
    data: [
      {
        query: 'Roll a die.',
        expected_tool_use: [
          {
            tool_name: 'roll_die',
            tool_input: {sides: ROLLED_SIDES},
            mock_tool_output: 4,
          },
        ],
        reference: 'You rolled a 4.',
      },
    ],
  },
  {
    name: 'reference_differs',
    data: [
      {
        query: 'Roll a die.',
        expected_tool_use: [
          {
            tool_name: 'roll_die',
            tool_input: {sides: ROLLED_SIDES},
            mock_tool_output: 4,
          },
        ],
        reference: 'The weather today is fine.',
      },
    ],
  },
];

describe('response_match_score over a real agent', () => {
  async function collectReferenceResults(): Promise<EvalResult[]> {
    const referenceEvalSetPath = path.join(tempDir, 'reference.evalset.json');
    await fs.writeFile(
      referenceEvalSetPath,
      JSON.stringify(REFERENCE_EVAL_SET),
    );

    return runEvals({
      evalSetToEvals: parseAndGetEvalsToRun([referenceEvalSetPath]),
      rootAgent: buildAgent(),
      evalMetrics: [{metricName: RESPONSE_MATCH_SCORE_KEY, threshold: 0.8}],
      sessionService: new InMemorySessionService(),
    });
  }

  it('scores the response the agent produced against the reference', async () => {
    const results = await collectReferenceResults();

    expect(
      results.map((result) => [result.evalId, result.finalEvalStatus]),
    ).toEqual([
      ['reference_matches', EvalStatus.PASSED],
      ['reference_differs', EvalStatus.FAILED],
    ]);
  });

  it('gives an exactly matching response the top score', async () => {
    const [matching] = await collectReferenceResults();

    expect(matching.evalMetricResults[0][1]).toEqual({
      score: 1,
      evalStatus: EvalStatus.PASSED,
    });
  });

  it('leaves the metric unevaluated when the eval data has no reference', async () => {
    const results = await runEvals({
      evalSetToEvals: parseAndGetEvalsToRun([evalSetPath]),
      rootAgent: buildAgent(),
      evalMetrics: [{metricName: RESPONSE_MATCH_SCORE_KEY, threshold: 0.8}],
      sessionService: new InMemorySessionService(),
    });

    expect(results.map((result) => result.finalEvalStatus)).toEqual([
      EvalStatus.NOT_EVALUATED,
      EvalStatus.NOT_EVALUATED,
    ]);
  });
});
