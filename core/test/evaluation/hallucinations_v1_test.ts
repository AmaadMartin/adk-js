/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AppDetails,
  AppDetailsSchema,
  BaseCriterionSchema,
  BaseLlm,
  createContextForStep,
  EvalStatus,
  HallucinationsCriterionSchema,
  HallucinationsV1Evaluator,
  Invocation,
  InvocationEvent,
  InvocationSchema,
  LLMRegistry,
  LlmResponse,
  parseSentences,
  parseValidationResults,
} from '@google/adk';
import {afterEach, describe, expect, it, vi} from 'vitest';

type JudgeAction = {yield: LlmResponse} | {error: Error} | {empty: true};

/** A BaseLlm that plays a fixed script of yields/throws, one per generate call. */
class ScriptedJudge extends BaseLlm {
  private index = 0;

  constructor(private readonly actions: JudgeAction[]) {
    super({model: 'mock-judge'});
  }

  override async *generateContentAsync(): AsyncGenerator<LlmResponse, void> {
    const action = this.actions[this.index++];
    if ('error' in action) {
      throw action.error;
    }
    if ('empty' in action) {
      return;
    }
    yield action.yield;
  }

  override connect(): Promise<never> {
    throw new Error('not implemented');
  }
}

function textResponse(text: string): LlmResponse {
  return {content: {parts: [{text}]}};
}

function makeEvaluator(
  options: {
    evaluateIntermediateNlResponses?: boolean;
    judge?: BaseLlm;
  } = {},
): HallucinationsV1Evaluator {
  vi.spyOn(LLMRegistry, 'newLlm').mockReturnValue(
    options.judge ?? new ScriptedJudge([]),
  );
  return new HallucinationsV1Evaluator({
    metricName: 'hallucinations_v1',
    threshold: 0.5,
    criterion: HallucinationsCriterionSchema.parse({
      threshold: 0.5,
      judgeModelOptions: {
        judgeModel: 'gemini-2.5-flash',
        judgeModelConfig: {temperature: 0},
        numSamples: 1,
      },
      evaluateIntermediateNlResponses:
        options.evaluateIntermediateNlResponses ?? true,
    }),
  });
}

describe('parseSentences', () => {
  it('returns [] for empty text', () => {
    expect(parseSentences('')).toEqual([]);
  });

  it('returns [] when there are no sentence tags', () => {
    expect(parseSentences('This is a sentence.')).toEqual([]);
  });

  it('parses a single sentence', () => {
    expect(parseSentences('<sentence>This is a sentence.</sentence>')).toEqual([
      'This is a sentence.',
    ]);
  });

  it('parses multiple sentences', () => {
    expect(
      parseSentences(
        '<sentence>Sentence 1.</sentence><sentence>Sentence 2.</sentence>',
      ),
    ).toEqual(['Sentence 1.', 'Sentence 2.']);
  });

  it('parses sentences with bullets', () => {
    const text = `<sentence>There are three kinds of fruits:</sentence>
<sentence>1. Apples are red.</sentence>
<sentence>2. Bananas are green.</sentence>
<sentence>3. Pears are purple.</sentence>`;
    expect(parseSentences(text)).toEqual([
      'There are three kinds of fruits:',
      '1. Apples are red.',
      '2. Bananas are green.',
      '3. Pears are purple.',
    ]);
  });

  it('parses across newlines and ignores misspelled closing tags', () => {
    const text = `<sentence>This is a sentence with


newlines.</sentence>
<sentence>This sentence won't be parsed because tag is misspelled</stenence>`;
    expect(parseSentences(text)).toEqual([
      'This is a sentence with\n\n\nnewlines.',
    ]);
  });
});

