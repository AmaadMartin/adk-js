/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ported from `google/adk-python`
 * `tests/unittests/evaluation/test_hallucinations_v1.py`. Each `it()` keeps
 * the Python test name, so the two suites stay greppable against each other.
 *
 * Where the Python tests patch `_evaluate_nl_response`, these script
 * {@link FakeJudgeLlm} instead, so the metric's own two-step pipeline runs.
 *
 * The `describe` blocks below the ported ones cover the paths the Python suite
 * does not reach: criterion validation, the judge failure modes, the retry
 * policy, and the report the validator produces.
 */

import {
  AppDetails,
  BaseLlm,
  BaseLlmConnection,
  EvalMetric,
  EvalStatus,
  HallucinationsV1Evaluator,
  InputValidationError,
  Invocation,
  InvocationEvent,
  LLMRegistry,
  LlmResponse,
  PrebuiltMetrics,
} from '@google/adk';
import {describe, expect, it} from 'vitest';
// The metric's own helpers are internal, as they are in adk-python, so they
// are reached through the module rather than the package entry point.
import {
  createContextForStep,
  evaluateNlResponse,
  parseSentences,
  parseValidationResults,
} from '../../src/evaluation/hallucinations_v1.js';
import {FakeJudgeLlm, JudgeReply} from './fake_judge_llm.js';

/** The attempt count `addDefaultRetryOptionsIfNotPresent` stamps. */
const DEFAULT_RETRY_ATTEMPTS = 7;

const NON_ERROR_FAILURE = 'the judge rejected with a plain string';

/** A judge that rejects with a value that is not an `Error`. */
class NonErrorJudgeLlm extends BaseLlm {
  constructor() {
    super({model: 'non-error-judge'});
  }

  async *generateContentAsync(): AsyncGenerator<LlmResponse, void> {
    yield await Promise.reject(NON_ERROR_FAILURE);
  }

  async connect(): Promise<BaseLlmConnection> {
    throw new Error('NonErrorJudgeLlm does not support live connections.');
  }
}

const REGISTERED_JUDGE_MODEL = 'hallucinations-registry-judge';

let registeredJudgeCalls = 0;

/** A judge the metric can only reach through {@link LLMRegistry}. */
class RegisteredJudgeLlm extends BaseLlm {
  static readonly supportedModels = [REGISTERED_JUDGE_MODEL];

  async *generateContentAsync(): AsyncGenerator<LlmResponse, void> {
    registeredJudgeCalls++;
    yield {content: {role: 'model', parts: [{text: 'no sentence tags'}]}};
  }

  async connect(): Promise<BaseLlmConnection> {
    throw new Error('RegisteredJudgeLlm does not support live connections.');
  }
}

LLMRegistry.register(RegisteredJudgeLlm);

function createInvocation(finalResponse = 'Final response.'): Invocation {
  return {
    userContent: USER_CONTENT,
    finalResponse: {parts: [{text: finalResponse}]},
  };
}

const CONTEXT_START = '**Context Begin**\n';
const CONTEXT_END = '\n**Context End**';
const RESPONSE_START = '**Response Begin**\n';
const RESPONSE_END = '\n**Response End**';

/** One validator block, in the shape the validator prompt asks for. */
function validatorBlock(sentence: string, label: string): string {
  return [
    `sentence: ${sentence}`,
    `label: ${label}`,
    'rationale: The judge explained itself here.',
    'supporting_excerpt: null',
    'contradicting_excerpt: null',
  ].join('\n');
}

/**
 * A two-reply judge script that grades one natural language response with the
 * given labels, one sentence per label.
 */
function gradeWith(...labels: string[]): JudgeReply[] {
  const sentences = labels.map(
    (label, index) => `Sentence ${index} is ${label}.`,
  );
  return [
    {
      critique: sentences
        .map((sentence) => `<sentence>${sentence}</sentence>`)
        .join('\n'),
    },
    {
      critique: sentences
        .map((sentence, index) => validatorBlock(sentence, labels[index]))
        .join('\n\n'),
    },
  ];
}

/** The prompt text of every call the judge received, in order. */
function judgePrompts(judge: FakeJudgeLlm): string[] {
  return judge.requests.map(
    (request) => request.contents[0].parts?.[0].text ?? '',
  );
}

/**
 * Reads the value the metric substituted into a prompt placeholder. The
 * prompts show the placeholder once in their worked example and once for
 * real, so the last block is the filled one.
 */
function lastBlock(prompt: string, start: string, end: string): string {
  return prompt.slice(
    prompt.lastIndexOf(start) + start.length,
    prompt.lastIndexOf(end),
  );
}

