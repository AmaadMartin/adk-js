/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BlockedReason,
  FinishReason,
  GenerateContentResponse,
  LogprobsResult,
  TurnCompleteReason,
} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {
  createEvent,
  transformToCamelCaseEvent,
  transformToSnakeCaseEvent,
} from '../../src/events/event.js';
import {CacheMetadata} from '../../src/models/cache_metadata.js';
import {
  createLlmResponse,
  getFunctionCalls,
  getFunctionResponses,
  InteractionStatus,
  LlmResponse,
} from '../../src/models/llm_response.js';

function makeResponse(
  overrides: Partial<GenerateContentResponse>,
): GenerateContentResponse {
  return overrides as GenerateContentResponse;
}

describe('createLlmResponse', () => {
  describe('happy path — candidate with content parts', () => {
    it('returns content from the first candidate', () => {
      const content = {parts: [{text: 'hello'}], role: 'model'};
      const response = makeResponse({
        candidates: [{content, finishReason: FinishReason.STOP}],
      });
      const result = createLlmResponse(response);
      expect(result.content).toBe(content);
    });

    it('includes groundingMetadata when present', () => {
      const groundingMetadata = {groundingChunks: []};
      const response = makeResponse({
        candidates: [
          {
            content: {parts: [{text: 'hi'}], role: 'model'},
            groundingMetadata,
          },
        ],
      });
      const result = createLlmResponse(response);
      expect(result.groundingMetadata).toBe(groundingMetadata);
    });

    it('includes citationMetadata when present', () => {
      const citationMetadata = {citations: []};
      const response = makeResponse({
        candidates: [
          {
            content: {parts: [{text: 'hi'}], role: 'model'},
            citationMetadata,
          },
        ],
      });
      const result = createLlmResponse(response);
      expect(result.citationMetadata).toBe(citationMetadata);
    });

    it('includes usageMetadata when present', () => {
      const usageMetadata = {totalTokenCount: 42};
      const response = makeResponse({
        candidates: [{content: {parts: [{text: 'hi'}], role: 'model'}}],
        usageMetadata,
      });
      const result = createLlmResponse(response);
      expect(result.usageMetadata).toBe(usageMetadata);
    });

    it('includes finishReason from the first candidate', () => {
      const response = makeResponse({
        candidates: [
          {
            content: {parts: [{text: 'hi'}], role: 'model'},
            finishReason: FinishReason.STOP,
          },
        ],
      });
      const result = createLlmResponse(response);
      expect(result.finishReason).toBe(FinishReason.STOP);
    });

    it('uses only the first candidate when multiple are present', () => {
      const first = {parts: [{text: 'first'}], role: 'model'};
      const second = {parts: [{text: 'second'}], role: 'model'};
      const response = makeResponse({
        candidates: [{content: first}, {content: second}],
      });
      const result = createLlmResponse(response);
      expect(result.content).toBe(first);
    });

    it('does not set errorCode or errorMessage', () => {
      const response = makeResponse({
        candidates: [{content: {parts: [{text: 'ok'}], role: 'model'}}],
      });
      const result = createLlmResponse(response);
      expect(result.errorCode).toBeUndefined();
      expect(result.errorMessage).toBeUndefined();
    });
  });

  describe('candidate present but no content parts', () => {
    it('returns errorCode from finishReason when candidate has no content', () => {
      const response = makeResponse({
        candidates: [{finishReason: FinishReason.SAFETY}],
      });
      const result = createLlmResponse(response);
      expect(result.errorCode).toBe(FinishReason.SAFETY);
    });

    it('returns errorCode when candidate content has empty parts array', () => {
      const response = makeResponse({
        candidates: [
          {
            content: {parts: [], role: 'model'},
            finishReason: FinishReason.MAX_TOKENS,
            finishMessage: 'max tokens reached',
          },
        ],
      });
      const result = createLlmResponse(response);
      expect(result.errorCode).toBe(FinishReason.MAX_TOKENS);
      expect(result.errorMessage).toBe('max tokens reached');
    });

    it('includes usageMetadata in the error response', () => {
      const usageMetadata = {totalTokenCount: 10};
      const response = makeResponse({
        candidates: [{finishReason: FinishReason.SAFETY}],
        usageMetadata,
      });
      const result = createLlmResponse(response);
      expect(result.usageMetadata).toBe(usageMetadata);
    });

    it('does not set content', () => {
      const response = makeResponse({
        candidates: [{finishReason: FinishReason.SAFETY}],
      });
      const result = createLlmResponse(response);
      expect(result.content).toBeUndefined();
    });
  });

  describe('prompt feedback block', () => {
    it('returns blockReason as errorCode', () => {
      const response = makeResponse({
        promptFeedback: {
          blockReason: BlockedReason.SAFETY,
          blockReasonMessage: 'blocked by safety',
        },
      });
      const result = createLlmResponse(response);
      expect(result.errorCode).toBe('SAFETY');
    });

    it('returns blockReasonMessage as errorMessage', () => {
      const response = makeResponse({
        promptFeedback: {
          blockReason: BlockedReason.OTHER,
          blockReasonMessage: 'other reason',
        },
      });
      const result = createLlmResponse(response);
      expect(result.errorMessage).toBe('other reason');
    });

    it('includes usageMetadata in the prompt feedback response', () => {
      const usageMetadata = {totalTokenCount: 5};
      const response = makeResponse({
        promptFeedback: {
          blockReason: BlockedReason.SAFETY,
          blockReasonMessage: '',
        },
        usageMetadata,
      });
      const result = createLlmResponse(response);
      expect(result.usageMetadata).toBe(usageMetadata);
    });

    it('does not set content', () => {
      const response = makeResponse({
        promptFeedback: {
          blockReason: BlockedReason.SAFETY,
          blockReasonMessage: '',
        },
      });
      const result = createLlmResponse(response);
      expect(result.content).toBeUndefined();
    });
  });

  describe('unknown fallback', () => {
    it('returns UNKNOWN_ERROR code when no candidates or promptFeedback', () => {
      const result = createLlmResponse(makeResponse({}));
      expect(result.errorCode).toBe('UNKNOWN_ERROR');
    });

    it('returns the unknown error message', () => {
      const result = createLlmResponse(makeResponse({}));
      expect(result.errorMessage).toBe('Unknown error.');
    });

    it('includes usageMetadata in the fallback response', () => {
      const usageMetadata = {totalTokenCount: 0};
      const result = createLlmResponse(makeResponse({usageMetadata}));
      expect(result.usageMetadata).toBe(usageMetadata);
    });

    it('does not set content', () => {
      const result = createLlmResponse(makeResponse({}));
      expect(result.content).toBeUndefined();
    });

    it('returns UNKNOWN_ERROR when candidates array is empty', () => {
      const result = createLlmResponse(makeResponse({candidates: []}));
      expect(result.errorCode).toBe('UNKNOWN_ERROR');
    });
  });
});

