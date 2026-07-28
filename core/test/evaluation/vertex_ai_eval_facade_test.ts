/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AgentDetails,
  EvalStatus,
  EvaluationDataset,
  Invocation,
  InvocationEvent,
  Metric,
  MultiTurnVertexAiEvalFacade,
  RubricMetric,
  VertexEvaluationResult,
  evalFacadeExportedForTestingOnly,
} from '@google/adk';
import {Content, Tool} from '@google/genai';
import {describe, expect, it, vi} from 'vitest';

const {
  getAgentData,
  getAgentDetails,
  getEvalStatus,
  getScore,
  getTurns,
  mapAgentDetailsToAgentConfig,
  mapInvocationEventToAgentEvent,
  mapInvocationTurn,
} = evalFacadeExportedForTestingOnly;

function content(text: string): Content {
  return {parts: [{text}]};
}

function invocation(overrides: Partial<Invocation> = {}): Invocation {
  return {
    invocationId: 'inv',
    userContent: content('user query'),
    finalResponse: content('final response'),
    ...overrides,
  };
}

/**
 * A facade whose `performEval` seam is replaced by a spy, so mapping and
 * score-extraction logic can be exercised without the (absent) eval SDK.
 */
class TestableFacade extends MultiTurnVertexAiEvalFacade {
  readonly performEvalMock =
    vi.fn<
      (dataset: EvaluationDataset, metrics: Metric[]) => VertexEvaluationResult
    >();

  protected override performEval(
    dataset: EvaluationDataset,
    metrics: Metric[],
  ): VertexEvaluationResult {
    return this.performEvalMock(dataset, metrics);
  }
}

function evalResult(
  meanScore: number | null | undefined,
): VertexEvaluationResult {
  return {
    summaryMetrics: meanScore === undefined ? [] : [{meanScore}],
  };
}

describe('mapAgentDetailsToAgentConfig', () => {
  it('maps name, instructions and tools', () => {
    const tools: Tool[] = [
      {functionDeclarations: [{name: 'tool_1', description: 'this is tool 1'}]},
    ];
    const agentDetails: AgentDetails = {
      name: 'test_agent',
      instructions: 'test_instructions',
      toolDeclarations: tools,
    };

    const agentConfig = mapAgentDetailsToAgentConfig(agentDetails);

    expect(agentConfig.agentId).toBe('test_agent');
    expect(agentConfig.instruction).toBe('test_instructions');
    expect(agentConfig.tools).toBe(tools);
  });
});

describe('getAgentDetails', () => {
  it('collects unique agents first-wins across invocations', () => {
    const invocations: Invocation[] = [
      invocation({
        appDetails: {
          agentDetails: {
            agent1: {
              name: 'agent1',
              instructions: 'instructions1',
              toolDeclarations: [],
            },
            agent2: {
              name: 'agent2',
              instructions: 'instructions2',
              toolDeclarations: [],
            },
          },
        },
      }),
      invocation({
        appDetails: {
          agentDetails: {
            // Duplicate agent1 with different instructions must be ignored
            // (first-wins).
            agent1: {
              name: 'agent1',
              instructions: 'ignored',
              toolDeclarations: [],
            },
            agent3: {
              name: 'agent3',
              instructions: 'instructions3',
              toolDeclarations: [],
            },
          },
        },
      }),
    ];

    const agentConfigs = getAgentDetails(invocations);

    expect(Object.keys(agentConfigs)).toHaveLength(3);
    expect(agentConfigs['agent1'].instruction).toBe('instructions1');
    expect(agentConfigs['agent2'].instruction).toBe('instructions2');
    expect(agentConfigs['agent3'].instruction).toBe('instructions3');
  });

  it('skips invocations without app details', () => {
    const agentConfigs = getAgentDetails([invocation()]);

    expect(agentConfigs).toEqual({});
  });
});

describe('mapInvocationEventToAgentEvent', () => {
  it('preserves author and content', () => {
    const event: InvocationEvent = {
      author: 'test_author',
      content: content('test_content'),
    };

    const agentEvent = mapInvocationEventToAgentEvent(event);

    expect(agentEvent.author).toBe('test_author');
    expect(agentEvent.content?.parts?.[0].text).toBe('test_content');
  });
});

