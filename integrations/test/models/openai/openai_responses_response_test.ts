/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {getLogger} from '@google/adk';
import {FinishReason} from '@google/genai';
import type {
  ResponseFunctionToolCall,
  ResponseOutputMessage,
  ResponseOutputText,
  ResponseReasoningItem,
} from 'openai/resources/responses/responses';
import {describe, expect, it, vi} from 'vitest';
import {
  functionCallPart,
  mapFinishReason,
  messageContentParts,
  reasoningParts,
  responseToLlmResponse,
  usageMetadata,
} from '../../../src/models/openai/openai_responses_response.js';

/** Builds an output text block. */
function outputText(text: string): ResponseOutputText {
  return {type: 'output_text', text, annotations: []};
}

/** Builds an assistant output message. */
function outputMessage(
  content: ResponseOutputMessage['content'],
): ResponseOutputMessage {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    status: 'completed',
    content,
  };
}

/** Builds a reasoning output item. */
function reasoningItem(
  overrides: Partial<ResponseReasoningItem> = {},
): ResponseReasoningItem {
  return {id: 'rs_1', type: 'reasoning', summary: [], ...overrides};
}

/** Builds a function tool call output item. */
function functionCall(
  overrides: Partial<ResponseFunctionToolCall> = {},
): ResponseFunctionToolCall {
  return {
    type: 'function_call',
    call_id: 'call_1',
    name: 'get_weather',
    arguments: '{"city": "SF"}',
    ...overrides,
  };
}

describe('usageMetadata', () => {
  it('maps every token count the response reports', () => {
    expect(
      usageMetadata({
        input_tokens: 11,
        output_tokens: 7,
        total_tokens: 18,
        input_tokens_details: {cached_tokens: 3, cache_write_tokens: 0},
        output_tokens_details: {reasoning_tokens: 5},
      }),
    ).toEqual({
      promptTokenCount: 11,
      candidatesTokenCount: 7,
      totalTokenCount: 18,
      cachedContentTokenCount: 3,
      thoughtsTokenCount: 5,
    });
  });

  it('adds up the total the response left out', () => {
    expect(usageMetadata({input_tokens: 4, output_tokens: 6})).toMatchObject({
      totalTokenCount: 10,
    });
  });

  it('leaves the total unset when a count is missing', () => {
    expect(usageMetadata({input_tokens: 4})).toMatchObject({
      totalTokenCount: undefined,
    });
  });

  it('returns undefined when there is no usage', () => {
    expect(usageMetadata(undefined)).toBeUndefined();
  });
});

describe('mapFinishReason', () => {
  it('maps a completed response to STOP', () => {
    expect(mapFinishReason({status: 'completed'})).toBe(FinishReason.STOP);
  });

  it.each(['max_output_tokens', 'max_tokens'])(
    'maps the %s cutoff to MAX_TOKENS',
    (reason) => {
      expect(
        mapFinishReason({
          status: 'incomplete',
          incomplete_details: {reason} as {reason: 'max_output_tokens'},
        }),
      ).toBe(FinishReason.MAX_TOKENS);
    },
  );

  it('maps any other incomplete reason to OTHER', () => {
    expect(
      mapFinishReason({
        status: 'incomplete',
        incomplete_details: {reason: 'content_filter'},
      }),
    ).toBe(FinishReason.OTHER);
    expect(mapFinishReason({status: 'incomplete'})).toBe(FinishReason.OTHER);
  });

  it.each(['failed', 'cancelled'] as const)('maps %s to OTHER', (status) => {
    expect(mapFinishReason({status})).toBe(FinishReason.OTHER);
  });

  it('leaves an in-flight response without a finish reason', () => {
    expect(mapFinishReason({status: 'in_progress'})).toBeUndefined();
    expect(mapFinishReason({})).toBeUndefined();
  });
});

describe('messageContentParts', () => {
  it('prefixes a refusal and keeps plain text', () => {
    expect(
      messageContentParts(
        outputMessage([
          outputText('Hello'),
          {type: 'refusal', refusal: 'I cannot help.'},
        ]),
      ),
    ).toEqual([{text: 'Hello'}, {text: 'OpenAI refusal: I cannot help.'}]);
  });

  it('skips empty text and an empty refusal', () => {
    expect(
      messageContentParts(
        outputMessage([outputText(''), {type: 'refusal', refusal: ''}]),
      ),
    ).toEqual([]);
  });
});

describe('reasoningParts', () => {
  it('turns summary and content into signed thought parts', () => {
    const {parts, metadata} = reasoningParts(
      reasoningItem({
        summary: [{type: 'summary_text', text: 'Summary'}],
        content: [{type: 'reasoning_text', text: 'Detail'}],
        encrypted_content: 'encrypted',
      }),
    );

    expect(parts).toEqual([
      {text: 'Summary', thought: true, thoughtSignature: 'ZW5jcnlwdGVk'},
      {text: 'Detail', thought: true, thoughtSignature: 'ZW5jcnlwdGVk'},
    ]);
    expect(metadata).toEqual({encrypted_content: 'encrypted', id: 'rs_1'});
  });

  it('emits a signature-only part for redacted reasoning', () => {
    const {parts} = reasoningParts(
      reasoningItem({encrypted_content: 'encrypted'}),
    );

    expect(parts).toEqual([{thought: true, thoughtSignature: 'ZW5jcnlwdGVk'}]);
  });

  it('omits the signature when there is no encrypted content', () => {
    const {parts, metadata} = reasoningParts(
      reasoningItem({summary: [{type: 'summary_text', text: 'Summary'}]}),
    );

    expect(parts).toEqual([
      {text: 'Summary', thought: true, thoughtSignature: undefined},
    ]);
    expect(metadata).toEqual({id: 'rs_1'});
  });

  it('skips a summary entry without text', () => {
    const {parts} = reasoningParts(
      reasoningItem({summary: [{type: 'summary_text', text: ''}]}),
    );

    expect(parts).toEqual([]);
  });
});