describe('createLlmResponse logprobs', () => {
  it('carries avgLogprobs and logprobsResult from the candidate', () => {
    const logprobsResult: LogprobsResult = {
      chosenCandidates: [],
      topCandidates: [],
    };
    const result = createLlmResponse(
      makeResponse({
        candidates: [
          {
            content: {parts: [{text: 'Response text'}], role: 'model'},
            finishReason: FinishReason.STOP,
            avgLogprobs: -0.75,
            logprobsResult,
          },
        ],
      }),
    );
    expect(result.avgLogprobs).toBe(-0.75);
    expect(result.logprobsResult).toBe(logprobsResult);
    expect(result.content?.parts?.[0].text).toBe('Response text');
    expect(result.finishReason).toBe(FinishReason.STOP);
  });

  it('leaves both fields undefined when the candidate reports neither', () => {
    const result = createLlmResponse(
      makeResponse({
        candidates: [
          {
            content: {parts: [{text: 'Response text'}], role: 'model'},
            finishReason: FinishReason.STOP,
          },
        ],
      }),
    );
    expect(result.avgLogprobs).toBeUndefined();
    expect(result.logprobsResult).toBeUndefined();
    expect(result.content?.parts?.[0].text).toBe('Response text');
  });

  it('carries avgLogprobs on the error branch', () => {
    const result = createLlmResponse(
      makeResponse({
        candidates: [
          {
            finishReason: FinishReason.SAFETY,
            finishMessage: 'Safety filter triggered',
            avgLogprobs: -2.1,
          },
        ],
      }),
    );
    expect(result.avgLogprobs).toBe(-2.1);
    expect(result.logprobsResult).toBeUndefined();
    expect(result.errorCode).toBe(FinishReason.SAFETY);
    expect(result.errorMessage).toBe('Safety filter triggered');
  });

  it('preserves a populated logprobsResult field by field', () => {
    const logprobsResult: LogprobsResult = {
      chosenCandidates: [
        {token: 'The', logProbability: -0.1, tokenId: 123},
        {token: ' capital', logProbability: -0.5, tokenId: 456},
        {token: ' of', logProbability: -0.2, tokenId: 789},
      ],
      topCandidates: [
        {
          candidates: [
            {token: 'The', logProbability: -0.1, tokenId: 123},
            {token: 'A', logProbability: -2.3, tokenId: 124},
            {token: 'This', logProbability: -3.1, tokenId: 125},
          ],
        },
        {
          candidates: [
            {token: ' capital', logProbability: -0.5, tokenId: 456},
            {token: ' city', logProbability: -1.2, tokenId: 457},
            {token: ' main', logProbability: -2.8, tokenId: 458},
          ],
        },
      ],
    };
    const result = createLlmResponse(
      makeResponse({
        candidates: [
          {
            content: {
              parts: [{text: 'The capital of France is Paris.'}],
              role: 'model',
            },
            finishReason: FinishReason.STOP,
            avgLogprobs: -0.27,
            logprobsResult,
          },
        ],
      }),
    );

    expect(result.avgLogprobs).toBe(-0.27);
    const chosen = result.logprobsResult?.chosenCandidates;
    expect(chosen).toHaveLength(3);
    expect(chosen?.[0]).toEqual({
      token: 'The',
      logProbability: -0.1,
      tokenId: 123,
    });
    expect(chosen?.[1]).toEqual({
      token: ' capital',
      logProbability: -0.5,
      tokenId: 456,
    });
    const top = result.logprobsResult?.topCandidates;
    expect(top).toHaveLength(2);
    expect(top?.[0].candidates).toHaveLength(3);
    expect(top?.[0].candidates?.map((c) => c.token)).toEqual([
      'The',
      'A',
      'This',
    ]);
    expect(top?.[0].candidates?.map((c) => c.tokenId)).toEqual([123, 124, 125]);
  });

  it('preserves a logprobsResult that has only chosen candidates', () => {
    const logprobsResult: LogprobsResult = {
      chosenCandidates: [
        {token: 'Hello', logProbability: -0.05, tokenId: 111},
        {token: ' world', logProbability: -0.8, tokenId: 222},
      ],
      topCandidates: [],
    };
    const result = createLlmResponse(
      makeResponse({
        candidates: [
          {
            content: {parts: [{text: 'Hello world'}], role: 'model'},
            finishReason: FinishReason.STOP,
            avgLogprobs: -0.425,
            logprobsResult,
          },
        ],
      }),
    );
    expect(result.avgLogprobs).toBe(-0.425);
    expect(result.logprobsResult?.chosenCandidates).toHaveLength(2);
    expect(result.logprobsResult?.topCandidates).toHaveLength(0);
    expect(
      result.logprobsResult?.chosenCandidates?.map((c) => c.token),
    ).toEqual(['Hello', ' world']);
  });

  it('reports no logprobs when the prompt was blocked', () => {
    const result = createLlmResponse(
      makeResponse({
        candidates: [],
        promptFeedback: {
          blockReason: BlockedReason.SAFETY,
          blockReasonMessage: 'Prompt blocked for safety',
        },
      }),
    );
    expect(result.avgLogprobs).toBeUndefined();
    expect(result.logprobsResult).toBeUndefined();
    expect(result.errorCode).toBe(BlockedReason.SAFETY);
    expect(result.errorMessage).toBe('Prompt blocked for safety');
  });
});