/** The contexts the metric put in front of the sentence validator, in order. */
function validatorContexts(judge: FakeJudgeLlm): string[] {
  return judgePrompts(judge)
    .filter((prompt) => prompt.includes(CONTEXT_START))
    .map((prompt) => lastBlock(prompt, CONTEXT_START, CONTEXT_END));
}

/** The responses the metric put in front of the segmenter, in order. */
function segmentedResponses(judge: FakeJudgeLlm): string[] {
  return judgePrompts(judge)
    .filter((prompt) => prompt.includes(RESPONSE_START))
    .map((prompt) => lastBlock(prompt, RESPONSE_START, RESPONSE_END));
}

function createEvalMetric(
  criterion?: EvalMetric['criterion'],
  metricName: string = PrebuiltMetrics.HALLUCINATIONS_V1,
): EvalMetric {
  return {metricName, threshold: 0.5, criterion};
}

function createEvaluator(
  judge: FakeJudgeLlm,
  evaluateIntermediateNlResponses: boolean,
): HallucinationsV1Evaluator {
  return new HallucinationsV1Evaluator(
    createEvalMetric({
      threshold: 0.5,
      judgeModelOptions: {
        judgeModel: 'gemini-2.5-flash',
        judgeModelConfig: {temperature: 0},
        numSamples: 1,
      },
      evaluateIntermediateNlResponses,
    }),
    judge,
  );
}

describe('TestParseSentences', () => {
  it('test_parse_sentences_empty', () => {
    expect(parseSentences('')).toEqual([]);
  });

  it('test_parse_sentences_no_sentence', () => {
    expect(parseSentences('This is a sentence.')).toEqual([]);
  });

  it('test_parse_sentences_one_sentence', () => {
    expect(parseSentences('<sentence>This is a sentence.</sentence>')).toEqual([
      'This is a sentence.',
    ]);
  });

  it('test_parse_sentences_multiple_sentences', () => {
    expect(
      parseSentences(
        '<sentence>Sentence 1.</sentence><sentence>Sentence 2.</sentence>',
      ),
    ).toEqual(['Sentence 1.', 'Sentence 2.']);
  });

  it('test_parse_sentences_with_bullets', () => {
    const textWithBullets = `<sentence>There are three kinds of fruits:</sentence>
<sentence>1. Apples are red.</sentence>
<sentence>2. Bananas are green.</sentence>
<sentence>3. Pears are purple.</sentence>`;
    expect(parseSentences(textWithBullets)).toEqual([
      'There are three kinds of fruits:',
      '1. Apples are red.',
      '2. Bananas are green.',
      '3. Pears are purple.',
    ]);
  });

  it('test_parse_sentences_with_newlines', () => {
    const textWithNewlines = `<sentence>This is a sentence with

\nnewlines.</sentence>
<sentence>This sentence won't be parsed because tag is misspelled</stenence>`;
    expect(parseSentences(textWithNewlines)).toEqual([
      'This is a sentence with\n\n\nnewlines.',
    ]);
  });
});

describe('TestParseValidationResults', () => {
  it('test_parse_validation_results', () => {
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

sentence: Pears are purple.
label: disputed
rationale: The context states that pears are purple but it also states that pears are blue.
supporting_excerpt: Pears are purple fruits
contradicting_excerpt: Pears are blue fruits
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
      {
        sentence: 'Pears are purple.',
        label: 'disputed',
        rationale:
          'The context states that pears are purple but it also states that' +
          ' pears are blue.',
        supportingExcerpt: 'Pears are purple fruits',
        contradictingExcerpt: 'Pears are blue fruits',
      },
    ]);
  });

  it('test_parse_validation_results_empty', () => {
    expect(parseValidationResults('')).toEqual([]);
  });
});

describe('TestEvaluateNlResponse', () => {
  it('test_evaluate_nl_response_unexpected_labels', async () => {
    const validatorText = `sentence: sentence 1
label:
rationale: r1
supporting_excerpt: null
contradicting_excerpt: null

sentence: sentence 2
label: unexpected
rationale: r2
supporting_excerpt: null
contradicting_excerpt: null
`;
    const judge = new FakeJudgeLlm([
      {
        critique:
          '<sentence>sentence 1</sentence><sentence>sentence 2</sentence>',
      },
      {critique: validatorText},
    ]);

    const {score} = await evaluateNlResponse(judge, {}, 'nl', 'ctx');

    expect(score).toBeUndefined();
  });

  it('test_evaluate_nl_response_missing_label', async () => {
    const judge = new FakeJudgeLlm([
      {critique: '<sentence>sentence 1</sentence>'},
      {critique: 'val_response'},
    ]);

    const {score} = await evaluateNlResponse(judge, {}, 'nl', 'ctx');

    expect(score).toBeUndefined();
  });
});

