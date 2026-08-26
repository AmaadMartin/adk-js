/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AgentEvaluator,
  BaseAgent,
  createEvent,
  EvalConfigSchema,
  EvalFailureError,
  EvalSetSchema,
  EvalStatus,
  EvaluationResult,
  Evaluator,
  Event,
  getDefaultMetricEvaluatorRegistry,
  Invocation,
  InvocationContext,
  NUM_RUNS,
  UnsupportedMetricError,
} from '@google/adk';
import {FunctionCall} from '@google/genai';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';

/** One scripted agent turn: an optional tool call plus the final text. */
interface ScriptedTurn {
  toolCall?: FunctionCall;
  text: string;
}

/**
 * An agent that replays scripted turns. The last scripted turn repeats once the
 * script runs out, so a single-turn script serves every run.
 */
class ScriptedAgent extends BaseAgent {
  private turnIndex = 0;

  /** How many times the agent has been asked to answer a turn. */
  get runCount(): number {
    return this.turnIndex;
  }

  constructor(
    name: string,
    private readonly turns: ScriptedTurn[],
    subAgents: BaseAgent[] = [],
  ) {
    super({name, subAgents});
  }

  protected async *runAsyncImpl(
    context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    const turn = this.turns[Math.min(this.turnIndex++, this.turns.length - 1)];
    if (turn.toolCall) {
      yield createEvent({
        invocationId: context.invocationId,
        author: this.name,
        content: {role: 'model', parts: [{functionCall: turn.toolCall}]},
      });
      yield createEvent({
        invocationId: context.invocationId,
        author: this.name,
        content: {
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: turn.toolCall.name,
                response: {result: 'ok'},
              },
            },
          ],
        },
      });
    }
    yield createEvent({
      invocationId: context.invocationId,
      author: this.name,
      content: {role: 'model', parts: [{text: turn.text}]},
    });
  }

  protected async *runLiveImpl(
    _context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {}
}

/** An evaluator that reports a result carrying no score and no expectation. */
class UnscoredEvaluator extends Evaluator {
  evaluateInvocations(actualInvocations: Invocation[]): EvaluationResult {
    return {
      overallEvalStatus: EvalStatus.NOT_EVALUATED,
      perInvocationResults: actualInvocations.map((actualInvocation) => ({
        actualInvocation,
        evalStatus: EvalStatus.NOT_EVALUATED,
      })),
    };
  }
}

const ROLL_DIE_CALL: FunctionCall = {name: 'roll_die', args: {sides: 17}};
const REFERENCE_TEXT = 'I rolled a 17 sided die and got 13.';

const LEGACY_CASE = [
  {
    query: 'Roll a 17 sided dice',
    expected_tool_use: [{tool_name: 'roll_die', tool_input: {sides: 17}}],
    reference: REFERENCE_TEXT,
  },
];

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adk-agent-eval-'));
  tempDirs.push(dir);
  return dir;
}

function writeJson(dir: string, name: string, value: unknown): string {
  const filePath = path.join(dir, name);
  fs.mkdirSync(path.dirname(filePath), {recursive: true});
  fs.writeFileSync(filePath, JSON.stringify(value), 'utf-8');
  return filePath;
}

/** Writes a dataset directory holding one legacy test file and its config. */
function makeDataset(
  criteria: Record<string, unknown> = {
    tool_trajectory_avg_score: 1.0,
    response_match_score: 0.8,
  },
  testFile: unknown = LEGACY_CASE,
): string {
  const dir = makeTempDir();
  writeJson(dir, 'dice.test.json', testFile);
  writeJson(dir, 'test_config.json', {criteria});
  return dir;
}