describe('createLlmResponse citationMetadata', () => {
  it('leaves citationMetadata undefined when the candidate reports none', () => {
    const result = createLlmResponse(
      makeResponse({
        candidates: [
          {
            content: {parts: [{text: 'Response text'}], role: 'model'},
            finishReason: FinishReason.STOP,
          },
        ],
      }),
    );
    expect(result.citationMetadata).toBeUndefined();
    expect(result.content?.parts?.[0].text).toBe('Response text');
  });

  it('carries citationMetadata on the error branch', () => {
    const citationMetadata = {
      citations: [{startIndex: 0, endIndex: 10, uri: 'https://example.com'}],
    };
    const result = createLlmResponse(
      makeResponse({
        candidates: [
          {
            finishReason: FinishReason.RECITATION,
            finishMessage: 'Response blocked due to recitation triggered',
            citationMetadata,
          },
        ],
      }),
    );
    expect(result.citationMetadata).toBe(citationMetadata);
    expect(result.errorCode).toBe(FinishReason.RECITATION);
    expect(result.errorMessage).toBe(
      'Response blocked due to recitation triggered',
    );
  });
});

describe('createLlmResponse STOP with no parts', () => {
  it('returns a success when the parts array is empty and the reason is STOP', () => {
    const result = createLlmResponse(
      makeResponse({
        candidates: [
          {
            content: {parts: [], role: 'model'},
            finishReason: FinishReason.STOP,
          },
        ],
      }),
    );
    expect(result.errorCode).toBeUndefined();
    expect(result.content).toBeDefined();
    expect(result.finishReason).toBe(FinishReason.STOP);
  });

  it('returns a success when the candidate has no content and the reason is STOP', () => {
    const result = createLlmResponse(
      makeResponse({candidates: [{finishReason: FinishReason.STOP}]}),
    );
    expect(result.errorCode).toBeUndefined();
    expect(result.finishReason).toBe(FinishReason.STOP);
  });

  it('keeps a candidate with real text and STOP a success', () => {
    const result = createLlmResponse(
      makeResponse({
        candidates: [
          {
            content: {parts: [{text: 'ok'}], role: 'model'},
            finishReason: FinishReason.STOP,
          },
        ],
      }),
    );
    expect(result.errorCode).toBeUndefined();
    expect(result.content).toBeDefined();
  });
});