/** The fixture behind `create_context_data` in the Python suite. */
function createContextData(): {
  appDetails: AppDetails;
  events: InvocationEvent[];
  invocation: Invocation;
} {
  const appDetails: AppDetails = {
    agentDetails: {
      root: {
        name: 'root',
        instructions: 'Root agent instructions.',
        toolDeclarations: [{functionDeclarations: [{name: 'tool1'}]}],
      },
    },
  };
  const events: InvocationEvent[] = [
    {
      author: 'root',
      content: {parts: [{functionCall: {id: '1', args: {}, name: 'tool1'}}]},
    },
    {
      author: 'root',
      content: {
        parts: [
          {
            functionResponse: {
              id: '1',
              name: 'tool1',
              response: {result: 'tool1 response'},
            },
          },
        ],
      },
    },
    {
      author: 'root',
      content: {
        parts: [
          {text: 'Intermediate NL response.'},
          {functionCall: {id: '2', args: {}, name: 'tool1'}},
        ],
      },
    },
    {
      author: 'root',
      content: {
        parts: [
          {
            functionResponse: {
              id: '2',
              name: 'tool1',
              response: {result: 'tool1 response 2'},
            },
          },
        ],
      },
    },
  ];
  return {
    appDetails,
    events,
    invocation: {
      appDetails,
      userContent: {parts: [{text: 'User query.'}]},
      intermediateData: {invocationEvents: events},
    },
  };
}

describe('TestCreateContext', () => {
  it('test_create_context_for_intermediate_step', () => {
    const {appDetails, events, invocation} = createContextData();

    const context = createContextForStep(
      appDetails,
      invocation,
      events.slice(0, 2),
    );

    const expectedContext = `Developer instructions:
root:
Root agent instructions.

User prompt:
User query.

Tool definitions:
{
  "tool_declarations": {
    "root": [
      {
        "function_declarations": [
          {
            "name": "tool1"
          }
        ]
      }
    ]
  }
}

tool_calls:
[
  {
    "id": "1",
    "args": {},
    "name": "tool1"
  }
]

tool_outputs:
[
  {
    "id": "1",
    "name": "tool1",
    "response": {
      "result": "tool1 response"
    }
  }
]`;
    expect(context.trim()).toBe(expectedContext.trim());
  });

  it('test_create_context_for_final_step', () => {
    const {appDetails, events, invocation} = createContextData();

    const context = createContextForStep(appDetails, invocation, events);

    const expectedContext = `Developer instructions:
root:
Root agent instructions.

User prompt:
User query.

Tool definitions:
{
  "tool_declarations": {
    "root": [
      {
        "function_declarations": [
          {
            "name": "tool1"
          }
        ]
      }
    ]
  }
}

tool_calls:
[
  {
    "id": "1",
    "args": {},
    "name": "tool1"
  }
]

tool_outputs:
[
  {
    "id": "1",
    "name": "tool1",
    "response": {
      "result": "tool1 response"
    }
  }
]

Intermediate NL response.

tool_calls:
[
  {
    "id": "2",
    "args": {},
    "name": "tool1"
  }
]

tool_outputs:
[
  {
    "id": "2",
    "name": "tool1",
    "response": {
      "result": "tool1 response 2"
    }
  }
]`;
    expect(context.trim()).toBe(expectedContext.trim());
  });
});

/** The fixture behind `agent_tree_data` in the Python suite. */
function createAgentTreeData(): {
  invocation: Invocation;
  expectedInvocation: Invocation;
} {
  const appDetails: AppDetails = {
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
      agent2: {
        name: 'agent2',
        instructions: 'Agent2 instructions.',
        toolDeclarations: [],
      },
    },
  };
  const userContent = {parts: [{text: 'User query for agent tree.'}]};
  const events: InvocationEvent[] = [
    {author: 'root', content: {parts: [{text: 'Hi, I am root.'}]}},
    {
      author: 'root',
      content: {parts: [{functionCall: {args: {}, name: 'tool_root'}}]},
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
      content: {parts: [{functionCall: {args: {q: 1}, name: 'tool_agent1'}}]},
    },
    {
      author: 'agent1',
      content: {
        parts: [{functionResponse: {name: 'tool_agent1', response: {r: 2}}}],
      },
    },
    {author: 'agent2', content: {parts: [{text: 'Agent2 response.'}]}},
  ];
  const finalResponse = {parts: [{text: 'Final agent tree response.'}]};
  return {
    invocation: {
      appDetails,
      userContent,
      intermediateData: {invocationEvents: events},
      finalResponse,
    },
    expectedInvocation: {appDetails, userContent, finalResponse},
  };
}

