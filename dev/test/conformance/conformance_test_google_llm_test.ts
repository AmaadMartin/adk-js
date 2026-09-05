/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {LlmRequest, LlmResponse} from '@google/adk';
import {Type} from '@google/genai';
import {describe, expect, it} from 'vitest';

import {
  ConformanceReplayModelConfig,
  ConformanceTestGemini,
  isReplayVerificationError,
  ReplayRecording,
  verifyLlmRequestMatch,
} from '../../src/conformance/conformance_test_google_llm.js';
import {
  OTHER_AGENT_CONTEXT_PREAMBLE,
  OTHER_AGENT_CONTEXT_PREFIX,
  QUOTED_CONTENT_BEGIN,
  QUOTED_CONTENT_END,
} from '../../src/conformance/replay_normalizers.js';

const AGENT = 'root_agent';
const CONTEXT = {agentName: AGENT, userMessageIndex: 0, replayIndex: 0};

function request(overrides: Partial<LlmRequest> = {}): LlmRequest {
  return {
    model: 'gemini-2.5-flash',
    contents: [{role: 'user', parts: [{text: 'hello'}]}],
    liveConnectConfig: {},
    toolsDict: {},
    ...overrides,
  };
}

function response(text: string): LlmResponse {
  return {content: {role: 'model', parts: [{text}]}};
}

function model(
  overrides: Omit<Partial<ConformanceReplayModelConfig>, 'recordings'> & {
    recordings: ReplayRecording[];
  },
): ConformanceTestGemini {
  const {recordings, ...rest} = overrides;
  return new ConformanceTestGemini({
    recordings: {recordings},
    agentName: AGENT,
    userMessageIndex: 0,
    replayIndex: 0,
    ...rest,
  });
}

async function collect(
  generator: AsyncGenerator<LlmResponse, void>,
): Promise<LlmResponse[]> {
  const collected: LlmResponse[] = [];
  for await (const item of generator) {
    collected.push(item);
  }
  return collected;
}

function textsOf(responses: LlmResponse[]): Array<string | undefined> {
  return responses.map((r) => r.content?.parts?.[0]?.text);
}

async function captureError(
  generator: AsyncGenerator<LlmResponse, void>,
): Promise<Error> {
  try {
    await collect(generator);
  } catch (e: unknown) {
    if (e instanceof Error) {
      return e;
    }
    throw e;
  }
  return expect.fail('expected the replay to throw');
}

describe('ConformanceTestGemini constructor', () => {
  it('serves only the matching agent and turn', async () => {
    const replay = model({
      recordings: [
        {
          userMessageIndex: 0,
          agentName: 'other_agent',
          llmRecording: {llmResponses: [response('wrong agent')]},
        },
        {
          userMessageIndex: 1,
          agentName: AGENT,
          llmRecording: {llmResponses: [response('wrong turn')]},
        },
        {
          userMessageIndex: 0,
          agentName: AGENT,
          llmRecording: {llmResponses: [response('right')]},
        },
      ],
    });

    expect(
      textsOf(await collect(replay.generateContentAsync(request()))),
    ).toEqual(['right']);
  });

  it('skips a recording that carries no llmRecording', async () => {
    const replay = model({
      recordings: [
        {userMessageIndex: 0, agentName: AGENT},
        {
          userMessageIndex: 0,
          agentName: AGENT,
          llmRecording: {llmResponses: [response('first llm call')]},
        },
      ],
    });

    expect(
      textsOf(await collect(replay.generateContentAsync(request()))),
    ).toEqual(['first llm call']);
  });

  it('defaults the model name to the Gemini default', () => {
    expect(model({recordings: []}).model).toBe('gemini-2.5-flash');
  });

  it('accepts an explicit model name', () => {
    expect(model({recordings: [], model: 'gemini-2.0-flash'}).model).toBe(
      'gemini-2.0-flash',
    );
  });
});