describe('parseValidationResults', () => {
  it('parses multiple validation blocks, mapping null to undefined', () => {
    const text = `sentence: Apples are red.
label: supported
rationale: The context explicitly states that apples are red.
supporting_excerpt: Apples are red fruits.
contradicting_excerpt: null

sentence: Bananas are green.
label: contradictory
rationale: The context states that bananas are yellow, not green.
supporting_excerpt: null
contradicting_excerpt: Bananas are yellow fruits.
`;
    expect(parseValidationResults(text)).toEqual([
      {
        sentence: 'Apples are red.',
        label: 'supported',
        rationale: 'The context explicitly states that apples are red.',
        supportingExcerpt: 'Apples are red fruits.',
        contradictingExcerpt: undefined,
      },
      {
        sentence: 'Bananas are green.',
        label: 'contradictory',
        rationale: 'The context states that bananas are yellow, not green.',
        supportingExcerpt: undefined,
        contradictingExcerpt: 'Bananas are yellow fruits.',
      },
    ]);
  });

  it('returns [] for empty input', () => {
    expect(parseValidationResults('')).toEqual([]);
  });
});

describe('createContextForStep', () => {
  it('assembles the header and step blocks', () => {
    const tool = {functionDeclarations: [{name: 'tool1'}]};
    const appDetails = AppDetailsSchema.parse({
      agentDetails: {
        root: {
          name: 'root',
          instructions: 'Root agent instructions.',
          toolDeclarations: [tool],
        },
      },
    });
    const invocation = InvocationSchema.parse({
      userContent: {parts: [{text: 'User query.'}]},
    });
    const toolCall = {id: '1', name: 'tool1', args: {}};
    const toolResponse = {
      id: '1',
      name: 'tool1',
      response: {result: 'tool1 response'},
    };
    const events = [
      {author: 'root', content: {parts: [{functionCall: toolCall}]}},
      {author: 'root', content: {parts: [{functionResponse: toolResponse}]}},
    ];

    const context = createContextForStep(appDetails, invocation, events);
    const expected = `Developer instructions:
root:
Root agent instructions.

User prompt:
User query.

Tool definitions:
${JSON.stringify({toolDeclarations: {root: [tool]}}, null, 2)}

tool_calls:
${JSON.stringify([toolCall], null, 2)}

tool_outputs:
${JSON.stringify([toolResponse], null, 2)}
`;
    expect(context).toBe(expected);
  });

  it('handles no app details, empty user content, and events without content', () => {
    const invocation = InvocationSchema.parse({userContent: {parts: []}});
    const context = createContextForStep(undefined, invocation, [
      {author: 'root', content: undefined},
    ]);
    expect(context).toBe(
      `Developer instructions:\n\n\nUser prompt:\n\n\nTool definitions:\nAgent has no tools.\n`,
    );
  });
});