const AGENT_TREE_HEADER = `Developer instructions:
root:
Root agent instructions.

agent1:
Agent1 instructions.

agent2:
Agent2 instructions.

User prompt:
User query for agent tree.

Tool definitions:
{
  "tool_declarations": {
    "root": [
      {
        "function_declarations": [
          {
            "name": "tool_root"
          }
        ]
      }
    ],
    "agent1": [
      {
        "function_declarations": [
          {
            "name": "tool_agent1"
          }
        ]
      }
    ],
    "agent2": []
  }
}`;

const AGENT_TREE_STEPS = `
Hi, I am root.

tool_calls:
[
  {
    "args": {},
    "name": "tool_root"
  }
]

tool_outputs:
[
  {
    "name": "tool_root",
    "response": {
      "result": "tool_root response"
    }
  }
]

tool_calls:
[
  {
    "args": {
      "q": 1
    },
    "name": "tool_agent1"
  }
]

tool_outputs:
[
  {
    "name": "tool_agent1",
    "response": {
      "r": 2
    }
  }
]`;

describe('TestEvaluateInvocationsAgentTree', () => {
  it('test_evaluate_invocations_multi_agents', async () => {
    const {invocation, expectedInvocation} = createAgentTreeData();
    const judge = new FakeJudgeLlm([
      ...gradeWith('supported'),
      ...gradeWith('supported', 'unsupported'),
      ...gradeWith('contradictory'),
    ]);
    const metric = createEvaluator(judge, true);

    const result = await metric.evaluateInvocations(
      [invocation],
      [expectedInvocation],
    );

    expect(segmentedResponses(judge)).toEqual([
      'Hi, I am root.',
      'Agent2 response.',
      'Final agent tree response.',
    ]);
    expect(validatorContexts(judge).map((context) => context.trim())).toEqual([
      AGENT_TREE_HEADER,
      `${AGENT_TREE_HEADER}\n${AGENT_TREE_STEPS}`.trim(),
      `${AGENT_TREE_HEADER}\n${AGENT_TREE_STEPS}\n\nAgent2 response.`.trim(),
    ]);
    expect(result.overallScore).toBeCloseTo(0.5);
    expect(result.perInvocationResults).toHaveLength(1);
    expect(result.perInvocationResults[0].score).toBeCloseTo(0.5);
  });

  it('test_evaluate_invocations_agent_tree_skip_intermediate', async () => {
    const {invocation, expectedInvocation} = createAgentTreeData();
    const judge = new FakeJudgeLlm(gradeWith('contradictory'));
    const metric = createEvaluator(judge, false);

    const result = await metric.evaluateInvocations(
      [invocation],
      [expectedInvocation],
    );

    expect(segmentedResponses(judge)).toEqual(['Final agent tree response.']);
    expect(validatorContexts(judge).map((context) => context.trim())).toEqual([
      `${AGENT_TREE_HEADER}\n${AGENT_TREE_STEPS}\n\nAgent2 response.`.trim(),
    ]);
    expect(result.overallScore).toBe(0.0);
    expect(result.perInvocationResults).toHaveLength(1);
    expect(result.perInvocationResults[0].score).toBe(0.0);
  });
});

const TIME_WEATHER_RESPONSE_1 =
  'The time in San Francisco is currently 10:30am PST. The date is' +
  ' September 21, 2025. I will now get the weather.';

const TIME_WEATHER_RESPONSE_2 =
  'It is currently September 19, 2025, 10:30am PST in San Francisco. The' +
  ' weather is 65F with partly cloudy skies.';

/** The fixture behind `time_weather_data` in the Python suite. */
function createTimeWeatherData(): Invocation {
  const appDetails: AppDetails = {
    agentDetails: {
      root: {
        name: 'root',
        instructions:
          'You are an agent that can get the current time and weather.',
        toolDeclarations: [
          {
            functionDeclarations: [
              {name: 'get_current_time'},
              {name: 'get_weather'},
            ],
          },
        ],
      },
    },
  };
  const events: InvocationEvent[] = [
    {
      author: 'root',
      content: {
        parts: [
          {
            functionCall: {
              args: {location: 'San Francisco, CA'},
              name: 'get_current_time',
            },
          },
        ],
      },
    },
    {
      author: 'root',
      content: {
        parts: [
          {
            functionResponse: {
              name: 'get_current_time',
              response: {time: '10:30 AM PST Sep 19, 2025'},
            },
          },
        ],
      },
    },
    {
      author: 'root',
      content: {
        parts: [
          {text: TIME_WEATHER_RESPONSE_1},
          {
            functionCall: {
              args: {
                location: 'San Francisco, CA',
                time: '10:30 AM PST Sep 19, 2025',
              },
              name: 'get_weather',
            },
          },
        ],
      },
    },
    {
      author: 'root',
      content: {
        parts: [
          {
            functionResponse: {
              name: 'get_weather',
              response: {weather: 'Partly cloudy, 65F'},
            },
          },
        ],
      },
    },
  ];
  return {
    appDetails,
    userContent: {
      parts: [{text: 'Get the current time and weather of San Francisco.'}],
    },
    intermediateData: {invocationEvents: events},
    finalResponse: {parts: [{text: TIME_WEATHER_RESPONSE_2}]},
  };
}

