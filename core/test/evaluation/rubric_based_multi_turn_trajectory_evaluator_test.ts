/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AppDetails,
  AppDetailsSchema,
  BaseLlm,
  EvalMetric,
  EvalStatus,
  Invocation,
  InvocationEvents,
  InvocationSchema,
  LLMRegistry,
  LlmResponse,
  PrebuiltMetrics,
  Rubric,
  RubricBasedMultiTurnTrajectoryEvaluator,
  RubricsBasedCriterionSchema,
} from '@google/adk';
import {afterEach, describe, expect, it, vi} from 'vitest';

class MockJudge extends BaseLlm {
  constructor(private readonly response?: LlmResponse) {
    super({model: 'mock-judge'});
  }
  override async *generateContentAsync(): AsyncGenerator<LlmResponse, void> {
    if (this.response) {
      yield this.response;
    }
  }
  override connect(): Promise<never> {
    throw new Error('not implemented');
  }
}

/** Exposes the protected dialogue state and assembly method for testing. */
class TestableMultiTurn extends RubricBasedMultiTurnTrajectoryEvaluator {
  setDialogue(value: string): void {
    this.formattedDialogue = value;
  }
  setInstructions(value: string): void {
    this.formattedInstructions = value;
  }
  setTools(value: string): void {
    this.formattedTools = value;
  }
  get dialogue(): string {
    return this.formattedDialogue;
  }
  get instructions(): string {
    return this.formattedInstructions;
  }
  get tools(): string {
    return this.formattedTools;
  }
  assemble(invocations: Invocation[]): void {
    this.assembleDialogueHistory(invocations);
  }
}

const RUBRICS: Rubric[] = [
  {
    rubricId: '1',
    rubricContent: {textProperty: 'The agent uses the correct tool.'},
    type: 'TOOL_USAGE',
  },
  {
    rubricId: '2',
    rubricContent: {textProperty: 'The agent fulfills the user intent.'},
    type: 'FULFILL_USER_INTENT',
  },
];

function makeMetric(rubrics: Rubric[] = RUBRICS): EvalMetric {
  return {
    metricName: PrebuiltMetrics.RUBRIC_BASED_MULTI_TURN_TRAJECTORY_QUALITY_V1,
    threshold: 0.5,
    criterion: RubricsBasedCriterionSchema.parse({
      threshold: 0.5,
      rubrics,
      judgeModelOptions: {numSamples: 3},
    }),
  };
}

function makeEvaluator(response?: LlmResponse): TestableMultiTurn {
  vi.spyOn(LLMRegistry, 'newLlm').mockReturnValue(new MockJudge(response));
  return new TestableMultiTurn(makeMetric());
}

function makeInvocation(options: {
  userText?: string;
  agentText?: string;
  rubrics?: Rubric[];
  appDetails?: AppDetails;
  intermediateData?: InvocationEvents;
}): Invocation {
  return InvocationSchema.parse({
    userContent: {parts: options.userText ? [{text: options.userText}] : []},
    finalResponse: options.agentText
      ? {parts: [{text: options.agentText}]}
      : undefined,
    rubrics: options.rubrics,
    appDetails: options.appDetails,
    intermediateData: options.intermediateData,
  });
}