describe('createLlmResponse modelVersion', () => {
  it('carries modelVersion on the success branch', () => {
    const result = createLlmResponse(
      makeResponse({
        modelVersion: 'gemini-2.5-flash',
        candidates: [
          {
            content: {parts: [{text: 'Response text'}], role: 'model'},
            finishReason: FinishReason.STOP,
          },
        ],
      }),
    );
    expect(result.modelVersion).toBe('gemini-2.5-flash');
  });

  it('carries modelVersion on the candidate error branch', () => {
    const result = createLlmResponse(
      makeResponse({
        modelVersion: 'gemini-2.5-flash',
        candidates: [{finishReason: FinishReason.SAFETY}],
      }),
    );
    expect(result.modelVersion).toBe('gemini-2.5-flash');
  });

  it('carries modelVersion on the prompt feedback branch', () => {
    const result = createLlmResponse(
      makeResponse({
        modelVersion: 'gemini-2.5-flash',
        promptFeedback: {
          blockReason: BlockedReason.SAFETY,
          blockReasonMessage: 'blocked',
        },
      }),
    );
    expect(result.modelVersion).toBe('gemini-2.5-flash');
  });
});

describe('getFunctionCalls', () => {
  it('returns the calls in order and skips other parts', () => {
    const first = {name: 'a', args: {}};
    const second = {name: 'b', args: {x: 1}};
    const response: LlmResponse = {
      content: {
        parts: [
          {functionCall: first},
          {text: 'ignored'},
          {functionCall: second},
        ],
      },
    };
    expect(getFunctionCalls(response)).toEqual([first, second]);
  });

  it('returns an empty array when the response has no content', () => {
    expect(getFunctionCalls({})).toEqual([]);
  });

  it('returns an empty array when the content has no parts', () => {
    expect(getFunctionCalls({content: {}})).toEqual([]);
  });
});