describe('functionCallPart', () => {
  it('reads the call id, name and parsed arguments', () => {
    expect(functionCallPart(functionCall())).toEqual({
      functionCall: {id: 'call_1', name: 'get_weather', args: {city: 'SF'}},
    });
  });

  it('falls back to the item id and warns about a missing name', () => {
    const warn = vi.spyOn(getLogger(), 'warn').mockImplementation(() => {});

    expect(
      functionCallPart(functionCall({call_id: '', id: 'fc_1', name: ''})),
    ).toEqual({functionCall: {id: 'fc_1', name: '', args: {city: 'SF'}}});

    expect(warn).toHaveBeenCalledWith(
      'OpenAI Responses function call is missing a name.',
    );
    warn.mockRestore();
  });
});

describe('responseToLlmResponse', () => {
  it('maps text, reasoning, tool calls, usage and metadata', () => {
    const response = responseToLlmResponse(
      {
        id: 'resp_1',
        model: 'gpt-5',
        status: 'completed',
        output: [
          reasoningItem({
            summary: [{type: 'summary_text', text: 'Thinking'}],
            encrypted_content: 'encrypted',
          }),
          outputMessage([outputText('Hello')]),
          functionCall(),
        ],
        usage: {
          input_tokens: 11,
          output_tokens: 7,
          total_tokens: 18,
          input_tokens_details: {cached_tokens: 3, cache_write_tokens: 0},
          output_tokens_details: {reasoning_tokens: 5},
        },
      },
      {includeResponseMetadata: true},
    );

    expect(response.content?.parts).toEqual([
      {text: 'Thinking', thought: true, thoughtSignature: 'ZW5jcnlwdGVk'},
      {text: 'Hello'},
      {functionCall: {id: 'call_1', name: 'get_weather', args: {city: 'SF'}}},
    ]);
    expect(response.finishReason).toBe(FinishReason.STOP);
    expect(response.interactionId).toBe('resp_1');
    expect(response.modelVersion).toBe('gpt-5');
    expect(response.usageMetadata).toMatchObject({totalTokenCount: 18});
    expect(response.errorCode).toBeUndefined();
    const metadata = response.customMetadata?.['openai_response'];
    expect(metadata).toMatchObject({
      id: 'resp_1',
      status: 'completed',
      reasoning: [{encrypted_content: 'encrypted', id: 'rs_1'}],
    });
  });

  it('records an output item it cannot map as unmapped', () => {
    const response = responseToLlmResponse(
      {
        id: 'resp_1',
        status: 'completed',
        output: [
          {
            type: 'web_search_call',
            id: 'ws_1',
            status: 'completed',
            action: {type: 'search'},
          },
        ],
      },
      {includeResponseMetadata: true},
    );

    expect(response.content).toBeUndefined();
    expect(response.customMetadata?.['openai_response']).toMatchObject({
      unmapped_output: [{type: 'web_search_call'}],
    });
  });

  it('omits the raw response when metadata is switched off', () => {
    const response = responseToLlmResponse(
      {
        id: 'resp_1',
        status: 'completed',
        output: [outputMessage([outputText('Hello')])],
        usage: {
          input_tokens: 1,
          output_tokens: 2,
          total_tokens: 3,
          input_tokens_details: {cached_tokens: 0, cache_write_tokens: 0},
          output_tokens_details: {reasoning_tokens: 0},
        },
      },
      {includeResponseMetadata: false},
    );

    expect(response.customMetadata).toBeUndefined();
    expect(response.usageMetadata).toMatchObject({totalTokenCount: 3});
  });

  it('reports an output-token cutoff as an error', () => {
    const response = responseToLlmResponse(
      {
        id: 'resp_1',
        status: 'incomplete',
        incomplete_details: {reason: 'max_output_tokens'},
        output: [outputMessage([outputText('Partial')])],
      },
      {includeResponseMetadata: true},
    );

    expect(response.finishReason).toBe(FinishReason.MAX_TOKENS);
    expect(response.errorCode).toBe(FinishReason.MAX_TOKENS);
    expect(response.errorMessage).toContain('max_output_tokens');
  });

  it('reports a failed response as an error', () => {
    const response = responseToLlmResponse(
      {
        id: 'resp_1',
        status: 'failed',
        error: {code: 'server_error', message: 'boom'},
        output: [],
      },
      {includeResponseMetadata: true},
    );

    expect(response.errorCode).toBe(FinishReason.OTHER);
    expect(response.errorMessage).toContain('boom');
  });

  it('handles a response that reports no output at all', () => {
    const response = responseToLlmResponse(
      {id: 'resp_1', status: 'completed'},
      {includeResponseMetadata: true},
    );

    expect(response.content).toBeUndefined();
    expect(response.customMetadata?.['openai_response']).toMatchObject({
      output: [],
    });
  });

  it('leaves the error message unset when the response explains nothing', () => {
    const response = responseToLlmResponse(
      {id: 'resp_1', status: 'cancelled', output: []},
      {includeResponseMetadata: true},
    );

    expect(response.errorCode).toBe(FinishReason.OTHER);
    expect(response.errorMessage).toBeUndefined();
  });
});