const TIME_WEATHER_CONTEXT_1 = `Developer instructions:
root:
You are an agent that can get the current time and weather.

User prompt:
Get the current time and weather of San Francisco.

Tool definitions:
{
  "tool_declarations": {
    "root": [
      {
        "function_declarations": [
          {
            "name": "get_current_time"
          },
          {
            "name": "get_weather"
          }
        ]
      }
    ]
  }
}

tool_calls:
[
  {
    "args": {
      "location": "San Francisco, CA"
    },
    "name": "get_current_time"
  }
]

tool_outputs:
[
  {
    "name": "get_current_time",
    "response": {
      "time": "10:30 AM PST Sep 19, 2025"
    }
  }
]`;

const TIME_WEATHER_CONTEXT_2 = `${TIME_WEATHER_CONTEXT_1}

${TIME_WEATHER_RESPONSE_1}

tool_calls:
[
  {
    "args": {
      "location": "San Francisco, CA",
      "time": "10:30 AM PST Sep 19, 2025"
    },
    "name": "get_weather"
  }
]

tool_outputs:
[
  {
    "name": "get_weather",
    "response": {
      "weather": "Partly cloudy, 65F"
    }
  }
]`;

describe('TestEvaluateInvocationsTimeWeather', () => {
  it('test_evaluate_invocations_time_weather', async () => {
    const invocation = createTimeWeatherData();
    const judge = new FakeJudgeLlm([
      ...gradeWith('supported', 'contradictory', 'supported'),
      ...gradeWith('supported', 'supported'),
    ]);
    const metric = createEvaluator(judge, true);

    const result = await metric.evaluateInvocations([invocation], [invocation]);

    expect(segmentedResponses(judge)).toEqual([
      TIME_WEATHER_RESPONSE_1,
      TIME_WEATHER_RESPONSE_2,
    ]);
    expect(validatorContexts(judge).map((context) => context.trim())).toEqual([
      TIME_WEATHER_CONTEXT_1,
      TIME_WEATHER_CONTEXT_2,
    ]);
    expect(result.overallScore).toBeCloseTo(5 / 6);
    expect(result.perInvocationResults).toHaveLength(1);
    expect(result.perInvocationResults[0].score).toBeCloseTo(5 / 6);
  });

  it('test_evaluate_invocations_time_weather_skip_intermediate', async () => {
    const invocation = createTimeWeatherData();
    const judge = new FakeJudgeLlm(gradeWith('supported', 'supported'));
    const metric = createEvaluator(judge, false);

    const result = await metric.evaluateInvocations([invocation], [invocation]);

    expect(segmentedResponses(judge)).toEqual([TIME_WEATHER_RESPONSE_2]);
    expect(validatorContexts(judge).map((context) => context.trim())).toEqual([
      TIME_WEATHER_CONTEXT_2,
    ]);
    expect(result.overallScore).toBe(1.0);
    expect(result.perInvocationResults).toHaveLength(1);
    expect(result.perInvocationResults[0].score).toBe(1.0);
  });
});

const SIMPLE_APP_DETAILS: AppDetails = {
  agentDetails: {
    root: {
      name: 'root',
      instructions: 'Root agent instructions.',
      toolDeclarations: [],
    },
  },
};

const USER_CONTENT = {parts: [{text: 'User query.'}]};

/** An invocation with `intermediateNlResponses` intermediate text events. */
function createSimpleInvocation(intermediateNlResponses: string[]): Invocation {
  return {
    appDetails: SIMPLE_APP_DETAILS,
    userContent: USER_CONTENT,
    intermediateData: {
      invocationEvents: intermediateNlResponses.map((text) => ({
        author: 'root',
        content: {parts: [{text}]},
      })),
    },
    finalResponse: {parts: [{text: 'Final response.'}]},
  };
}