describe('getFunctionResponses', () => {
  it('returns the responses in order and skips other parts', () => {
    const first = {name: 'a', response: {r: 1}};
    const second = {name: 'b', response: {r: 2}};
    const response: LlmResponse = {
      content: {
        parts: [
          {functionResponse: first},
          {text: 'ignored'},
          {functionResponse: second},
        ],
      },
    };
    expect(getFunctionResponses(response)).toEqual([first, second]);
  });

  it('returns an empty array when the response has no content', () => {
    expect(getFunctionResponses({})).toEqual([]);
  });

  it('returns an empty array when the content has no parts', () => {
    expect(getFunctionResponses({content: {}})).toEqual([]);
  });
});

describe('LlmResponse parity fields', () => {
  it('matches the wire values of the genai InteractionStatus enum', () => {
    expect(InteractionStatus.INTERACTION_STATUS_UNSPECIFIED).toBe(
      'INTERACTION_STATUS_UNSPECIFIED',
    );
    expect(InteractionStatus.IN_PROGRESS).toBe('IN_PROGRESS');
    expect(InteractionStatus.REQUIRES_ACTION).toBe('REQUIRES_ACTION');
    expect(InteractionStatus.IDLE).toBe('IDLE');
  });

  it('accepts the live session and cache fields on a response literal', () => {
    const cacheMetadata: CacheMetadata = {
      cacheName: 'projects/1/locations/us-central1/cachedContents/2',
      expireTime: 1_700_000_600,
      invocationsUsed: 4,
      fingerprint: 'abcdef0123456789',
      contentsCount: 6,
      createdAt: 1_700_000_000,
    };
    const response: LlmResponse = {
      turnComplete: true,
      turnCompleteReason: TurnCompleteReason.NEED_MORE_INPUT,
      interactionStatus: InteractionStatus.IN_PROGRESS,
      voiceActivity: {audioOffset: '1.5s'},
      cacheMetadata,
      environmentId: 'env_abc',
    };

    expect(response.turnCompleteReason).toBe(
      TurnCompleteReason.NEED_MORE_INPUT,
    );
    expect(response.interactionStatus).toBe(InteractionStatus.IN_PROGRESS);
    expect(response.voiceActivity?.audioOffset).toBe('1.5s');
    expect(response.cacheMetadata).toBe(cacheMetadata);
    expect(response.environmentId).toBe('env_abc');
  });

  it('leaves environmentId absent by default', () => {
    const response: LlmResponse = {};
    expect(response.environmentId).toBeUndefined();
  });

  it('round-trips the new fields through the event serializer', () => {
    const event = createEvent({
      author: 'model',
      environmentId: 'env_abc',
      interactionStatus: InteractionStatus.IDLE,
      turnCompleteReason: TurnCompleteReason.NEED_MORE_INPUT,
      avgLogprobs: -0.5,
      cacheMetadata: {fingerprint: 'abcdef0123456789', contentsCount: 3},
    });

    const wire = transformToSnakeCaseEvent(event);
    expect(wire['environment_id']).toBe('env_abc');
    expect(wire['interaction_status']).toBe('IDLE');
    expect(wire['turn_complete_reason']).toBe('NEED_MORE_INPUT');
    expect(wire['avg_logprobs']).toBe(-0.5);

    const restored = transformToCamelCaseEvent(wire);
    expect(restored.environmentId).toBe('env_abc');
    expect(restored.interactionStatus).toBe(InteractionStatus.IDLE);
    expect(restored.turnCompleteReason).toBe(
      TurnCompleteReason.NEED_MORE_INPUT,
    );
    expect(restored.avgLogprobs).toBe(-0.5);
    expect(restored.cacheMetadata?.fingerprint).toBe('abcdef0123456789');
    expect(restored.cacheMetadata?.contentsCount).toBe(3);
  });
});