describe('ConformanceTestGemini replay', () => {
  it('yields every recorded response in order', async () => {
    const replay = model({
      recordings: [
        {
          userMessageIndex: 0,
          agentName: AGENT,
          llmRecording: {llmResponses: [response('one'), response('two')]},
        },
      ],
    });

    expect(
      textsOf(await collect(replay.generateContentAsync(request()))),
    ).toEqual(['one', 'two']);
  });

  it('falls back to a single llmResponse', async () => {
    const replay = model({
      recordings: [
        {
          userMessageIndex: 0,
          agentName: AGENT,
          llmRecording: {llmResponse: response('only')},
        },
      ],
    });

    expect(
      textsOf(await collect(replay.generateContentAsync(request()))),
    ).toEqual(['only']);
  });

  it('yields nothing when the recording carries no response', async () => {
    const replay = model({
      recordings: [{userMessageIndex: 0, agentName: AGENT, llmRecording: {}}],
    });

    expect(await collect(replay.generateContentAsync(request()))).toEqual([]);
  });

  it('serves the recording named by replayIndex', async () => {
    const recordings: ReplayRecording[] = [
      {
        userMessageIndex: 0,
        agentName: AGENT,
        llmRecording: {llmResponses: [response('first')]},
      },
      {
        userMessageIndex: 0,
        agentName: AGENT,
        llmRecording: {llmResponses: [response('second')]},
      },
    ];
    const replay = model({recordings, replayIndex: 1});

    expect(
      textsOf(await collect(replay.generateContentAsync(request()))),
    ).toEqual(['second']);
  });
});

describe('ConformanceTestGemini over-request', () => {
  it('throws when the runtime asks for more calls than were recorded', async () => {
    const replay = model({
      recordings: [
        {
          userMessageIndex: 0,
          agentName: AGENT,
          llmRecording: {llmResponses: [response('one')]},
        },
      ],
      replayIndex: 1,
    });

    const error = await captureError(replay.generateContentAsync(request()));

    expect(isReplayVerificationError(error)).toBe(true);
    expect(error.message).toBe(
      `Runtime sent more LLM requests than expected for agent '${AGENT}' at ` +
        'userMessageIndex 0. Expected 1, but got request at index 1',
    );
  });

  it('throws when nothing at all was recorded for the agent', async () => {
    const replay = model({recordings: []});

    const error = await captureError(replay.generateContentAsync(request()));

    expect(isReplayVerificationError(error)).toBe(true);
    expect(error.message).toContain('Expected 0');
  });
});

describe('ConformanceTestGemini request verification', () => {
  function replayWith(recorded: LlmRequest | undefined): ConformanceTestGemini {
    return model({
      recordings: [
        {
          userMessageIndex: 0,
          agentName: AGENT,
          llmRecording: {
            llmRequest: recorded,
            llmResponses: [response('ok')],
          },
        },
      ],
    });
  }

  it('passes an identical request', async () => {
    const responses = await collect(
      replayWith(request()).generateContentAsync(request()),
    );
    expect(textsOf(responses)).toEqual(['ok']);
  });

  it('ignores the fields that vary between runs', async () => {
    const live = request({
      liveConnectConfig: {responseModalities: []},
      toolsDict: {},
      config: {
        abortSignal: new AbortController().signal,
        httpOptions: {timeout: 5000},
        labels: {run: 'local'},
        temperature: 0.5,
      },
    });

    const responses = await collect(
      replayWith(request({config: {temperature: 0.5}})).generateContentAsync(
        live,
      ),
    );
    expect(textsOf(responses)).toEqual(['ok']);
  });

  it('throws when the contents differ', async () => {
    const live = request({
      contents: [{role: 'user', parts: [{text: 'goodbye'}]}],
    });

    const error = await captureError(
      replayWith(request()).generateContentAsync(live),
    );

    expect(isReplayVerificationError(error)).toBe(true);
    expect(error.message).toContain(
      `LLM request mismatch in turn 0 for agent '${AGENT}' (index 0)`,
    );
    expect(error.message).toContain('goodbye');
  });

  it('throws when the live request declares an extra tool', async () => {
    const live = request({
      config: {
        tools: [
          {
            functionDeclarations: [{name: 'lookup'}, {name: 'extra'}],
          },
        ],
      },
    });
    const recorded = request({
      config: {tools: [{functionDeclarations: [{name: 'lookup'}]}]},
    });

    const error = await captureError(
      replayWith(recorded).generateContentAsync(live),
    );

    expect(isReplayVerificationError(error)).toBe(true);
    expect(error.message).toContain('extra');
  });

  it('throws when the system instruction differs', async () => {
    const error = await captureError(
      replayWith(
        request({config: {systemInstruction: 'be terse'}}),
      ).generateContentAsync(request({config: {systemInstruction: 'be kind'}})),
    );

    expect(isReplayVerificationError(error)).toBe(true);
    expect(error.message).toContain('be terse');
  });

  it('yields nothing before a failed verification', async () => {
    const replay = replayWith(request());
    const generator = replay.generateContentAsync(
      request({contents: [{role: 'user', parts: [{text: 'other'}]}]}),
    );

    await expect(generator.next()).rejects.toThrow('LLM request mismatch');
  });

  it('skips verification when the recording has no request', async () => {
    const responses = await collect(
      replayWith(undefined).generateContentAsync(
        request({contents: [{role: 'user', parts: [{text: 'anything'}]}]}),
      ),
    );
    expect(textsOf(responses)).toEqual(['ok']);
  });
});