describe('mapInvocationTurn', () => {
  it('orders events as [user, ...intermediate, agent]', () => {
    const turn = mapInvocationTurn(
      0,
      invocation({
        invocationId: 'inv1',
        userContent: content('user query'),
        intermediateData: {
          invocationEvents: [
            {author: 'agent1', content: content('intermediate content')},
          ],
        },
        finalResponse: content('final response'),
      }),
    );

    expect(turn.turnIndex).toBe(0);
    expect(turn.turnId).toBe('inv1');
    expect(turn.events).toHaveLength(3);
    expect(turn.events[0].author).toBe('user');
    expect(turn.events[0].content?.parts?.[0].text).toBe('user query');
    expect(turn.events[1].author).toBe('agent1');
    expect(turn.events[1].content?.parts?.[0].text).toBe(
      'intermediate content',
    );
    expect(turn.events[2].author).toBe('agent');
    expect(turn.events[2].content?.parts?.[0].text).toBe('final response');
  });

  it('produces [user, agent] when there is no intermediate data', () => {
    const turn = mapInvocationTurn(1, invocation({invocationId: 'inv2'}));

    expect(turn.turnIndex).toBe(1);
    expect(turn.events).toHaveLength(2);
    expect(turn.events[0].author).toBe('user');
    expect(turn.events[1].author).toBe('agent');
  });
});

describe('getTurns', () => {
  it('preserves order and turn ids', () => {
    const turns = getTurns([
      invocation({invocationId: 'inv1'}),
      invocation({invocationId: 'inv2'}),
    ]);

    expect(turns).toHaveLength(2);
    expect(turns[0].turnId).toBe('inv1');
    expect(turns[1].turnId).toBe('inv2');
  });
});

describe('getAgentData', () => {
  it('bundles agents and turns', () => {
    const agentData = getAgentData([
      invocation({
        invocationId: 'inv1',
        appDetails: {
          agentDetails: {
            agent1: {
              name: 'agent1',
              instructions: 'instructions1',
              toolDeclarations: [],
            },
          },
        },
      }),
    ]);

    expect('agent1' in agentData.agents).toBe(true);
    expect(agentData.turns).toHaveLength(1);
  });
});

describe('getScore', () => {
  it('returns the mean score when it is a finite number', () => {
    expect(getScore(evalResult(0.9))).toBe(0.9);
  });

  it('returns null when there are no summary metrics', () => {
    expect(getScore(evalResult(undefined))).toBeNull();
  });

  it('returns null when the mean score is null', () => {
    expect(getScore(evalResult(null))).toBeNull();
  });

  it('returns null when the mean score is NaN', () => {
    expect(getScore(evalResult(Number.NaN))).toBeNull();
  });
});

describe('getEvalStatus', () => {
  it('is PASSED when the score meets the threshold', () => {
    expect(getEvalStatus(0.9, 0.8)).toBe(EvalStatus.PASSED);
    expect(getEvalStatus(0.8, 0.8)).toBe(EvalStatus.PASSED);
  });

  it('is FAILED when the score is below the threshold', () => {
    expect(getEvalStatus(0.7, 0.8)).toBe(EvalStatus.FAILED);
  });

  it('is NOT_EVALUATED when the score is null', () => {
    expect(getEvalStatus(null, 0.8)).toBe(EvalStatus.NOT_EVALUATED);
  });
});