function matchingAgent(name = 'dice_agent'): ScriptedAgent {
  return new ScriptedAgent(name, [
    {toolCall: ROLL_DIE_CALL, text: REFERENCE_TEXT},
  ]);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

describe('AgentEvaluator.findConfigForTestFile', () => {
  it('reads the config sitting next to the test file', () => {
    const dir = makeDataset({response_match_score: 0.25});

    const config = AgentEvaluator.findConfigForTestFile(
      path.join(dir, 'dice.test.json'),
    );

    expect(config.criteria).toEqual({response_match_score: 0.25});
  });

  it('falls back to the default criteria when there is no config', () => {
    const dir = makeTempDir();

    const config = AgentEvaluator.findConfigForTestFile(
      path.join(dir, 'dice.test.json'),
    );

    expect(config.criteria).toEqual({
      tool_trajectory_avg_score: 1.0,
      response_match_score: 0.8,
    });
  });
});

describe('AgentEvaluator.evaluate', () => {
  it('passes when the agent matches the recorded conversation', async () => {
    await expect(
      AgentEvaluator.evaluate({
        agent: matchingAgent(),
        evalDatasetFilePathOrDir: path.join(makeDataset(), 'dice.test.json'),
      }),
    ).resolves.toBeUndefined();
  });

  it('names the metric, the threshold and the score on failure', async () => {
    const agent = new ScriptedAgent('dice_agent', [
      {toolCall: ROLL_DIE_CALL, text: 'Something else entirely.'},
    ]);

    const error = await captureError(
      AgentEvaluator.evaluate({
        agent,
        evalDatasetFilePathOrDir: makeDataset(),
      }),
    );

    expect(error).toBeInstanceOf(EvalFailureError);
    expect(error.message).toContain('Following are all the test failures.');
    expect(error.message).toContain(
      'response_match_score for dice_agent Failed. Expected 0.8, but got 0',
    );
  });

  it('reports every failing metric, not just the first', async () => {
    const agent = new ScriptedAgent('dice_agent', [
      {toolCall: {name: 'flip_coin', args: {}}, text: 'Something else.'},
    ]);

    const error = await captureError(
      AgentEvaluator.evaluate({
        agent,
        evalDatasetFilePathOrDir: makeDataset(),
      }),
    );

    expect(error.message).toContain(
      'tool_trajectory_avg_score for dice_agent Failed.',
    );
    expect(error.message).toContain(
      'response_match_score for dice_agent Failed.',
    );
  });

  it('averages the score across runs before comparing it', async () => {
    // Run 1 matches the reference, run 2 does not, so the mean is below 1.0
    // even though one run scored a perfect 1.0.
    const agent = new ScriptedAgent('dice_agent', [
      {toolCall: ROLL_DIE_CALL, text: REFERENCE_TEXT},
      {toolCall: ROLL_DIE_CALL, text: 'A completely different answer.'},
    ]);

    const error = await captureError(
      AgentEvaluator.evaluate({
        agent,
        evalDatasetFilePathOrDir: makeDataset({response_match_score: 1.0}),
        numRuns: 2,
      }),
    );

    const score = scoreFromMessage(error.message, 'response_match_score');
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(1);
  });

  it('defaults to NUM_RUNS runs', async () => {
    const agent = new ScriptedAgent('dice_agent', [
      {toolCall: ROLL_DIE_CALL, text: REFERENCE_TEXT},
    ]);

    await AgentEvaluator.evaluate({
      agent,
      evalDatasetFilePathOrDir: makeDataset(),
    });

    expect(NUM_RUNS).toBe(2);
    expect(agent.runCount).toBe(NUM_RUNS);
  });

  it('includes the per-invocation detail by default', async () => {
    const agent = new ScriptedAgent('dice_agent', [
      {toolCall: ROLL_DIE_CALL, text: 'Something else entirely.'},
    ]);

    const error = await captureError(
      AgentEvaluator.evaluate({
        agent,
        evalDatasetFilePathOrDir: makeDataset(),
        numRuns: 1,
      }),
    );

    expect(error.message).toContain('Summary: `FAILED` for Metric:');
    expect(error.message).toContain('expected_response');
    expect(error.message).toContain('Something else entirely.');
  });

  it('omits the detail and adds the re-run hint when asked', async () => {
    const agent = new ScriptedAgent('dice_agent', [
      {toolCall: ROLL_DIE_CALL, text: 'Something else entirely.'},
    ]);

    const error = await captureError(
      AgentEvaluator.evaluate({
        agent,
        evalDatasetFilePathOrDir: makeDataset(),
        numRuns: 1,
        printDetailedResults: false,
      }),
    );

    expect(error.message).not.toContain('Summary: `FAILED` for Metric:');
    expect(error.message).toContain('`printDetailedResults` set to `true`');
  });

  it('recurses a directory and picks up every test file', async () => {
    const dir = makeDataset();
    writeJson(dir, path.join('nested', 'second.test.json'), LEGACY_CASE);
    writeJson(dir, path.join('nested', 'ignored.json'), LEGACY_CASE);
    const agent = new ScriptedAgent('dice_agent', [
      {toolCall: ROLL_DIE_CALL, text: REFERENCE_TEXT},
    ]);

    await AgentEvaluator.evaluate({
      agent,
      evalDatasetFilePathOrDir: dir,
      numRuns: 1,
    });

    expect(agent.runCount).toBe(2);
  });

  it('rejects a dataset path that does not exist', async () => {
    const missing = path.join(makeTempDir(), 'nope');

    await expect(
      AgentEvaluator.evaluate({
        agent: matchingAgent(),
        evalDatasetFilePathOrDir: missing,
      }),
    ).rejects.toThrow(`Input path ${missing} is invalid.`);
  });

  it('seeds the session from an initial session file', async () => {
    const dir = makeDataset();
    const sessionFile = writeJson(dir, 'session.json', {
      app_name: 'dice',
      user_id: 'u',
      state: {user_name: 'Ada'},
    });

    await expect(
      AgentEvaluator.evaluate({
        agent: matchingAgent(),
        evalDatasetFilePathOrDir: path.join(dir, 'dice.test.json'),
        initialSessionFile: sessionFile,
        numRuns: 1,
      }),
    ).resolves.toBeUndefined();
  });

  it('rejects an initial session file that is not a JSON object', async () => {
    const dir = makeDataset();
    const sessionFile = writeJson(dir, 'session.json', ['not', 'an', 'object']);

    await expect(
      AgentEvaluator.evaluate({
        agent: matchingAgent(),
        evalDatasetFilePathOrDir: path.join(dir, 'dice.test.json'),
        initialSessionFile: sessionFile,
      }),
    ).rejects.toThrow(/must hold a JSON object/);
  });

  it('evaluates the named sub-agent', async () => {
    const subAgent = matchingAgent('dice_sub_agent');
    const rootAgent = new ScriptedAgent(
      'root_agent',
      [{text: 'the root never answers correctly'}],
      [subAgent],
    );

    await AgentEvaluator.evaluate({
      agent: rootAgent,
      evalDatasetFilePathOrDir: makeDataset(),
      agentName: 'dice_sub_agent',
      numRuns: 1,
    });

    expect(subAgent.runCount).toBe(1);
    expect(rootAgent.runCount).toBe(0);
  });

  it('rejects a sub-agent name that does not resolve', async () => {
    await expect(
      AgentEvaluator.evaluate({
        agent: matchingAgent(),
        evalDatasetFilePathOrDir: makeDataset(),
        agentName: 'no_such_agent',
      }),
    ).rejects.toThrow("Sub-Agent 'no_such_agent' not found.");
  });

  it('rejects a metric that has no registered evaluator', async () => {
    const dir = makeTempDir();
    writeJson(dir, 'dice.test.json', evalSetFile());
    writeJson(dir, 'test_config.json', {criteria: {no_such_metric: 1.0}});

    await expect(
      AgentEvaluator.evaluate({
        agent: matchingAgent(),
        evalDatasetFilePathOrDir: dir,
      }),
    ).rejects.toThrow('no_such_metric not found in registry.');
  });

  it('rejects a criteria key the legacy format does not allow', async () => {
    await expect(
      AgentEvaluator.evaluate({
        agent: matchingAgent(),
        evalDatasetFilePathOrDir: makeDataset({final_response_match_v2: 0.5}),
      }),
    ).rejects.toThrow(/Invalid criteria key: final_response_match_v2/);
  });

  it('reports a metric that produced results but no score', async () => {
    const metricName = 'unscored_test_metric';
    getDefaultMetricEvaluatorRegistry().registerEvaluator(
      {
        metricName,
        description: 'test-only metric that reports no score',
        metricValueInfo: {},
      },
      UnscoredEvaluator,
    );
    const dir = makeTempDir();
    writeJson(dir, 'dice.test.json', evalSetFile());
    writeJson(dir, 'test_config.json', {criteria: {[metricName]: 0.5}});

    const error = await captureError(
      AgentEvaluator.evaluate({
        agent: matchingAgent(),
        evalDatasetFilePathOrDir: dir,
        numRuns: 1,
      }),
    );

    expect(error.message).toContain(
      `${metricName} for dice_agent Failed. Expected 0.5, but got none.`,
    );
    expect(error.message).toContain('Summary: `NOT_EVALUATED` for Metric:');
  });
});

describe('AgentEvaluator.evaluateEvalSet', () => {
  it('rejects an eval case that has no recorded conversation', async () => {
    const evalSet = EvalSetSchema.parse({
      evalSetId: 'scenario_set',
      evalCases: [
        {
          evalId: 'scenario_case',
          conversationScenario: {
            startingPrompt: 'Roll a die',
            conversationPlan: 'Ask for one die roll, then stop.',
          },
        },
      ],
    });

    await expect(
      AgentEvaluator.evaluateEvalSet({
        agent: matchingAgent(),
        evalSet,
        evalConfig: AgentEvaluator.findConfigForTestFile(
          path.join(makeTempDir(), 'x.test.json'),
        ),
      }),
    ).rejects.toThrow(/has no conversation/);
  });

  it('skips a metric that produced no results at all', async () => {
    const evalSet = EvalSetSchema.parse({
      evalSetId: 'empty_conversation_set',
      evalCases: [{evalId: 'empty_case', conversation: []}],
    });

    await expect(
      AgentEvaluator.evaluateEvalSet({
        agent: matchingAgent(),
        evalSet,
        evalConfig: AgentEvaluator.findConfigForTestFile(
          path.join(makeTempDir(), 'x.test.json'),
        ),
        numRuns: 1,
      }),
    ).resolves.toBeUndefined();
  });

  it('passes when the eval set has no cases', async () => {
    await expect(
      AgentEvaluator.evaluateEvalSet({
        agent: matchingAgent(),
        evalSet: EvalSetSchema.parse({evalSetId: 'empty', evalCases: []}),
        evalConfig: AgentEvaluator.findConfigForTestFile(
          path.join(makeTempDir(), 'x.test.json'),
        ),
      }),
    ).resolves.toBeUndefined();
  });

  it('refuses a metric adk-js cannot score, before running the agent', async () => {
    const agent = matchingAgent();
    const evalSet = EvalSetSchema.parse({
      evalSetId: 'set',
      evalCases: [
        {
          evalId: 'case',
          conversation: [
            {
              userContent: {parts: [{text: 'Roll a die'}], role: 'user'},
              finalResponse: {parts: [{text: REFERENCE_TEXT}], role: 'model'},
            },
          ],
        },
      ],
    });

    await expect(
      AgentEvaluator.evaluateEvalSet({
        agent,
        evalSet,
        evalConfig: EvalConfigSchema.parse({criteria: {safety_v1: 0.8}}),
      }),
    ).rejects.toThrow(UnsupportedMetricError);
    expect(agent.runCount).toBe(0);
  });

  it('names the unsupported metric in the error', async () => {
    await expect(
      AgentEvaluator.evaluateEvalSet({
        agent: matchingAgent(),
        evalSet: EvalSetSchema.parse({evalSetId: 'empty', evalCases: []}),
        evalConfig: EvalConfigSchema.parse({
          criteria: {response_evaluation_score: 0.8},
        }),
      }),
    ).rejects.toThrow(/response_evaluation_score/);
  });
});

describe('AgentEvaluator.migrateEvalDataToNewSchema', () => {
  it('rejects an empty source path', () => {
    expect(() =>
      AgentEvaluator.migrateEvalDataToNewSchema('', 'out.json'),
    ).toThrow('One of oldEvalDataFile or newEvalDataFile is empty.');
  });

  it('rejects an empty destination path', () => {
    expect(() =>
      AgentEvaluator.migrateEvalDataToNewSchema('in.test.json', ''),
    ).toThrow('One of oldEvalDataFile or newEvalDataFile is empty.');
  });

  it('writes snake_case output that loads back as an eval set', () => {
    const dir = makeDataset(
      {tool_trajectory_avg_score: 1.0, response_match_score: 0.8},
      [{...LEGACY_CASE[0], reference: 'J’ai obtenu 13 \u2014 déjà!'}],
    );
    const output = path.join(dir, 'migrated.evalset.json');

    AgentEvaluator.migrateEvalDataToNewSchema(
      path.join(dir, 'dice.test.json'),
      output,
    );

    const written = fs.readFileSync(output, 'utf-8');
    expect(written).toContain('"eval_set_id"');
    expect(written).toContain('"tool_uses"');
    const parsed = JSON.parse(written) as {
      eval_cases: Array<{conversation: Array<{final_response: unknown}>}>;
    };
    expect(parsed.eval_cases[0].conversation[0].final_response).toEqual({
      role: 'model',
      parts: [{text: 'J’ai obtenu 13 — déjà!'}],
    });
  });

  it('carries the initial session file into the migrated eval set', () => {
    const dir = makeDataset();
    const sessionFile = writeJson(dir, 'session.json', {
      app_name: 'dice',
      user_id: 'u',
      state: {user_name: 'Ada'},
    });
    const output = path.join(dir, 'migrated.evalset.json');

    AgentEvaluator.migrateEvalDataToNewSchema(
      path.join(dir, 'dice.test.json'),
      output,
      sessionFile,
    );

    const parsed = JSON.parse(fs.readFileSync(output, 'utf-8')) as {
      eval_cases: Array<{session_input: unknown}>;
    };
    expect(parsed.eval_cases[0].session_input).toEqual({
      app_name: 'dice',
      user_id: 'u',
      state: {user_name: 'Ada'},
    });
  });
});

/** An eval set file holding the same case as {@link LEGACY_CASE}. */
function evalSetFile(): unknown {
  return {
    eval_set_id: 'dice_set',
    eval_cases: [
      {
        eval_id: 'roll_a_die',
        conversation: [
          {
            invocation_id: 'inv-1',
            user_content: {
              role: 'user',
              parts: [{text: 'Roll a 17 sided dice'}],
            },
            final_response: {role: 'model', parts: [{text: REFERENCE_TEXT}]},
            intermediate_data: {
              tool_uses: [{name: 'roll_die', args: {sides: 17}}],
            },
          },
        ],
      },
    ],
  };
}

async function captureError(promise: Promise<void>): Promise<Error> {
  try {
    await promise;
  } catch (error: unknown) {
    if (error instanceof Error) {
      return error;
    }
    expect.fail(`Expected an Error, got ${String(error)}`);
  }
  expect.fail('Expected the eval run to fail, but it passed.');
}

function scoreFromMessage(message: string, metricName: string): number {
  const match = new RegExp(
    `${metricName} for [^ ]+ Failed\\. Expected [0-9.]+, but got ([0-9.]+)\\.`,
  ).exec(message);
  if (!match) {
    expect.fail(`No failure line for ${metricName} in:\n${message}`);
  }
  return Number(match[1]);
}