const SIMPLE_EXPECTED_INVOCATION: Invocation = {
  appDetails: SIMPLE_APP_DETAILS,
  userContent: USER_CONTENT,
  finalResponse: {parts: [{text: 'Final response.'}]},
};

it('test_evaluate_invocations_success_path', async () => {
  const actualInvocation = createSimpleInvocation([
    'Intermediate NL response.',
    'Another intermediate NL response.',
  ]);
  const judge = new FakeJudgeLlm([
    ...gradeWith('supported'),
    ...gradeWith('supported', 'unsupported'),
    ...gradeWith('contradictory'),
  ]);
  const metric = createEvaluator(judge, true);

  const result = await metric.evaluateInvocations(
    [actualInvocation],
    [SIMPLE_EXPECTED_INVOCATION],
  );

  expect(result.overallScore).toBeCloseTo(0.5);
  expect(result.perInvocationResults).toHaveLength(1);
  expect(result.perInvocationResults[0].score).toBeCloseTo(0.5);
});

it('test_evaluate_invocations_no_nl_response', async () => {
  const actualInvocation: Invocation = {
    appDetails: SIMPLE_APP_DETAILS,
    userContent: USER_CONTENT,
    intermediateData: {
      invocationEvents: [
        {
          author: 'root',
          content: {parts: [{functionCall: {name: 'tool1', args: {}}}]},
        },
      ],
    },
  };
  const judge = new FakeJudgeLlm(gradeWith('supported'));
  const metric = createEvaluator(judge, true);

  const result = await metric.evaluateInvocations(
    [actualInvocation],
    [{appDetails: SIMPLE_APP_DETAILS, userContent: USER_CONTENT}],
  );

  expect(judge.requests).toHaveLength(0);
  expect(result.overallScore).toBeUndefined();
  expect(result.perInvocationResults).toHaveLength(1);
  expect(result.perInvocationResults[0].score).toBeUndefined();
  expect(result.perInvocationResults[0].evalStatus).toBe(
    EvalStatus.NOT_EVALUATED,
  );
});

it('test_evaluate_all_invocations_not_evaluated', async () => {
  const actualInvocation = createSimpleInvocation([
    'Intermediate NL response.',
  ]);
  const judge = new FakeJudgeLlm([{failure: 'Judge model error.'}]);
  const metric = createEvaluator(judge, true);

  const result = await metric.evaluateInvocations(
    [actualInvocation, actualInvocation],
    [SIMPLE_EXPECTED_INVOCATION, SIMPLE_EXPECTED_INVOCATION],
  );

  expect(result.perInvocationResults).toHaveLength(2);
  expect(result.perInvocationResults[0].score).toBeUndefined();
  expect(result.perInvocationResults[0].evalStatus).toBe(
    EvalStatus.NOT_EVALUATED,
  );
  expect(result.perInvocationResults[1].score).toBeUndefined();
  expect(result.perInvocationResults[1].evalStatus).toBe(
    EvalStatus.NOT_EVALUATED,
  );
  expect(result.overallScore).toBeUndefined();
  expect(result.overallEvalStatus).toBe(EvalStatus.NOT_EVALUATED);
});

it('test_evaluate_invocations_partial_failure', async () => {
  const actualInvocation = createSimpleInvocation([
    'Intermediate NL response.',
  ]);
  const judge = new FakeJudgeLlm([
    ...gradeWith(
      'supported',
      'supported',
      'supported',
      'supported',
      'unsupported',
    ),
    {failure: 'some error during evaluation'},
  ]);
  const metric = createEvaluator(judge, true);

  const result = await metric.evaluateInvocations(
    [actualInvocation],
    [SIMPLE_EXPECTED_INVOCATION],
  );

  expect(result.overallScore).toBe(0.8);
  expect(result.perInvocationResults).toHaveLength(1);
  expect(result.perInvocationResults[0].score).toBe(0.8);
});

describe('criterion validation', () => {
  it('rejects a metric that carries no criterion', () => {
    expect(() => new HallucinationsV1Evaluator(createEvalMetric())).toThrow(
      InputValidationError,
    );
  });

  it('names the metric and the criterion type it expects', () => {
    let thrown: unknown;
    try {
      new HallucinationsV1Evaluator(createEvalMetric(undefined, 'my_metric'));
    } catch (error: unknown) {
      thrown = error;
    }

    if (!(thrown instanceof InputValidationError)) {
      expect.fail('expected an InputValidationError');
    }
    expect(thrown.message).toContain(
      '`my_metric` metric expects a criterion of type' +
        ' `HallucinationsCriterion`.',
    );
    expect(thrown.cause).toBeInstanceOf(Error);
  });

  it('rejects a criterion whose threshold is not a number', () => {
    expect(
      () =>
        new HallucinationsV1Evaluator(
          createEvalMetric({threshold: Number.NaN}),
        ),
    ).toThrow(InputValidationError);
  });

  it('resolves the judge from the registry when none is supplied', async () => {
    const metric = new HallucinationsV1Evaluator(
      createEvalMetric({
        threshold: 0.5,
        judgeModelOptions: {judgeModel: REGISTERED_JUDGE_MODEL},
      }),
    );

    const result = await metric.evaluateInvocations([createInvocation()]);

    expect(registeredJudgeCalls).toBeGreaterThan(0);
    expect(result.perInvocationResults[0].score).toBeUndefined();
  });
});