describe('ConformanceTestGemini normalization', () => {
  it('matches a recorded parameters schema against a live JSON schema', async () => {
    const recorded = request({
      config: {
        tools: [
          {
            functionDeclarations: [
              {
                name: 'lookup',
                description: ' Look it up. ',
                parameters: {
                  type: Type.OBJECT,
                  title: 'Args',
                  properties: {
                    city: {type: Type.STRING, description: 'the city'},
                  },
                },
              },
            ],
          },
        ],
      },
    });
    const live = request({
      config: {
        tools: [
          {
            functionDeclarations: [
              {
                name: 'lookup',
                description: 'Look it up.',
                parametersJsonSchema: {
                  type: 'object',
                  properties: {city: {type: 'string'}},
                },
              },
            ],
          },
        ],
      },
    });

    const replay = model({
      recordings: [
        {
          userMessageIndex: 0,
          agentName: AGENT,
          llmRecording: {llmRequest: recorded, llmResponses: [response('ok')]},
        },
      ],
    });

    expect(textsOf(await collect(replay.generateContentAsync(live)))).toEqual([
      'ok',
    ]);
  });

  it('matches a fenced relayed turn against an unfenced one', async () => {
    const recorded = request({
      contents: [
        {
          role: 'user',
          parts: [
            {text: OTHER_AGENT_CONTEXT_PREAMBLE},
            {
              text: `[sub_agent] said:\n${QUOTED_CONTENT_BEGIN}\nhi\n${QUOTED_CONTENT_END}`,
            },
          ],
        },
      ],
    });
    const live = request({
      contents: [
        {
          role: 'user',
          parts: [
            {text: OTHER_AGENT_CONTEXT_PREFIX},
            {text: '[sub_agent] said: hi'},
          ],
        },
      ],
    });

    const replay = model({
      recordings: [
        {
          userMessageIndex: 0,
          agentName: AGENT,
          llmRecording: {llmRequest: recorded, llmResponses: [response('ok')]},
        },
      ],
    });

    expect(textsOf(await collect(replay.generateContentAsync(live)))).toEqual([
      'ok',
    ]);
  });
});

describe('verifyLlmRequestMatch', () => {
  it('treats an absent optional field and an empty one as the same', () => {
    expect(() =>
      verifyLlmRequestMatch(
        request(),
        request({config: {}, allowedTools: []}),
        CONTEXT,
      ),
    ).not.toThrow();
  });

  it('drops a field whose value is absent', () => {
    expect(() =>
      verifyLlmRequestMatch(
        request({previousInteractionId: undefined}),
        request(),
        CONTEXT,
      ),
    ).not.toThrow();
  });

  it('keeps a field explicitly set to a falsy value', () => {
    expect(() =>
      verifyLlmRequestMatch(
        request({config: {temperature: 0}}),
        request({config: {temperature: 1}}),
        CONTEXT,
      ),
    ).toThrow('LLM request mismatch');
  });

  it('does not mutate either request', () => {
    const recorded = request();
    const live = request({config: {labels: {run: 'local'}}});

    verifyLlmRequestMatch(recorded, live, CONTEXT);

    expect(recorded.contents).toEqual([
      {role: 'user', parts: [{text: 'hello'}]},
    ]);
    expect(live.config).toEqual({labels: {run: 'local'}});
  });

  it('names the turn, the agent and the replay index', () => {
    expect(() =>
      verifyLlmRequestMatch(request(), request({model: 'other'}), {
        agentName: 'sub_agent',
        userMessageIndex: 3,
        replayIndex: 2,
      }),
    ).toThrow("LLM request mismatch in turn 3 for agent 'sub_agent' (index 2)");
  });
});

describe('ConformanceTestGemini.connect', () => {
  it('refuses to open a live connection', () => {
    expect(() => model({recordings: []}).connect(request())).toThrow(
      'ConformanceTestGemini.connect should not be called during replay tests.',
    );
  });
});

describe('isReplayVerificationError', () => {
  it('rejects an unrelated error and a non-error', () => {
    expect(isReplayVerificationError(new Error('other'))).toBe(false);
    expect(isReplayVerificationError('ReplayVerificationError')).toBe(false);
  });
});