describe('HallucinationsV1Evaluator.evaluateNlResponse', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('scores supported/negative labels and averages them', async () => {
    const judge = new ScriptedJudge([
      {
        yield: textResponse(
          '<sentence>sentence 1</sentence><sentence>sentence 2</sentence>',
        ),
      },
      {
        yield: textResponse(`sentence: sentence 1
label: supported
rationale: r1
supporting_excerpt: null
contradicting_excerpt: null

sentence: sentence 2
label: unsupported
rationale: r2
supporting_excerpt: null
contradicting_excerpt: null
`),
      },
    ]);
    const metric = makeEvaluator({judge});
    const [score] = await metric.evaluateNlResponse('nl', 'ctx');
    expect(score).toBe(0.5);
  });

  it('returns undefined for unexpected labels', async () => {
    const judge = new ScriptedJudge([
      {
        yield: textResponse(
          '<sentence>sentence 1</sentence><sentence>sentence 2</sentence>',
        ),
      },
      {
        yield: textResponse(`sentence: sentence 1
label:
rationale: r1
supporting_excerpt: null
contradicting_excerpt: null

sentence: sentence 2
label: unexpected
rationale: r2
supporting_excerpt: null
contradicting_excerpt: null
`),
      },
    ]);
    const metric = makeEvaluator({judge});
    const [score] = await metric.evaluateNlResponse('nl', 'ctx');
    expect(score).toBeUndefined();
  });

  it('returns undefined when validation results cannot be parsed', async () => {
    const judge = new ScriptedJudge([
      {yield: textResponse('<sentence>sentence 1</sentence>')},
      {yield: textResponse('val_response')},
    ]);
    const metric = makeEvaluator({judge});
    const [score] = await metric.evaluateNlResponse('nl', 'ctx');
    expect(score).toBeUndefined();
  });

  it('returns undefined when the segmenter produces no sentences', async () => {
    const judge = new ScriptedJudge([{yield: textResponse('no tags here')}]);
    const metric = makeEvaluator({judge});
    const [score, message] = await metric.evaluateNlResponse('nl', 'ctx');
    expect(score).toBeUndefined();
    expect(message).toContain('No sentences produced');
  });

  it('downgrades a segmenter error', async () => {
    const judge = new ScriptedJudge([{error: new Error('boom')}]);
    const metric = makeEvaluator({judge});
    const [score, message] = await metric.evaluateNlResponse('nl', 'ctx');
    expect(score).toBeUndefined();
    expect(message).toContain('Error during sentence segmentation');
  });

  it('downgrades a validator error', async () => {
    const judge = new ScriptedJudge([
      {yield: textResponse('<sentence>sentence 1</sentence>')},
      {error: new Error('kaboom')},
    ]);
    const metric = makeEvaluator({judge});
    const [score, message] = await metric.evaluateNlResponse('nl', 'ctx');
    expect(score).toBeUndefined();
    expect(message).toContain('Error during sentence validation');
  });

  it('downgrades when the judge yields no response', async () => {
    const judge = new ScriptedJudge([{empty: true}]);
    const metric = makeEvaluator({judge});
    const [score, message] = await metric.evaluateNlResponse('nl', 'ctx');
    expect(score).toBeUndefined();
    expect(message).toContain('Error during sentence segmentation');
  });

  it('stringifies non-Error throwables from the judge', async () => {
    const judge = new ScriptedJudge([
      {error: 'plain string failure' as unknown as Error},
    ]);
    const metric = makeEvaluator({judge});
    const [score, message] = await metric.evaluateNlResponse('nl', 'ctx');
    expect(score).toBeUndefined();
    expect(message).toContain('plain string failure');
  });

  it('handles a segmenter response with no content', async () => {
    const judge = new ScriptedJudge([{yield: {content: undefined}}]);
    const metric = makeEvaluator({judge});
    const [score, message] = await metric.evaluateNlResponse('nl', 'ctx');
    expect(score).toBeUndefined();
    expect(message).toContain('No sentences produced');
  });

  it('handles a validator response with no content', async () => {
    const judge = new ScriptedJudge([
      {yield: textResponse('<sentence>s</sentence>')},
      {yield: {content: undefined}},
    ]);
    const metric = makeEvaluator({judge});
    const [score] = await metric.evaluateNlResponse('nl', 'ctx');
    expect(score).toBeUndefined();
  });
});

function agentTreeData(): {
  invocation: Invocation;
  expectedInvocation: Invocation;
  appDetails: AppDetails;
  events: InvocationEvent[];
} {
  const appDetails = AppDetailsSchema.parse({
    agentDetails: {
      root: {
        name: 'root',
        instructions: 'Root agent instructions.',
        toolDeclarations: [{functionDeclarations: [{name: 'tool_root'}]}],
      },
      agent1: {
        name: 'agent1',
        instructions: 'Agent1 instructions.',
        toolDeclarations: [{functionDeclarations: [{name: 'tool_agent1'}]}],
      },
      agent2: {name: 'agent2', instructions: 'Agent2 instructions.'},
    },
  });
  const userContent = {parts: [{text: 'User query for agent tree.'}]};
  const events = [
    {author: 'root', content: {parts: [{text: 'Hi, I am root.'}]}},
    {
      author: 'root',
      content: {parts: [{functionCall: {name: 'tool_root', args: {}}}]},
    },
    {
      author: 'root',
      content: {
        parts: [
          {
            functionResponse: {
              name: 'tool_root',
              response: {result: 'tool_root response'},
            },
          },
        ],
      },
    },
    {
      author: 'agent1',
      content: {
        parts: [{functionCall: {name: 'tool_agent1', args: {q: 1}}}],
      },
    },
    {
      author: 'agent1',
      content: {
        parts: [{functionResponse: {name: 'tool_agent1', response: {r: 2}}}],
      },
    },
    {author: 'agent2', content: {parts: [{text: 'Agent2 response.'}]}},
  ];
  const invocation = InvocationSchema.parse({
    appDetails,
    userContent,
    intermediateData: {invocationEvents: events},
    finalResponse: {parts: [{text: 'Final agent tree response.'}]},
  });
  const expectedInvocation = InvocationSchema.parse({
    appDetails,
    userContent,
    finalResponse: {parts: [{text: 'Final agent tree response.'}]},
  });
  return {invocation, expectedInvocation, appDetails, events};
}