describe('evaluateInvocations', () => {
  it('returns an empty result for an empty invocation list', async () => {
    const metric = createEvaluator(new FakeJudgeLlm([{silent: true}]), true);

    const result = await metric.evaluateInvocations([]);

    expect(result.perInvocationResults).toEqual([]);
    expect(result.overallScore).toBeUndefined();
    expect(result.overallEvalStatus).toBe(EvalStatus.NOT_EVALUATED);
  });

  it('rejects invocation lists of different lengths', async () => {
    const metric = createEvaluator(new FakeJudgeLlm([{silent: true}]), true);

    await expect(
      metric.evaluateInvocations([createInvocation()], []),
    ).rejects.toThrow(InputValidationError);
  });

  it('stamps the default retry policy on both judge requests', async () => {
    const judge = new FakeJudgeLlm([
      {critique: '<sentence>Final response.</sentence>'},
      {
        critique: [
          'sentence: Final response.',
          'label: supported',
          'rationale: The context says so.',
          'supporting_excerpt: The context says so.',
          'contradicting_excerpt: null',
        ].join('\n'),
      },
    ]);
    const metric = createEvaluator(judge, true);

    const result = await metric.evaluateInvocations([createInvocation()]);

    expect(judge.requests).toHaveLength(2);
    for (const request of judge.requests) {
      expect(request.config?.httpOptions?.retryOptions?.attempts).toBe(
        DEFAULT_RETRY_ATTEMPTS,
      );
    }
    expect(result.perInvocationResults[0].score).toBe(1);
    expect(result.perInvocationResults[0].evalStatus).toBe(EvalStatus.PASSED);
    expect(result.perInvocationResults[0].rubricScores).toEqual([]);
  });

  it('ignores a recorded tool trajectory, which carries no events', async () => {
    const judge = new FakeJudgeLlm([
      {critique: '<sentence>Final response.</sentence>'},
      {critique: 'unparseable'},
    ]);
    const metric = createEvaluator(judge, true);

    await metric.evaluateInvocations([
      {
        ...createInvocation(),
        intermediateData: {
          toolUses: [{name: 'tool1', args: {}}],
          toolResponses: [],
          intermediateResponses: [],
        },
      },
    ]);

    const validatorPrompt = judge.requests[1].contents[0].parts?.[0].text ?? '';
    expect(validatorPrompt).not.toContain('tool_calls:');
  });

  it('grades no intermediate step for an event that carries no content', async () => {
    const judge = new FakeJudgeLlm([
      {critique: '<sentence>Final response.</sentence>'},
      {critique: 'unparseable'},
    ]);
    const metric = createEvaluator(judge, true);

    await metric.evaluateInvocations([
      {
        ...createInvocation(),
        intermediateData: {invocationEvents: [{author: 'root'}]},
      },
    ]);

    expect(judge.requests).toHaveLength(2);
  });
});

describe('createContextForStep', () => {
  it('reports that the agent has no tools when the app is unknown', () => {
    const context = createContextForStep(
      undefined,
      {userContent: USER_CONTENT},
      [],
    );

    expect(context.trim()).toBe(
      [
        'Developer instructions:',
        '',
        '',
        'User prompt:',
        'User query.',
        '',
        'Tool definitions:',
        'Agent has no tools.',
      ].join('\n'),
    );
  });

  it('names no agent when the app declares none', () => {
    const context = createContextForStep({}, {userContent: USER_CONTENT}, []);

    expect(context).toContain('Developer instructions:\n\n');
    expect(context).toContain('{\n  "tool_declarations": {}\n}');
  });

  it('skips an agent that carries no instructions', () => {
    const appDetails: AppDetails = {
      agentDetails: {
        root: {name: 'root', instructions: 'Root agent instructions.'},
        silent: {name: 'silent'},
      },
    };

    const context = createContextForStep(
      appDetails,
      {userContent: USER_CONTENT},
      [{author: 'root'}],
    );

    expect(context).toContain('Developer instructions:\nroot:\nRoot agent');
    expect(context).not.toContain('silent:\n');
    expect(context).toContain('"silent": []');
  });
});