describe('MultiTurnVertexAiEvalFacade.evaluateInvocations', () => {
  const twoInvocations: Invocation[] = [
    invocation({
      invocationId: 'inv1',
      userContent: content('q1'),
      intermediateData: {invocationEvents: []},
      finalResponse: content('r1'),
      appDetails: {
        agentDetails: {
          agent1: {
            name: 'agent1',
            instructions: 'instructions1',
            toolDeclarations: [],
          },
        },
      },
    }),
    invocation({
      invocationId: 'inv2',
      userContent: content('q2'),
      intermediateData: {
        invocationEvents: [
          {author: 'agent1', content: content('intermediate')},
        ],
      },
      finalResponse: content('r2'),
      appDetails: {
        agentDetails: {
          agent1: {
            name: 'agent1',
            instructions: 'instructions1',
            toolDeclarations: [],
          },
        },
      },
    }),
  ];

  it('scores only the last turn and maps the request (passed)', () => {
    const facade = new TestableFacade(
      0.8,
      RubricMetric.MULTI_TURN_TASK_SUCCESS,
    );
    facade.performEvalMock.mockReturnValue(evalResult(0.9));

    const result = facade.evaluateInvocations(twoInvocations);

    expect(result.overallScore).toBe(0.9);
    expect(result.overallEvalStatus).toBe(EvalStatus.PASSED);
    expect(result.perInvocationResults).toHaveLength(2);
    expect(result.perInvocationResults[0].evalStatus).toBe(
      EvalStatus.NOT_EVALUATED,
    );
    expect(result.perInvocationResults[0].score).toBeNull();
    expect(result.perInvocationResults[1].evalStatus).toBe(EvalStatus.PASSED);
    expect(result.perInvocationResults[1].score).toBe(0.9);

    expect(facade.performEvalMock).toHaveBeenCalledOnce();
    const [dataset, metrics] = facade.performEvalMock.mock.calls[0];
    expect(metrics.map((m) => m.name)).toEqual([
      RubricMetric.MULTI_TURN_TASK_SUCCESS.name,
    ]);
    expect(dataset.evalCases).toHaveLength(1);
    const agentData = dataset.evalCases[0].agentData;
    expect('agent1' in agentData.agents).toBe(true);
    expect(agentData.turns).toHaveLength(2);
    expect(agentData.turns[0].turnId).toBe('inv1');
    expect(agentData.turns[1].turnId).toBe('inv2');
    expect(agentData.turns[0].events).toHaveLength(2);
    expect(agentData.turns[1].events).toHaveLength(3);
  });

  it('reports FAILED when the last-turn score is below the threshold', () => {
    const facade = new TestableFacade(
      0.8,
      RubricMetric.MULTI_TURN_TASK_SUCCESS,
    );
    facade.performEvalMock.mockReturnValue(evalResult(0.7));

    const result = facade.evaluateInvocations(twoInvocations);

    expect(result.overallScore).toBe(0.7);
    expect(result.overallEvalStatus).toBe(EvalStatus.FAILED);
    expect(result.perInvocationResults[1].evalStatus).toBe(EvalStatus.FAILED);
  });

  it.each([
    ['empty summary metrics', undefined],
    ['a null mean score', null],
    ['a NaN mean score', Number.NaN],
  ])('returns an empty result given %s', (_label, meanScore) => {
    const facade = new TestableFacade(
      0.8,
      RubricMetric.MULTI_TURN_TASK_SUCCESS,
    );
    facade.performEvalMock.mockReturnValue(evalResult(meanScore));

    const result = facade.evaluateInvocations(twoInvocations);

    expect(result.overallScore).toBeNull();
    expect(result.overallEvalStatus).toBe(EvalStatus.NOT_EVALUATED);
    expect(result.perInvocationResults).toEqual([]);
    expect(facade.performEvalMock).toHaveBeenCalledOnce();
  });

  it('returns an empty result and skips eval for empty invocations', () => {
    const facade = new TestableFacade(
      0.8,
      RubricMetric.MULTI_TURN_TASK_SUCCESS,
    );

    const result = facade.evaluateInvocations([]);

    expect(result.overallScore).toBeNull();
    expect(result.overallEvalStatus).toBe(EvalStatus.NOT_EVALUATED);
    expect(result.perInvocationResults).toEqual([]);
    expect(facade.performEvalMock).not.toHaveBeenCalled();
  });

  it('scores the only turn for a single invocation', () => {
    const facade = new TestableFacade(
      0.8,
      RubricMetric.MULTI_TURN_TASK_SUCCESS,
    );
    facade.performEvalMock.mockReturnValue(evalResult(0.95));

    const result = facade.evaluateInvocations([
      invocation({invocationId: 'only'}),
    ]);

    expect(result.perInvocationResults).toHaveLength(1);
    expect(result.perInvocationResults[0].evalStatus).toBe(EvalStatus.PASSED);
    expect(result.perInvocationResults[0].score).toBe(0.95);
  });

  it('throws when expected invocations have a mismatched length', () => {
    const facade = new TestableFacade(
      0.8,
      RubricMetric.MULTI_TURN_TASK_SUCCESS,
    );

    expect(() =>
      facade.evaluateInvocations(twoInvocations, [invocation()]),
    ).toThrowError(/got 2 and 1/);
    expect(facade.performEvalMock).not.toHaveBeenCalled();
  });

  it('carries expected invocations onto the per-invocation results', () => {
    const facade = new TestableFacade(
      0.8,
      RubricMetric.MULTI_TURN_TASK_SUCCESS,
    );
    facade.performEvalMock.mockReturnValue(evalResult(0.9));
    const expected: Invocation[] = [
      invocation({invocationId: 'exp1'}),
      invocation({invocationId: 'exp2'}),
    ];

    const result = facade.evaluateInvocations(twoInvocations, expected);

    expect(result.perInvocationResults[0].expectedInvocation).toBe(expected[0]);
    expect(result.perInvocationResults[1].expectedInvocation).toBe(expected[1]);
  });

  it('throws a clear error when the eval SDK seam is not implemented', () => {
    const facade = new MultiTurnVertexAiEvalFacade(
      0.8,
      RubricMetric.MULTI_TURN_TASK_SUCCESS,
    );

    expect(() => facade.evaluateInvocations([invocation()])).toThrowError(
      /Vertex Gen AI Eval SDK/,
    );
  });
});