describe('RubricBasedMultiTurnTrajectoryEvaluator', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('formatAutoRaterPrompt', () => {
    it('includes dialogue and rubrics in the prompt', () => {
      const evaluator = makeEvaluator();
      evaluator.setDialogue('USER TURN 1: What is the balance?');
      const prompt = evaluator.formatAutoRaterPrompt(
        makeInvocation({
          userText: 'What is the balance?',
          agentText: 'Your balance is $100.',
          rubrics: RUBRICS,
        }),
      );
      expect(prompt).toContain('USER TURN 1: What is the balance?');
      expect(prompt).toContain('The agent uses the correct tool.');
      expect(prompt).toContain('The agent fulfills the user intent.');
      expect(prompt).toContain('TOOL_USAGE');
      expect(prompt).toContain('FULFILL_USER_INTENT');
    });

    it('includes agent instructions and tools in the prompt', () => {
      const evaluator = makeEvaluator();
      evaluator.setDialogue('USER TURN 1: Transfer funds');
      evaluator.setInstructions(
        'Agent banking_agent Instructions:\nYou are a banking assistant.',
      );
      evaluator.setTools(
        'Agent: banking_agent\n- transfer_funds: Transfer money between accounts.',
      );
      const prompt = evaluator.formatAutoRaterPrompt(
        makeInvocation({userText: 'Transfer funds', rubrics: RUBRICS}),
      );
      expect(prompt).toContain('You are a banking assistant.');
      expect(prompt).toContain('transfer_funds');
    });
  });

  describe('assembleDialogueHistory', () => {
    it('returns NOT_EVALUATED for an empty conversation', async () => {
      const evaluator = makeEvaluator();
      const result = await evaluator.evaluateInvocations([]);
      expect(result.overallScore).toBeUndefined();
      expect(result.overallEvalStatus).toBe(EvalStatus.NOT_EVALUATED);
      expect(result.perInvocationResults).toEqual([]);
    });

    it('assembles a single user/agent turn', () => {
      const evaluator = makeEvaluator();
      evaluator.assemble([
        makeInvocation({userText: 'Hello', agentText: 'Hi there!'}),
      ]);
      expect(evaluator.dialogue).toContain('USER TURN 1: Hello');
      expect(evaluator.dialogue).toContain('AGENT (agent) TURN 1: Hi there!');
    });

    it('assembles multiple turns', () => {
      const evaluator = makeEvaluator();
      evaluator.assemble([
        makeInvocation({
          userText: 'Check my balance',
          agentText: 'Your balance is $100.',
        }),
        makeInvocation({
          userText: 'Transfer $50',
          agentText: 'Transfer complete.',
        }),
      ]);
      expect(evaluator.dialogue).toContain('USER TURN 1: Check my balance');
      expect(evaluator.dialogue).toContain(
        'AGENT (agent) TURN 1: Your balance is $100.',
      );
      expect(evaluator.dialogue).toContain('USER TURN 2: Transfer $50');
      expect(evaluator.dialogue).toContain(
        'AGENT (agent) TURN 2: Transfer complete.',
      );
    });

    it('assembles intermediate function calls and responses', () => {
      const evaluator = makeEvaluator();
      const intermediateData = InvocationEventsFromParts();
      evaluator.assemble([
        makeInvocation({
          userText: 'What is my balance?',
          agentText: 'Your balance is $100.',
          intermediateData,
        }),
      ]);
      expect(evaluator.dialogue).toContain('get_balance');
      expect(evaluator.dialogue).toContain('"account_id":"123"');
      expect(evaluator.dialogue).toContain('"balance":100');
    });

    it('captures app details instructions and tools', () => {
      const evaluator = makeEvaluator();
      const appDetails = AppDetailsSchema.parse({
        agentDetails: {
          banking_agent: {
            name: 'banking_agent',
            instructions: 'You are a banking assistant.',
            toolDeclarations: [
              {
                functionDeclarations: [
                  {
                    name: 'transfer_funds',
                    description: 'Transfer money between accounts.',
                  },
                ],
              },
            ],
          },
        },
      });
      evaluator.assemble([
        makeInvocation({
          userText: 'Transfer $50',
          agentText: 'Done.',
          appDetails,
        }),
      ]);
      expect(evaluator.instructions).toContain('You are a banking assistant.');
      expect(evaluator.tools).toContain('transfer_funds');
      expect(evaluator.tools).toContain('Transfer money between accounts.');
    });

    it('handles a tool declaration without function declarations', () => {
      const evaluator = makeEvaluator();
      const appDetails = AppDetailsSchema.parse({
        agentDetails: {
          agentx: {
            name: 'agentx',
            instructions: 'do things',
            toolDeclarations: [{}],
          },
        },
      });
      evaluator.assemble([
        makeInvocation({userText: 'hi', agentText: 'ok', appDetails}),
      ]);
      expect(evaluator.tools).toContain('Agent: agentx');
    });

    it('handles an invocation without user text', () => {
      const evaluator = makeEvaluator();
      evaluator.assemble([makeInvocation({agentText: 'Agent response.'})]);
      expect(evaluator.dialogue).not.toContain('USER TURN');
      expect(evaluator.dialogue).toContain(
        'AGENT (agent) TURN 1: Agent response.',
      );
    });

    it('handles user-role events, arg-less calls, empty responses, and content-less events', () => {
      const evaluator = makeEvaluator();
      evaluator.assemble([
        makeInvocation({
          userText: 'q',
          agentText: 'final',
          intermediateData: {
            invocationEvents: [
              {author: 'user', content: {parts: [{text: 'user event text'}]}},
              {author: 'agent', content: {parts: [{text: 'agent event text'}]}},
              {
                author: 'agent',
                content: {parts: [{functionCall: {name: 'noargs'}}]},
              },
              {
                author: 'agent',
                content: {parts: [{functionResponse: {name: 'noresp'}}]},
              },
              {author: 'agent', content: undefined},
            ],
          },
        }),
      ]);
      expect(evaluator.dialogue).toContain('USER TURN 1: user event text');
      expect(evaluator.dialogue).toContain(
        'AGENT (agent) TURN 1: agent event text',
      );
      expect(evaluator.dialogue).toContain('noargs({})');
      expect(evaluator.dialogue).toContain('noresp -> {}');
    });
  });

  describe('evaluateInvocations', () => {
    it('marks earlier turns NOT_EVALUATED and scores the last turn', async () => {
      const response: LlmResponse = {
        content: {
          parts: [
            {
              text: `ID: 1
Property: The agent uses the correct tool.
Rationale: ok
Verdict: yes

ID: 2
Property: The agent fulfills the user intent.
Rationale: ok
Verdict: yes
`,
            },
          ],
        },
      };
      const evaluator = makeEvaluator(response);
      const result = await evaluator.evaluateInvocations([
        makeInvocation({
          userText: 'Check my balance',
          agentText: 'Your balance is $100.',
          rubrics: RUBRICS,
        }),
        makeInvocation({
          userText: 'Transfer $50',
          agentText: 'Done.',
          rubrics: RUBRICS,
        }),
      ]);
      expect(result.perInvocationResults).toHaveLength(2);
      expect(result.perInvocationResults[0].evalStatus).toBe(
        EvalStatus.NOT_EVALUATED,
      );
      expect(result.overallScore).toBe(1.0);
      expect(result.overallEvalStatus).toBe(EvalStatus.PASSED);
    });

    it('passes the last expected invocation through to the judge', async () => {
      const response: LlmResponse = {
        content: {
          parts: [
            {
              text: `ID: 1
Property: The agent uses the correct tool.
Rationale: ok
Verdict: yes

ID: 2
Property: The agent fulfills the user intent.
Rationale: ok
Verdict: yes
`,
            },
          ],
        },
      };
      const evaluator = makeEvaluator(response);
      const actual = [
        makeInvocation({
          userText: 'Only turn',
          agentText: 'Reply.',
          rubrics: RUBRICS,
        }),
      ];
      const expected = [
        makeInvocation({
          userText: 'Only turn',
          agentText: 'Reply.',
          rubrics: RUBRICS,
        }),
      ];
      const result = await evaluator.evaluateInvocations(actual, expected);
      expect(result.overallScore).toBe(1.0);
      expect(result.perInvocationResults[0].expectedInvocation).toBeDefined();
    });

    it('falls back to overall fields when the last turn yields no samples', async () => {
      const evaluator = makeEvaluator(undefined);
      const result = await evaluator.evaluateInvocations([
        makeInvocation({
          userText: 'Only turn',
          agentText: 'Reply.',
          rubrics: RUBRICS,
        }),
      ]);
      expect(result.perInvocationResults).toHaveLength(1);
      expect(result.perInvocationResults[0].evalStatus).toBe(
        EvalStatus.NOT_EVALUATED,
      );
      expect(result.overallScore).toBeUndefined();
    });
  });
});

function InvocationEventsFromParts(): InvocationEvents {
  return {
    invocationEvents: [
      {
        author: 'banking_agent',
        content: {
          parts: [
            {functionCall: {name: 'get_balance', args: {account_id: '123'}}},
          ],
        },
      },
      {
        author: 'banking_agent',
        content: {
          parts: [
            {functionResponse: {name: 'get_balance', response: {balance: 100}}},
          ],
        },
      },
    ],
  };
}