describe('evaluateNlResponse', () => {
  it('reports a segmenter that answered nothing', async () => {
    const judge = new FakeJudgeLlm([{silent: true}]);

    const result = await evaluateNlResponse(judge, {}, 'nl', 'ctx');

    expect(result).toEqual({details: 'Segmenter returned no text.'});
  });

  it('reports a segmenter that produced no sentences', async () => {
    const judge = new FakeJudgeLlm([{critique: 'no tags here'}]);

    const result = await evaluateNlResponse(judge, {}, 'nl', 'ctx');

    expect(result).toEqual({details: 'No sentences produced by segmenter.'});
  });

  it('reports a segmenter call that failed', async () => {
    const judge = new FakeJudgeLlm([{failure: 'segmenter is down'}]);

    const result = await evaluateNlResponse(judge, {}, 'nl', 'ctx');

    expect(result).toEqual({
      details: 'Error during sentence segmentation: segmenter is down',
    });
  });

  it('reports a validator that answered nothing', async () => {
    const judge = new FakeJudgeLlm([
      {critique: '<sentence>One.</sentence>'},
      {silent: true},
    ]);

    const result = await evaluateNlResponse(judge, {}, 'nl', 'ctx');

    expect(result).toEqual({details: 'Sentence validator returned no text.'});
  });

  it('reports a validator call that failed', async () => {
    const judge = new FakeJudgeLlm([
      {critique: '<sentence>One.</sentence>'},
      {failure: 'validator is down'},
    ]);

    const result = await evaluateNlResponse(judge, {}, 'nl', 'ctx');

    expect(result).toEqual({
      details: 'Error during sentence validation: validator is down',
    });
  });

  it('reports a judge that rejected with something other than an Error', async () => {
    const result = await evaluateNlResponse(
      new NonErrorJudgeLlm(),
      {},
      'nl',
      'ctx',
    );

    expect(result).toEqual({
      details: `Error during sentence segmentation: ${NON_ERROR_FAILURE}`,
    });
  });

  it('serializes the validator report the way adk-python does', async () => {
    const judge = new FakeJudgeLlm([
      {
        critique:
          '<sentence>Apples are red.</sentence>' +
          '<sentence>Enjoy your fruit!</sentence>',
      },
      {
        critique: [
          'sentence: Apples are red.',
          'label: supported',
          'rationale: The context says apples are red.',
          'supporting_excerpt: Apples are red fruits.',
          'contradicting_excerpt: null',
          '',
          'sentence: Enjoy your fruit!',
          'label: not_applicable',
          'rationale: A greeting needs no attribution.',
          'supporting_excerpt: null',
          'contradicting_excerpt: null',
        ].join('\n'),
      },
    ]);

    const result = await evaluateNlResponse(judge, {}, 'nl', 'ctx');

    expect(result.score).toBe(1);
    expect(JSON.parse(result.details)).toEqual([
      {
        sentence: 'Apples are red.',
        label: 'supported',
        rationale: 'The context says apples are red.',
        supporting_excerpt: 'Apples are red fruits.',
        contradicting_excerpt: null,
      },
      {
        sentence: 'Enjoy your fruit!',
        label: 'not_applicable',
        rationale: 'A greeting needs no attribution.',
        supporting_excerpt: null,
        contradicting_excerpt: null,
      },
    ]);
  });

  it('sends the judge the model it was built with', async () => {
    const judge = new FakeJudgeLlm([{silent: true}]);

    await evaluateNlResponse(judge, {temperature: 0}, 'nl', 'ctx');

    expect(judge.requests[0].model).toBe(judge.model);
    expect(judge.requests[0].config?.temperature).toBe(0);
  });

  it('keeps a context that names a placeholder out of the substitution', async () => {
    const judge = new FakeJudgeLlm([
      {critique: '<sentence>One.</sentence>'},
      {silent: true},
    ]);
    // A tool output, an instruction or a prior response can hold this text.
    const context = 'The tool returned the literal string {sentences}.';

    await evaluateNlResponse(judge, {}, 'nl', context);

    const validatorPrompt =
      judge.requests[1].contents[0].parts?.[0].text ?? expect.fail('no prompt');
    expect(validatorPrompt).toContain(context);
    expect(validatorPrompt).toContain(
      '**Sentences Begin**\n<sentence>One.</sentence>\n**Sentences End**',
    );
    expect(validatorPrompt.split('<sentence>One.</sentence>')).toHaveLength(2);
  });
});