describe('HallucinationsV1Evaluator.evaluateInvocations', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('evaluates every NL step across an agent tree with correct contexts', async () => {
    const {invocation, expectedInvocation, appDetails, events} =
      agentTreeData();
    const metric = makeEvaluator();
    vi.spyOn(metric, 'evaluateNlResponse').mockImplementation(
      async (nlResponse, context) => {
        if (nlResponse === 'Hi, I am root.') {
          expect(context.trim()).toBe(
            createContextForStep(appDetails, invocation, []).trim(),
          );
          return [1.0, ''];
        }
        if (nlResponse === 'Agent2 response.') {
          expect(context.trim()).toBe(
            createContextForStep(
              appDetails,
              invocation,
              events.slice(0, 5),
            ).trim(),
          );
          return [0.5, ''];
        }
        if (nlResponse === 'Final agent tree response.') {
          expect(context.trim()).toBe(
            createContextForStep(
              appDetails,
              invocation,
              events.slice(0, 6),
            ).trim(),
          );
          return [0.0, ''];
        }
        return [undefined, 'error'];
      },
    );

    const result = await metric.evaluateInvocations(
      [invocation],
      [expectedInvocation],
    );
    expect(result.overallScore).toBeCloseTo(0.5);
    expect(result.perInvocationResults).toHaveLength(1);
    expect(result.perInvocationResults[0].score).toBeCloseTo(0.5);
  });

  it('evaluates only the final response when intermediate steps are skipped', async () => {
    const {invocation, expectedInvocation, appDetails, events} =
      agentTreeData();
    const metric = makeEvaluator({evaluateIntermediateNlResponses: false});
    vi.spyOn(metric, 'evaluateNlResponse').mockImplementation(
      async (nlResponse, context) => {
        expect(nlResponse).toBe('Final agent tree response.');
        expect(context.trim()).toBe(
          createContextForStep(appDetails, invocation, events).trim(),
        );
        return [0.0, ''];
      },
    );

    const result = await metric.evaluateInvocations(
      [invocation],
      [expectedInvocation],
    );
    expect(result.overallScore).toBe(0.0);
    expect(result.perInvocationResults[0].score).toBe(0.0);
  });

  it('averages step scores for the success path', async () => {
    const appDetails = AppDetailsSchema.parse({
      agentDetails: {
        root: {
          name: 'root',
          instructions: 'Root agent instructions.',
          toolDeclarations: [],
        },
      },
    });
    const actual = InvocationSchema.parse({
      appDetails,
      userContent: {parts: [{text: 'User query.'}]},
      intermediateData: {
        invocationEvents: [
          {
            author: 'root',
            content: {parts: [{text: 'Intermediate NL response.'}]},
          },
          {
            author: 'root',
            content: {parts: [{text: 'Another intermediate NL response.'}]},
          },
        ],
      },
      finalResponse: {parts: [{text: 'Final response.'}]},
    });
    const expected = InvocationSchema.parse({
      appDetails,
      userContent: {parts: [{text: 'User query.'}]},
      finalResponse: {parts: [{text: 'Final response.'}]},
    });
    const metric = makeEvaluator();
    vi.spyOn(metric, 'evaluateNlResponse').mockImplementation(
      async (nlResponse) => {
        if (nlResponse === 'Intermediate NL response.') return [1.0, ''];
        if (nlResponse === 'Another intermediate NL response.')
          return [0.5, ''];
        if (nlResponse === 'Final response.') return [0.0, ''];
        return [undefined, 'error'];
      },
    );

    const result = await metric.evaluateInvocations([actual], [expected]);
    expect(result.overallScore).toBeCloseTo(0.5);
    expect(result.perInvocationResults[0].score).toBeCloseTo(0.5);
  });

  it('marks an invocation NOT_EVALUATED when there is no NL response', async () => {
    const appDetails = AppDetailsSchema.parse({
      agentDetails: {
        root: {name: 'root', instructions: 'Root agent instructions.'},
      },
    });
    const actual = InvocationSchema.parse({
      appDetails,
      userContent: {parts: [{text: 'User query.'}]},
      intermediateData: {
        invocationEvents: [
          {
            author: 'root',
            content: {parts: [{functionCall: {name: 'tool1', args: {}}}]},
          },
        ],
      },
    });
    const expected = InvocationSchema.parse({
      appDetails,
      userContent: {parts: [{text: 'User query.'}]},
    });
    const metric = makeEvaluator();
    const result = await metric.evaluateInvocations([actual], [expected]);
    expect(result.overallScore).toBeUndefined();
    expect(result.perInvocationResults[0].score).toBeUndefined();
    expect(result.perInvocationResults[0].evalStatus).toBe(
      EvalStatus.NOT_EVALUATED,
    );
  });

  it('reports NOT_EVALUATED when every step fails to evaluate', async () => {
    const appDetails = AppDetailsSchema.parse({
      agentDetails: {
        root: {name: 'root', instructions: 'Root agent instructions.'},
      },
    });
    const actual = InvocationSchema.parse({
      appDetails,
      userContent: {parts: [{text: 'User query.'}]},
      intermediateData: {
        invocationEvents: [
          {
            author: 'root',
            content: {parts: [{text: 'Intermediate NL response.'}]},
          },
        ],
      },
      finalResponse: {parts: [{text: 'Final response.'}]},
    });
    const expected = InvocationSchema.parse({
      appDetails,
      userContent: {parts: [{text: 'User query.'}]},
      finalResponse: {parts: [{text: 'Final response.'}]},
    });
    const metric = makeEvaluator();
    vi.spyOn(metric, 'evaluateNlResponse').mockResolvedValue([
      undefined,
      'Judge model error.',
    ]);

    const result = await metric.evaluateInvocations(
      [actual, actual],
      [expected, expected],
    );
    expect(result.perInvocationResults).toHaveLength(2);
    expect(result.perInvocationResults[0].score).toBeUndefined();
    expect(result.perInvocationResults[0].evalStatus).toBe(
      EvalStatus.NOT_EVALUATED,
    );
    expect(result.perInvocationResults[1].evalStatus).toBe(
      EvalStatus.NOT_EVALUATED,
    );
    expect(result.overallScore).toBeUndefined();
    expect(result.overallEvalStatus).toBe(EvalStatus.NOT_EVALUATED);
  });

  it('ignores steps that error while keeping successful ones', async () => {
    const appDetails = AppDetailsSchema.parse({
      agentDetails: {
        root: {name: 'root', instructions: 'Root agent instructions.'},
      },
    });
    const actual = InvocationSchema.parse({
      appDetails,
      userContent: {parts: [{text: 'User query.'}]},
      intermediateData: {
        invocationEvents: [
          {
            author: 'root',
            content: {parts: [{text: 'Intermediate NL response.'}]},
          },
        ],
      },
      finalResponse: {parts: [{text: 'Final response.'}]},
    });
    const expected = InvocationSchema.parse({
      appDetails,
      userContent: {parts: [{text: 'User query.'}]},
      finalResponse: {parts: [{text: 'Final response.'}]},
    });
    const metric = makeEvaluator();
    vi.spyOn(metric, 'evaluateNlResponse').mockImplementation(
      async (nlResponse) => {
        if (nlResponse === 'Intermediate NL response.') return [0.8, ''];
        return [undefined, 'some error during evaluation'];
      },
    );

    const result = await metric.evaluateInvocations([actual], [expected]);
    expect(result.overallScore).toBe(0.8);
    expect(result.perInvocationResults[0].score).toBe(0.8);
  });

  it('skips intermediate events without content when evaluating NL steps', async () => {
    const actual = InvocationSchema.parse({
      userContent: {parts: [{text: 'User query.'}]},
      intermediateData: {
        invocationEvents: [
          {author: 'root'},
          {
            author: 'root',
            content: {parts: [{text: 'Intermediate NL response.'}]},
          },
        ],
      },
      finalResponse: {parts: [{text: 'Final response.'}]},
    });
    const metric = makeEvaluator();
    vi.spyOn(metric, 'evaluateNlResponse').mockResolvedValue([1.0, '']);
    const result = await metric.evaluateInvocations([actual]);
    expect(result.overallScore).toBe(1.0);
  });

  it('returns an empty result for no invocations', async () => {
    const metric = makeEvaluator();
    const result = await metric.evaluateInvocations([]);
    expect(result.overallScore).toBeUndefined();
    expect(result.overallEvalStatus).toBe(EvalStatus.NOT_EVALUATED);
    expect(result.perInvocationResults).toEqual([]);
  });

  it('throws when the criterion is missing', () => {
    vi.spyOn(LLMRegistry, 'newLlm').mockReturnValue(new ScriptedJudge([]));
    expect(
      () =>
        new HallucinationsV1Evaluator({
          metricName: 'hallucinations_v1',
          threshold: 0.5,
        }),
    ).toThrow();
  });

  it('throws when the criterion fails schema validation', () => {
    vi.spyOn(LLMRegistry, 'newLlm').mockReturnValue(new ScriptedJudge([]));
    expect(
      () =>
        new HallucinationsV1Evaluator({
          metricName: 'hallucinations_v1',
          threshold: 0.5,
          criterion: BaseCriterionSchema.parse({
            threshold: 0.5,
            judgeModelOptions: {numSamples: 'not-a-number'},
          }),
        }),
    ).toThrow();
  });

  it('resolves the threshold from the criterion when the metric omits it', async () => {
    vi.spyOn(LLMRegistry, 'newLlm').mockReturnValue(new ScriptedJudge([]));
    const metric = new HallucinationsV1Evaluator({
      metricName: 'hallucinations_v1',
      criterion: HallucinationsCriterionSchema.parse({
        threshold: 0.5,
        judgeModelOptions: {judgeModel: 'gemini-2.5-flash', numSamples: 1},
      }),
    });
    vi.spyOn(metric, 'evaluateNlResponse').mockResolvedValue([1.0, '']);
    const actual = InvocationSchema.parse({
      userContent: {parts: [{text: 'q'}]},
      finalResponse: {parts: [{text: 'a'}]},
    });
    const result = await metric.evaluateInvocations([actual]);
    expect(result.overallScore).toBe(1.0);
  });

  it('defaults the judge model options when omitted', () => {
    const newLlm = vi
      .spyOn(LLMRegistry, 'newLlm')
      .mockReturnValue(new ScriptedJudge([]));
    const evaluator = new HallucinationsV1Evaluator({
      metricName: 'hallucinations_v1',
      threshold: 0.5,
      criterion: HallucinationsCriterionSchema.parse({threshold: 0.5}),
    });
    expect(evaluator).toBeInstanceOf(HallucinationsV1Evaluator);
    expect(newLlm).toHaveBeenCalledWith('gemini-2.5-flash');
  });
});
