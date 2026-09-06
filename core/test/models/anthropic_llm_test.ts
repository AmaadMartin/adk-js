/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {AnthropicLlm, LlmRequest, LlmResponse} from '@google/adk';
import {
  Content,
  FinishReason,
  FunctionDeclaration,
  Part,
  Type,
} from '@google/genai';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {
  AnthropicContentBlock,
  AnthropicMessage,
  AnthropicToolResultBlockParam,
  AnthropicToolUseBlockParam,
  buildAnthropicThinkingParam,
  buildEffortParam,
  contentBlockToPart,
  contentToMessageParam,
  extractCachedTokenCount,
  functionDeclarationToToolParam,
  isImagePart,
  isPdfPart,
  messageToGenerateContentResponse,
  partToMessageBlock,
  STOP_REASON_MAPPING,
  toClaudeRole,
  toGoogleGenAIFinishReason,
  ToolUseIdSanitizer,
  updateTypeString,
} from '../../src/models/anthropic_llm.js';
import {logger} from '../../src/utils/logger.js';

const API_KEY = 'test-api-key';

function makeLlm(params: Record<string, unknown> = {}): AnthropicLlm {
  return new AnthropicLlm({apiKey: API_KEY, ...params});
}

function makeRequest(overrides: Record<string, unknown> = {}): LlmRequest {
  return {
    model: 'claude-sonnet-4-20250514',
    contents: [{role: 'user', parts: [{text: 'Hello'}]}],
    config: {},
    liveConnectConfig: {},
    toolsDict: {},
    ...overrides,
  } as LlmRequest;
}

function textMessage(text: string): AnthropicMessage {
  return {
    id: 'msg_test',
    model: 'claude-sonnet-4-20250514',
    role: 'assistant',
    stop_reason: 'end_turn',
    stop_sequence: null,
    type: 'message',
    content: [{type: 'text', text}],
    usage: {input_tokens: 5, output_tokens: 2, cache_read_input_tokens: 0},
  };
}

function mockFetchJson(message: AnthropicMessage) {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => message,
    text: async () => JSON.stringify(message),
  });
}

function sseChunks(events: object[]): string[] {
  return events.map(
    (event) =>
      `event: ${(event as {type: string}).type}\ndata: ${JSON.stringify(event)}\n\n`,
  );
}

function makeStreamBody(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

function mockFetchStream(events: object[]) {
  const body = makeStreamBody(sseChunks(events));
  globalThis.fetch = vi.fn().mockResolvedValue({ok: true, status: 200, body});
}

async function collect(
  gen: AsyncGenerator<LlmResponse, void>,
): Promise<LlmResponse[]> {
  const responses: LlmResponse[] = [];
  for await (const response of gen) {
    responses.push(response);
  }
  return responses;
}

function requestBody(): Record<string, unknown> {
  const call = vi.mocked(globalThis.fetch).mock.calls[0];
  return JSON.parse((call[1] as {body: string}).body);
}

describe('AnthropicLlm', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('constructor and static config', () => {
    it('defaults the model to claude-sonnet-4-20250514', () => {
      expect(makeLlm().model).toBe('claude-sonnet-4-20250514');
    });

    it('accepts a custom model', () => {
      expect(makeLlm({model: 'claude-3-opus'}).model).toBe('claude-3-opus');
    });

    it('throws when no API key is available', () => {
      const original = process.env['ANTHROPIC_API_KEY'];
      delete process.env['ANTHROPIC_API_KEY'];
      try {
        expect(() => new AnthropicLlm({model: 'claude-3-opus'})).toThrow(
          /API key must be provided/,
        );
      } finally {
        if (original !== undefined) {
          process.env['ANTHROPIC_API_KEY'] = original;
        }
      }
    });

    it('reads the API key from ANTHROPIC_API_KEY when no param is passed', async () => {
      const original = process.env['ANTHROPIC_API_KEY'];
      process.env['ANTHROPIC_API_KEY'] = 'env-key';
      try {
        const llm = new AnthropicLlm({model: 'claude-sonnet-4-20250514'});
        mockFetchJson(textMessage('ok'));
        await collect(llm.generateContentAsync(makeRequest(), false));
        const headers = vi.mocked(globalThis.fetch).mock.calls[0][1]!
          .headers as Record<string, string>;
        expect(headers['x-api-key']).toBe('env-key');
      } finally {
        if (original === undefined) {
          delete process.env['ANTHROPIC_API_KEY'];
        } else {
          process.env['ANTHROPIC_API_KEY'] = original;
        }
      }
    });

    it('exposes the two supported model regexes', () => {
      expect(AnthropicLlm.supportedModels).toHaveLength(2);
      expect(AnthropicLlm.supportedModels[0]).toEqual(/claude-3-.*/);
      expect(AnthropicLlm.supportedModels[1]).toEqual(/claude-.*-4.*/);
    });

    it('rejects connect() because live is unsupported', async () => {
      await expect(makeLlm().connect(makeRequest())).rejects.toThrow(
        'Live connection is not supported for AnthropicLlm.',
      );
    });
  });

  describe('toClaudeRole', () => {
    it('maps model and assistant to assistant, everything else to user', () => {
      expect(toClaudeRole('model')).toBe('assistant');
      expect(toClaudeRole('assistant')).toBe('assistant');
      expect(toClaudeRole('user')).toBe('user');
      expect(toClaudeRole(undefined)).toBe('user');
    });
  });

  describe('toGoogleGenAIFinishReason', () => {
    it('maps stop reasons, null and unknown values', () => {
      expect(toGoogleGenAIFinishReason('end_turn')).toBe(FinishReason.STOP);
      expect(toGoogleGenAIFinishReason('stop_sequence')).toBe(
        FinishReason.STOP,
      );
      expect(toGoogleGenAIFinishReason('tool_use')).toBe(FinishReason.STOP);
      expect(toGoogleGenAIFinishReason('pause_turn')).toBe(FinishReason.STOP);
      expect(toGoogleGenAIFinishReason('max_tokens')).toBe(
        FinishReason.MAX_TOKENS,
      );
      expect(toGoogleGenAIFinishReason('refusal')).toBe(FinishReason.SAFETY);
      expect(toGoogleGenAIFinishReason(null)).toBeUndefined();
      expect(toGoogleGenAIFinishReason(undefined)).toBeUndefined();
      expect(toGoogleGenAIFinishReason('mystery')).toBe(
        FinishReason.FINISH_REASON_UNSPECIFIED,
      );
      expect(STOP_REASON_MAPPING['end_turn']).toBe(FinishReason.STOP);
    });
  });

  describe('isImagePart / isPdfPart', () => {
    it('detects image and PDF parts', () => {
      expect(
        isImagePart({inlineData: {mimeType: 'image/png', data: 'x'}}),
      ).toBe(true);
      expect(isImagePart({text: 'no'})).toBe(false);
      expect(
        isPdfPart({inlineData: {mimeType: 'application/pdf', data: 'x'}}),
      ).toBe(true);
      expect(
        isPdfPart({
          inlineData: {mimeType: 'application/pdf; name=a.pdf', data: 'x'},
        }),
      ).toBe(true);
      expect(isPdfPart({text: 'no'})).toBe(false);
      expect(isPdfPart({inlineData: {mimeType: 'image/png', data: 'x'}})).toBe(
        false,
      );
    });
  });

  describe('ToolUseIdSanitizer', () => {
    it('passes through valid ids and generates deterministic fallbacks', () => {
      const sanitizer = new ToolUseIdSanitizer();
      expect(sanitizer.sanitize('toolu_01abc')).toBe('toolu_01abc');
      expect(sanitizer.sanitize('adk-12345678-1234')).toBe('adk-12345678-1234');
      const first = sanitizer.sanitize('bad id!');
      expect(first).toMatch(/^toolu_fallback_\d+$/);
      // Repeated invalid id resolves to the same fallback.
      expect(sanitizer.sanitize('bad id!')).toBe(first);
      // null and empty share the same "" key.
      expect(sanitizer.sanitize(null)).toBe(sanitizer.sanitize(''));
    });
  });

  describe('partToMessageBlock: function_response content precedence', () => {
    function toolResult(
      response: Record<string, unknown>,
      id = 'test_id',
    ): AnthropicToolResultBlockParam {
      const part: Part = {functionResponse: {id, name: 'tool', response}};
      return partToMessageBlock(part) as AnthropicToolResultBlockParam;
    }

    it('extracts a single text item from a content array', () => {
      const result = toolResult({
        content: [{type: 'text', text: '{"name":"root","node_type":"folder"}'}],
      });
      expect(result.type).toBe('tool_result');
      expect(result.tool_use_id).toBe('test_id');
      expect(result.is_error).toBe(false);
      expect(result.content).toContain('"name":"root"');
    });

    it('joins multiple content items with newlines and stringifies non-text items', () => {
      const result = toolResult({
        content: [{type: 'text', text: 'First part'}, {type: 'other'}, 'plain'],
      });
      expect(result.content).toBe('First part\n[object Object]\nplain');
    });

    it('uses a scalar string content value verbatim', () => {
      expect(toolResult({content: 'Hello'}).content).toBe('Hello');
    });

    it('uses a file-text content string verbatim', () => {
      const fileText = 'Line one\nLine two';
      expect(toolResult({content: fileText, file_path: 'a.md'}).content).toBe(
        fileText,
      );
    });

    it('falls through to a JSON dump for empty-string content', () => {
      expect(JSON.parse(toolResult({content: ''}).content)).toEqual({
        content: '',
      });
    });

    it('keeps sibling metadata when content is empty', () => {
      const parsed = JSON.parse(
        toolResult({content: '', extra: 'keep me'}).content,
      );
      expect(parsed).toEqual({content: '', extra: 'keep me'});
    });

    it('serializes a traditional string result verbatim', () => {
      expect(toolResult({result: 'This is the result'}).content).toBe(
        'This is the result',
      );
    });

    it('serializes a dict result as JSON', () => {
      const parsed = JSON.parse(
        toolResult({result: {topic: 'travel', active: true, count: null}})
          .content,
      );
      expect(parsed).toEqual({topic: 'travel', active: true, count: null});
    });

    it('serializes a list result as JSON', () => {
      expect(JSON.parse(toolResult({result: ['a', 'b', 'c']}).content)).toEqual(
        ['a', 'b', 'c'],
      );
    });

    it('serializes an empty dict result as {} and empty list as []', () => {
      expect(toolResult({result: {}}).content).toBe('{}');
      expect(toolResult({result: []}).content).toBe('[]');
    });

    it('serializes a scalar number result via String', () => {
      expect(toolResult({result: 42}).content).toBe('42');
    });

    it('serializes a nested dict result as valid JSON', () => {
      const parsed = JSON.parse(
        toolResult({
          result: {
            results: [
              {id: 1, tags: ['a', 'b']},
              {id: 2, meta: {key: 'val'}},
            ],
            has_more: false,
          },
        }).content,
      );
      expect(parsed.has_more).toBe(false);
      expect(parsed.results[0].tags).toEqual(['a', 'b']);
    });

    it('serializes arbitrary dicts (e.g. load_skill) as JSON', () => {
      const parsed = JSON.parse(
        toolResult({
          skill_name: 'my_skill',
          instructions: 'Step 1',
          frontmatter: {version: '1.0'},
        }).content,
      );
      expect(parsed.skill_name).toBe('my_skill');
      expect(parsed.frontmatter.version).toBe('1.0');
    });

    it('serializes run-skill-script-shaped dicts', () => {
      const parsed = JSON.parse(
        toolResult({stdout: 'Done.', stderr: '', status: 'success'}).content,
      );
      expect(parsed.status).toBe('success');
      expect(parsed.stdout).toBe('Done.');
    });

    it('serializes error dicts', () => {
      const parsed = JSON.parse(
        toolResult({error: 'not found', error_code: 'SKILL_NOT_FOUND'}).content,
      );
      expect(parsed.error_code).toBe('SKILL_NOT_FOUND');
    });

    it('keeps a null result via the whole-dict JSON fallback', () => {
      expect(JSON.parse(toolResult({result: null}).content)).toEqual({
        result: null,
      });
    });

    it('produces empty content for an empty response object', () => {
      expect(toolResult({}).content).toBe('');
    });

    it('produces empty content when the response is absent', () => {
      const part: Part = {functionResponse: {id: 'x', name: 'tool'}};
      const result = partToMessageBlock(part) as AnthropicToolResultBlockParam;
      expect(result.content).toBe('');
    });
  });

  describe('partToMessageBlock: ids, thinking, media, code', () => {
    it('round-trips a valid function_call id', () => {
      const part: Part = {
        functionCall: {id: 'toolu_01abc', name: 't', args: {k: 'v'}},
      };
      const block = partToMessageBlock(part) as AnthropicToolUseBlockParam;
      expect(block.type).toBe('tool_use');
      expect(block.id).toBe('toolu_01abc');
      expect(block.input).toEqual({k: 'v'});
    });

    it('round-trips an adk-<uuid> id', () => {
      const id = 'adk-12345678-1234-1234-1234-123456789012';
      const call = partToMessageBlock({
        functionCall: {id, name: 't', args: {}},
      }) as AnthropicToolUseBlockParam;
      const response = partToMessageBlock({
        functionResponse: {id, name: 't', response: {result: 'ok'}},
      }) as AnthropicToolResultBlockParam;
      expect(call.id).toBe(id);
      expect(response.tool_use_id).toBe(id);
      expect(call.id).toBe(response.tool_use_id);
    });

    it('generates a valid id for null, empty and invalid-char ids', () => {
      for (const id of [null, '', 'invalid id with spaces!']) {
        const block = partToMessageBlock({
          functionCall: {id: id as string | undefined, name: 't', args: {}},
        }) as AnthropicToolUseBlockParam;
        expect(block.id).toMatch(/^toolu_fallback_\d+$/);
        expect(/^[a-zA-Z0-9_-]+$/.test(block.id)).toBe(true);
      }
    });

    it('defaults function_call args to an empty object', () => {
      const block = partToMessageBlock({
        functionCall: {id: 'toolu_1', name: 't'},
      }) as AnthropicToolUseBlockParam;
      expect(block.input).toEqual({});
    });

    it('throws when a tool_use part is missing the function name', () => {
      expect(() =>
        partToMessageBlock({functionCall: {id: 'toolu_1', args: {}}}),
      ).toThrow('function_call.name is required for tool_use.');
    });

    it('converts a thought+text part to a thinking block', () => {
      const block = partToMessageBlock({
        text: 'My reasoning steps.',
        thought: true,
        thoughtSignature: 'roundtrip_sig',
      });
      expect(block).toEqual({
        type: 'thinking',
        thinking: 'My reasoning steps.',
        signature: 'roundtrip_sig',
      });
    });

    it('defaults a thinking block signature to empty string', () => {
      const block = partToMessageBlock({text: 'reason', thought: true});
      expect(block).toEqual({
        type: 'thinking',
        thinking: 'reason',
        signature: '',
      });
    });

    it('converts a thought-only signature part to a redacted_thinking block', () => {
      const block = partToMessageBlock({
        thought: true,
        thoughtSignature: 'encrypted_blob',
      });
      expect(block).toEqual({
        type: 'redacted_thinking',
        data: 'encrypted_blob',
      });
    });

    it('passes PDF document data through without re-encoding', () => {
      const data = 'JVBERi0xLjQ=';
      const block = partToMessageBlock({
        inlineData: {mimeType: 'application/pdf', data},
      });
      expect(block).toEqual({
        type: 'document',
        source: {type: 'base64', media_type: 'application/pdf', data},
      });
    });

    it('keeps MIME parameters on document media_type', () => {
      const block = partToMessageBlock({
        inlineData: {mimeType: 'application/pdf; name=doc.pdf', data: 'AA=='},
      });
      expect((block as {source: {media_type: string}}).source.media_type).toBe(
        'application/pdf; name=doc.pdf',
      );
    });

    it('passes image data through as a base64 image block', () => {
      const block = partToMessageBlock({
        inlineData: {mimeType: 'image/jpeg', data: 'aW1n'},
      });
      expect(block).toEqual({
        type: 'image',
        source: {type: 'base64', media_type: 'image/jpeg', data: 'aW1n'},
      });
    });

    it('converts executable code to a text block', () => {
      const block = partToMessageBlock({
        executableCode: {code: 'print(1)', language: 'PYTHON' as never},
      });
      expect(block).toEqual({
        type: 'text',
        text: 'Code:```python\nprint(1)\n```',
      });
    });

    it('converts a code execution result to a text block', () => {
      const block = partToMessageBlock({
        codeExecutionResult: {output: '1', outcome: 'OUTCOME_OK' as never},
      });
      expect(block).toEqual({
        type: 'text',
        text: 'Execution Result:```code_output\n1\n```',
      });
    });

    it('defaults missing inline/code payloads to empty strings', () => {
      expect(partToMessageBlock({inlineData: {mimeType: 'image/png'}})).toEqual(
        {
          type: 'image',
          source: {type: 'base64', media_type: 'image/png', data: ''},
        },
      );
      expect(
        partToMessageBlock({inlineData: {mimeType: 'application/pdf'}}),
      ).toEqual({
        type: 'document',
        source: {type: 'base64', media_type: 'application/pdf', data: ''},
      });
      expect(
        partToMessageBlock({executableCode: {language: 'PYTHON' as never}}),
      ).toEqual({type: 'text', text: 'Code:```python\n\n```'});
      expect(
        partToMessageBlock({
          codeExecutionResult: {outcome: 'OUTCOME_OK' as never},
        }),
      ).toEqual({type: 'text', text: 'Execution Result:```code_output\n\n```'});
    });

    it('throws for an unsupported part', () => {
      expect(() => partToMessageBlock({})).toThrow('Not supported yet:');
    });
  });

  describe('contentToMessageParam', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('keeps text and image for a user turn', () => {
      const warn = vi.spyOn(logger, 'warn');
      const message = contentToMessageParam({
        role: 'user',
        parts: [
          {text: "What's in this image?"},
          {inlineData: {mimeType: 'image/jpeg', data: 'aW1n'}},
        ],
      });
      expect(message.role).toBe('user');
      expect(message.content).toHaveLength(2);
      expect(warn).not.toHaveBeenCalled();
    });

    it('filters image on a model turn and warns', () => {
      const warn = vi.spyOn(logger, 'warn');
      const message = contentToMessageParam({
        role: 'model',
        parts: [
          {text: 'I see a cat.'},
          {inlineData: {mimeType: 'image/png', data: 'aW1n'}},
        ],
      });
      expect(message.role).toBe('assistant');
      expect(message.content).toHaveLength(1);
      expect(warn).toHaveBeenCalledWith(
        'Image data is not supported in Claude for assistant turns.',
      );
    });

    it('filters image on an assistant turn and warns', () => {
      const warn = vi.spyOn(logger, 'warn');
      const message = contentToMessageParam({
        role: 'assistant',
        parts: [
          {text: "Here's what I found."},
          {inlineData: {mimeType: 'image/webp', data: 'aW1n'}},
        ],
      });
      expect(message.role).toBe('assistant');
      expect(message.content).toHaveLength(1);
      expect(warn).toHaveBeenCalledWith(
        'Image data is not supported in Claude for assistant turns.',
      );
    });

    it('keeps text and document for a user turn', () => {
      const message = contentToMessageParam({
        role: 'user',
        parts: [
          {text: 'Summarize this.'},
          {inlineData: {mimeType: 'application/pdf', data: 'AA=='}},
        ],
      });
      expect(message.content).toHaveLength(2);
    });

    it('handles a content with no parts', () => {
      const message = contentToMessageParam({role: 'user'});
      expect(message).toEqual({role: 'user', content: []});
    });

    it('filters document on a model turn and warns', () => {
      const warn = vi.spyOn(logger, 'warn');
      const message = contentToMessageParam({
        role: 'model',
        parts: [
          {text: 'Here is the summary.'},
          {inlineData: {mimeType: 'application/pdf', data: 'AA=='}},
        ],
      });
      expect(message.content).toHaveLength(1);
      expect(warn).toHaveBeenCalledWith(
        'PDF data is not supported in Claude for assistant turns.',
      );
    });
  });

  describe('contentBlockToPart', () => {
    it('converts a thinking block with a signature', () => {
      const part = contentBlockToPart({
        type: 'thinking',
        thinking: 'Let me reason.',
        signature: 'sig_abc',
      });
      expect(part.text).toBe('Let me reason.');
      expect(part.thought).toBe(true);
      expect(part.thoughtSignature).toBe('sig_abc');
    });

    it('omits the signature when a thinking block has none', () => {
      const part = contentBlockToPart({
        type: 'thinking',
        thinking: 'Let me reason.',
        signature: '',
      });
      expect(part.thoughtSignature).toBeUndefined();
    });

    it('preserves the blob for a redacted thinking block', () => {
      const part = contentBlockToPart({
        type: 'redacted_thinking',
        data: 'redacted_data',
      });
      expect(part.thought).toBe(true);
      expect(part.text).toBeUndefined();
      expect(part.thoughtSignature).toBe('redacted_data');
    });

    it('converts text and tool_use blocks', () => {
      expect(contentBlockToPart({type: 'text', text: 'hi'})).toEqual({
        text: 'hi',
      });
      expect(
        contentBlockToPart({
          type: 'tool_use',
          id: 'toolu_1',
          name: 'get_weather',
          input: {city: 'Paris'},
        }),
      ).toEqual({
        functionCall: {
          id: 'toolu_1',
          name: 'get_weather',
          args: {city: 'Paris'},
        },
      });
    });

    it('throws for an unsupported block type', () => {
      expect(() =>
        contentBlockToPart({
          type: 'unknown',
        } as unknown as AnthropicContentBlock),
      ).toThrow('Unsupported content block type:');
    });
  });

  describe('extractCachedTokenCount', () => {
    it('returns the count when numeric, otherwise undefined', () => {
      expect(
        extractCachedTokenCount({
          input_tokens: 1,
          output_tokens: 1,
          cache_read_input_tokens: 75,
        }),
      ).toBe(75);
      expect(
        extractCachedTokenCount({
          input_tokens: 1,
          output_tokens: 1,
          cache_read_input_tokens: null,
        }),
      ).toBeUndefined();
      expect(
        extractCachedTokenCount({input_tokens: 1, output_tokens: 1}),
      ).toBeUndefined();
    });
  });

  describe('messageToGenerateContentResponse', () => {
    it('maps thinking, redacted and text blocks to three parts', () => {
      const message: AnthropicMessage = {
        id: 'msg',
        model: 'claude-sonnet-4-20250514',
        role: 'assistant',
        stop_reason: 'end_turn',
        stop_sequence: null,
        type: 'message',
        content: [
          {
            type: 'thinking',
            thinking: 'I need to think.',
            signature: 'sig_xyz',
          },
          {type: 'redacted_thinking', data: 'hidden'},
          {type: 'text', text: 'Here is my answer.'},
        ],
        usage: {input_tokens: 10, output_tokens: 20},
      };

      const response = messageToGenerateContentResponse(message);
      const parts = response.content!.parts!;
      expect(parts).toHaveLength(3);
      expect(parts[0]).toEqual({
        text: 'I need to think.',
        thought: true,
        thoughtSignature: 'sig_xyz',
      });
      expect(parts[1]).toEqual({thought: true, thoughtSignature: 'hidden'});
      expect(parts[2]).toEqual({text: 'Here is my answer.'});
      expect(response.finishReason).toBe(FinishReason.STOP);
      expect(response.usageMetadata!.totalTokenCount).toBe(30);
    });

    it('maps cache_read_input_tokens to cachedContentTokenCount', () => {
      const message = textMessage('hi');
      message.usage = {
        input_tokens: 100,
        output_tokens: 20,
        cache_read_input_tokens: 75,
      };
      expect(
        messageToGenerateContentResponse(message).usageMetadata!
          .cachedContentTokenCount,
      ).toBe(75);
    });

    it('yields undefined cachedContentTokenCount when absent', () => {
      const message = textMessage('hi');
      message.usage = {input_tokens: 100, output_tokens: 20};
      expect(
        messageToGenerateContentResponse(message).usageMetadata!
          .cachedContentTokenCount,
      ).toBeUndefined();
    });
  });

  describe('updateTypeString', () => {
    it('is a no-op for primitives, null and arrays of primitives', () => {
      expect(() => updateTypeString(null)).not.toThrow();
      expect(() => updateTypeString('str')).not.toThrow();
      expect(() => updateTypeString(42)).not.toThrow();
    });

    it('lowercases nested type strings across combinators', () => {
      const schema = {
        type: 'OBJECT',
        properties: {choice: {oneOf: [{type: 'STRING'}]}},
        items: [{type: 'INTEGER'}],
      };
      updateTypeString(schema);
      expect(schema.type).toBe('object');
      expect(schema.properties.choice.oneOf[0].type).toBe('string');
      expect(schema.items[0].type).toBe('integer');
    });
  });

  describe('functionDeclarationToToolParam', () => {
    const cases: Array<[string, FunctionDeclaration, unknown]> = [
      [
        'no parameters',
        {name: 'get_current_time', description: 'Gets the current time.'},
        {type: 'object', properties: {}},
      ],
      [
        'one optional parameter',
        {
          name: 'get_weather',
          description: 'Gets weather.',
          parameters: {
            type: Type.OBJECT,
            properties: {
              location: {type: Type.STRING, description: 'City and state'},
            },
          },
        },
        {
          type: 'object',
          properties: {
            location: {type: 'string', description: 'City and state'},
          },
        },
      ],
      [
        'one required parameter',
        {
          name: 'get_stock_price',
          description: 'Gets a stock price.',
          parameters: {
            type: Type.OBJECT,
            properties: {ticker: {type: Type.STRING, description: 'AAPL'}},
            required: ['ticker'],
          },
        },
        {
          type: 'object',
          properties: {ticker: {type: 'string', description: 'AAPL'}},
          required: ['ticker'],
        },
      ],
      [
        'multiple mixed parameters',
        {
          name: 'submit_order',
          description: 'Submits an order.',
          parameters: {
            type: Type.OBJECT,
            properties: {
              product_id: {type: Type.STRING, description: 'The product ID'},
              quantity: {type: Type.INTEGER, description: 'The quantity'},
              notes: {type: Type.STRING, description: 'Notes'},
            },
            required: ['product_id', 'quantity'],
          },
        },
        {
          type: 'object',
          properties: {
            product_id: {type: 'string', description: 'The product ID'},
            quantity: {type: 'integer', description: 'The quantity'},
            notes: {type: 'string', description: 'Notes'},
          },
          required: ['product_id', 'quantity'],
        },
      ],
      [
        'nested array of objects',
        {
          name: 'create_playlist',
          description: 'Creates a playlist.',
          parameters: {
            type: Type.OBJECT,
            properties: {
              songs: {
                type: Type.ARRAY,
                description: 'Songs',
                items: {
                  type: Type.OBJECT,
                  properties: {
                    title: {type: Type.STRING},
                    artist: {type: Type.STRING},
                  },
                  required: ['title', 'artist'],
                },
              },
            },
            required: ['songs'],
          },
        },
        {
          type: 'object',
          properties: {
            songs: {
              type: 'array',
              description: 'Songs',
              items: {
                type: 'object',
                properties: {
                  title: {type: 'string'},
                  artist: {type: 'string'},
                },
                required: ['title', 'artist'],
              },
            },
          },
          required: ['songs'],
        },
      ],
      [
        'nested object',
        {
          name: 'update_profile',
          description: 'Updates a profile.',
          parameters: {
            type: Type.OBJECT,
            properties: {
              profile: {
                type: Type.OBJECT,
                description: 'Profile',
                properties: {
                  name: {type: Type.STRING},
                  address: {
                    type: Type.OBJECT,
                    properties: {city: {type: Type.STRING}},
                  },
                },
              },
            },
            required: ['profile'],
          },
        },
        {
          type: 'object',
          properties: {
            profile: {
              type: 'object',
              description: 'Profile',
              properties: {
                name: {type: 'string'},
                address: {type: 'object', properties: {city: {type: 'string'}}},
              },
            },
          },
          required: ['profile'],
        },
      ],
      [
        'anyOf parameter',
        {
          name: 'set_value',
          description: 'Sets a value.',
          parameters: {
            type: Type.OBJECT,
            properties: {
              value: {
                description: 'A string or integer',
                anyOf: [{type: Type.STRING}, {type: Type.INTEGER}],
              },
            },
            required: ['value'],
          },
        },
        {
          type: 'object',
          properties: {
            value: {
              description: 'A string or integer',
              anyOf: [{type: 'string'}, {type: 'integer'}],
            },
          },
          required: ['value'],
        },
      ],
      [
        'additionalProperties via parametersJsonSchema',
        {
          name: 'store_metadata',
          description: 'Stores metadata.',
          parametersJsonSchema: {
            type: 'OBJECT',
            properties: {
              metadata: {
                type: 'OBJECT',
                description: 'Arbitrary metadata',
                additionalProperties: {type: 'STRING'},
              },
            },
            required: ['metadata'],
          },
        },
        {
          type: 'object',
          properties: {
            metadata: {
              type: 'object',
              description: 'Arbitrary metadata',
              additionalProperties: {type: 'string'},
            },
          },
          required: ['metadata'],
        },
      ],
      [
        'parametersJsonSchema with combinators',
        {
          name: 'validate_payload',
          description: 'Validates.',
          parametersJsonSchema: {
            type: 'OBJECT',
            properties: {
              choice: {oneOf: [{type: 'STRING'}, {type: 'INTEGER'}]},
              config: {
                allOf: [
                  {type: 'OBJECT', properties: {enabled: {type: 'BOOLEAN'}}},
                ],
              },
              blocked: {not: {type: 'NULL'}},
              tuple_value: {
                type: 'ARRAY',
                items: [{type: 'STRING'}, {type: 'INTEGER'}],
              },
            },
            required: ['choice'],
          },
        },
        {
          type: 'object',
          properties: {
            choice: {oneOf: [{type: 'string'}, {type: 'integer'}]},
            config: {
              allOf: [
                {type: 'object', properties: {enabled: {type: 'boolean'}}},
              ],
            },
            blocked: {not: {type: 'null'}},
            tuple_value: {
              type: 'array',
              items: [{type: 'string'}, {type: 'integer'}],
            },
          },
          required: ['choice'],
        },
      ],
      [
        'plain parametersJsonSchema',
        {
          name: 'search_database',
          description: 'Searches.',
          parametersJsonSchema: {
            type: 'object',
            properties: {
              query: {type: 'string', description: 'The search query'},
              limit: {type: 'integer', description: 'Max results'},
            },
            required: ['query'],
          },
        },
        {
          type: 'object',
          properties: {
            query: {type: 'string', description: 'The search query'},
            limit: {type: 'integer', description: 'Max results'},
          },
          required: ['query'],
        },
      ],
    ];

    it.each(cases)('handles %s', (_name, declaration, expectedSchema) => {
      const result = functionDeclarationToToolParam(declaration);
      expect(result.name).toBe(declaration.name);
      expect(result.description).toBe(declaration.description);
      expect(result.input_schema).toEqual(expectedSchema);
    });

    it('drops undefined schema fields (exclude_none)', () => {
      const result = functionDeclarationToToolParam({
        name: 't',
        description: 'd',
        parameters: {
          type: Type.OBJECT,
          properties: {
            x: {type: Type.STRING, description: 'keep', title: undefined},
          },
        },
      });
      expect(result.input_schema).toEqual({
        type: 'object',
        properties: {x: {type: 'string', description: 'keep'}},
      });
    });

    it('defaults an empty description and throws without a name', () => {
      const result = functionDeclarationToToolParam({name: 'noop'});
      expect(result.description).toBe('');
      expect(() =>
        functionDeclarationToToolParam({} as FunctionDeclaration),
      ).toThrow('function_declaration.name is required.');
    });
  });

  describe('buildAnthropicThinkingParam', () => {
    it('maps thinking budgets to Anthropic thinking params', () => {
      expect(buildAnthropicThinkingParam(undefined)).toBeUndefined();
      expect(
        buildAnthropicThinkingParam({systemInstruction: 'x'}),
      ).toBeUndefined();
      expect(
        buildAnthropicThinkingParam({thinkingConfig: {thinkingBudget: 5000}}),
      ).toEqual({type: 'enabled', budget_tokens: 5000});
      expect(
        buildAnthropicThinkingParam({thinkingConfig: {thinkingBudget: 0}}),
      ).toEqual({type: 'disabled'});
      expect(
        buildAnthropicThinkingParam({thinkingConfig: {thinkingBudget: -1}}),
      ).toEqual({type: 'adaptive'});
      expect(
        buildAnthropicThinkingParam({thinkingConfig: {thinkingBudget: -5}}),
      ).toEqual({type: 'adaptive'});
    });

    it('throws when thinkingBudget is unset', () => {
      expect(() => buildAnthropicThinkingParam({thinkingConfig: {}})).toThrow(
        'thinking_budget must be set explicitly',
      );
    });
  });

  describe('buildEffortParam', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('returns undefined without a config', () => {
      expect(buildEffortParam(undefined)).toBeUndefined();
    });

    it('returns the effort from AnthropicGenerateContentConfig', () => {
      expect(buildEffortParam({effort: 'xhigh'} as never)).toBe('xhigh');
    });

    it('warns and ignores a standard thinkingLevel', () => {
      const warn = vi.spyOn(logger, 'warn');
      expect(
        buildEffortParam({thinkingConfig: {thinkingLevel: 'HIGH' as never}}),
      ).toBeUndefined();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining(
          'Standard thinking_config.thinking_level is not supported',
        ),
      );
    });

    it('returns undefined with no effort and no thinkingLevel', () => {
      expect(buildEffortParam({temperature: 0.5})).toBeUndefined();
    });
  });

  describe('generateContentAsync: non-streaming', () => {
    it('yields a single LlmResponse mapped from the message', async () => {
      mockFetchJson(textMessage('Hello, how can I help you?'));
      const responses = await collect(
        makeLlm().generateContentAsync(makeRequest(), false),
      );
      expect(responses).toHaveLength(1);
      expect(responses[0].content!.parts![0].text).toBe(
        'Hello, how can I help you?',
      );
      expect(responses[0].finishReason).toBe(FinishReason.STOP);
    });

    it('sends the expected headers and endpoint', async () => {
      mockFetchJson(textMessage('ok'));
      await collect(makeLlm().generateContentAsync(makeRequest(), false));
      const [url, init] = vi.mocked(globalThis.fetch).mock.calls[0];
      expect(url).toBe('https://api.anthropic.com/v1/messages');
      const headers = init!.headers as Record<string, string>;
      expect(headers['x-api-key']).toBe(API_KEY);
      expect(headers['anthropic-version']).toBe('2023-06-01');
      expect(headers['content-type']).toBe('application/json');
      expect(headers['x-goog-api-client']).toBeDefined();
    });

    it('honors a custom baseUrl', async () => {
      mockFetchJson(textMessage('ok'));
      await collect(
        makeLlm({baseUrl: 'https://proxy.example.com'}).generateContentAsync(
          makeRequest(),
          false,
        ),
      );
      expect(vi.mocked(globalThis.fetch).mock.calls[0][0]).toBe(
        'https://proxy.example.com/v1/messages',
      );
    });

    it('does not include a stream key when non-streaming', async () => {
      mockFetchJson(textMessage('ok'));
      await collect(makeLlm().generateContentAsync(makeRequest(), false));
      expect(requestBody()).not.toHaveProperty('stream');
    });

    it('uses the default max_tokens of 8192', async () => {
      mockFetchJson(textMessage('ok'));
      await collect(makeLlm().generateContentAsync(makeRequest(), false));
      expect(requestBody().max_tokens).toBe(8192);
    });

    it('uses a custom max_tokens from the constructor', async () => {
      mockFetchJson(textMessage('ok'));
      await collect(
        makeLlm({maxTokens: 4096}).generateContentAsync(makeRequest(), false),
      );
      expect(requestBody().max_tokens).toBe(4096);
    });

    it('passes generation config through', async () => {
      mockFetchJson(textMessage('ok'));
      await collect(
        makeLlm().generateContentAsync(
          makeRequest({
            config: {
              temperature: 0.7,
              topP: 0.9,
              topK: 50,
              stopSequences: ['##'],
              maxOutputTokens: 1024,
            },
          }),
          false,
        ),
      );
      const body = requestBody();
      expect(body.temperature).toBe(0.7);
      expect(body.top_p).toBe(0.9);
      expect(body.top_k).toBe(50);
      expect(body.stop_sequences).toEqual(['##']);
      expect(body.max_tokens).toBe(1024);
    });

    it('falls back to the constructor model when the request omits it', async () => {
      mockFetchJson(textMessage('ok'));
      await collect(
        makeLlm({model: 'claude-3-opus'}).generateContentAsync(
          makeRequest({model: undefined}),
          false,
        ),
      );
      expect(requestBody().model).toBe('claude-3-opus');
    });

    it('omits system when there is no system instruction', async () => {
      mockFetchJson(textMessage('ok'));
      await collect(
        makeLlm().generateContentAsync(makeRequest({config: undefined}), false),
      );
      expect(requestBody()).not.toHaveProperty('system');
    });

    it('includes system when a system instruction is present', async () => {
      mockFetchJson(textMessage('ok'));
      await collect(
        makeLlm().generateContentAsync(
          makeRequest({config: {systemInstruction: 'You are helpful'}}),
          false,
        ),
      );
      expect(requestBody().system).toBe('You are helpful');
    });

    it('includes tools and tool_choice auto when tools are declared', async () => {
      mockFetchJson(textMessage('ok'));
      await collect(
        makeLlm().generateContentAsync(
          makeRequest({
            config: {
              tools: [
                {
                  functionDeclarations: [
                    {name: 'get_weather', description: 'Weather'},
                  ],
                },
              ],
            },
            toolsDict: {get_weather: {}},
          }),
          false,
        ),
      );
      const body = requestBody();
      expect(body.tools).toHaveLength(1);
      expect(body.tool_choice).toEqual({type: 'auto'});
    });

    it('omits tools and tool_choice when none are present', async () => {
      mockFetchJson(textMessage('ok'));
      await collect(makeLlm().generateContentAsync(makeRequest(), false));
      const body = requestBody();
      expect(body).not.toHaveProperty('tools');
      expect(body).not.toHaveProperty('tool_choice');
    });

    it('includes thinking when configured and omits it otherwise', async () => {
      mockFetchJson(textMessage('ok'));
      await collect(
        makeLlm().generateContentAsync(
          makeRequest({config: {thinkingConfig: {thinkingBudget: 8000}}}),
          false,
        ),
      );
      expect(requestBody().thinking).toEqual({
        type: 'enabled',
        budget_tokens: 8000,
      });

      vi.restoreAllMocks();
      mockFetchJson(textMessage('ok'));
      await collect(makeLlm().generateContentAsync(makeRequest(), false));
      expect(requestBody()).not.toHaveProperty('thinking');
    });

    it('sets output_config.effort from AnthropicGenerateContentConfig', async () => {
      mockFetchJson(textMessage('ok'));
      await collect(
        makeLlm().generateContentAsync(
          makeRequest({config: {effort: 'xhigh'}}),
          false,
        ),
      );
      const body = requestBody();
      expect(body.output_config).toEqual({effort: 'xhigh'});
      expect(body).not.toHaveProperty('thinking');
    });

    it('excludes sampling and warns when thinking is enabled', async () => {
      const warn = vi.spyOn(logger, 'warn');
      mockFetchJson(textMessage('ok'));
      await collect(
        makeLlm().generateContentAsync(
          makeRequest({
            config: {
              temperature: 0.7,
              topP: 0.9,
              topK: 50,
              thinkingConfig: {thinkingBudget: 1024},
            },
          }),
          false,
        ),
      );
      const body = requestBody();
      expect(body).not.toHaveProperty('temperature');
      expect(body).not.toHaveProperty('top_p');
      expect(body).not.toHaveProperty('top_k');
      expect(body.thinking).toEqual({type: 'enabled', budget_tokens: 1024});
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('Sampling parameters'),
      );
    });

    it('excludes sampling and warns when effort is set', async () => {
      const warn = vi.spyOn(logger, 'warn');
      mockFetchJson(textMessage('ok'));
      await collect(
        makeLlm().generateContentAsync(
          makeRequest({
            config: {temperature: 0.7, topP: 0.9, topK: 50, effort: 'xhigh'},
          }),
          false,
        ),
      );
      const body = requestBody();
      expect(body).not.toHaveProperty('temperature');
      expect(body.output_config).toEqual({effort: 'xhigh'});
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('Sampling parameters'),
      );
    });

    it('warns and ignores a standard thinkingLevel while keeping adaptive thinking', async () => {
      const warn = vi.spyOn(logger, 'warn');
      mockFetchJson(textMessage('ok'));
      await collect(
        makeLlm().generateContentAsync(
          makeRequest({
            config: {
              thinkingConfig: {
                thinkingBudget: -1,
                thinkingLevel: 'MINIMAL' as never,
              },
            },
          }),
          false,
        ),
      );
      const body = requestBody();
      expect(body.thinking).toEqual({type: 'adaptive'});
      expect(body).not.toHaveProperty('output_config');
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining(
          'Standard thinking_config.thinking_level is not supported',
        ),
      );
    });

    it('tolerates a request with no contents or toolsDict', async () => {
      mockFetchJson(textMessage('ok'));
      await collect(
        makeLlm().generateContentAsync(
          makeRequest({contents: undefined, toolsDict: undefined}),
          false,
        ),
      );
      const body = requestBody();
      expect(body.messages).toEqual([]);
      expect(body).not.toHaveProperty('tool_choice');
    });

    it('passes an abort signal through to fetch', async () => {
      mockFetchJson(textMessage('ok'));
      const controller = new AbortController();
      await collect(
        makeLlm().generateContentAsync(makeRequest(), false, controller.signal),
      );
      expect(vi.mocked(globalThis.fetch).mock.calls[0][1]!.signal).toBe(
        controller.signal,
      );
    });

    it('throws on a non-2xx response including status and body', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        text: async () => 'bad request',
      });
      await expect(
        collect(makeLlm().generateContentAsync(makeRequest(), false)),
      ).rejects.toThrow(
        'Anthropic API request failed with status 400: bad request',
      );
    });

    it('tolerates a body read failure on error responses', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => {
          throw new Error('boom');
        },
      });
      await expect(
        collect(makeLlm().generateContentAsync(makeRequest(), false)),
      ).rejects.toThrow('Anthropic API request failed with status 500: ');
    });
  });

  describe('generateContentAsync: tool id pairing', () => {
    const cases: Array<
      [string, Array<string | null>, Array<string | null>, number]
    > = [
      [
        'distinct invalid ids stay distinct',
        ['bad A!', 'bad B!'],
        ['bad A!', 'bad B!'],
        2,
      ],
      ['matching empty ids collapse', [''], [''], 1],
      ['null and empty collapse', [null], [''], 1],
      ['repeated invalid id stays consistent', ['bad!'], ['bad!'], 1],
    ];

    it.each(cases)(
      '%s',
      async (_name, callIds, responseIds, expectedUnique) => {
        mockFetchJson(textMessage('ok'));
        const contents: Content[] = [
          {role: 'user', parts: [{text: 'Hi'}]},
          {
            role: 'model',
            parts: callIds.map((id, i) => ({
              functionCall: {
                id: id as string | undefined,
                name: `tool_${i}`,
                args: {},
              },
            })),
          },
          {
            role: 'user',
            parts: responseIds.map((id, i) => ({
              functionResponse: {
                id: id as string | undefined,
                name: `tool_${i}`,
                response: {result: 'ok'},
              },
            })),
          },
        ];
        await collect(
          makeLlm().generateContentAsync(makeRequest({contents}), false),
        );
        const messages = requestBody().messages as Array<{
          content: Array<{type: string; id?: string; tool_use_id?: string}>;
        }>;
        const useIds = messages[1].content
          .filter((b) => b.type === 'tool_use')
          .map((b) => b.id!);
        const resultIds = messages[2].content
          .filter((b) => b.type === 'tool_result')
          .map((b) => b.tool_use_id!);
        expect(new Set(useIds).size).toBe(expectedUnique);
        expect(new Set(useIds)).toEqual(new Set(resultIds));
      },
    );
  });

  describe('generateContentAsync: streaming', () => {
    it('yields text partials then a final aggregate', async () => {
      mockFetchStream([
        {
          type: 'message_start',
          message: {usage: {input_tokens: 10, output_tokens: 0}},
        },
        {
          type: 'content_block_start',
          index: 0,
          content_block: {type: 'text', text: ''},
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: {type: 'text_delta', text: 'Hello '},
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: {type: 'text_delta', text: 'world!'},
        },
        {type: 'content_block_stop', index: 0},
        {
          type: 'message_delta',
          delta: {stop_reason: 'end_turn'},
          usage: {output_tokens: 5},
        },
        {type: 'message_stop'},
      ]);

      const responses = await collect(
        makeLlm().generateContentAsync(
          makeRequest({config: {systemInstruction: 'You are helpful'}}),
          true,
        ),
      );

      expect(responses).toHaveLength(3);
      expect(responses[0].partial).toBe(true);
      expect(responses[0].content!.parts![0].text).toBe('Hello ');
      expect(responses[1].content!.parts![0].text).toBe('world!');
      const final = responses[2];
      expect(final.partial).toBe(false);
      expect(final.content!.parts![0].text).toBe('Hello world!');
      expect(final.usageMetadata!.promptTokenCount).toBe(10);
      expect(final.usageMetadata!.candidatesTokenCount).toBe(5);
      expect(final.finishReason).toBe(FinishReason.STOP);
      expect(requestBody().stream).toBe(true);
    });

    it('accumulates tool_use args across input_json_delta', async () => {
      mockFetchStream([
        {
          type: 'message_start',
          message: {usage: {input_tokens: 20, output_tokens: 0}},
        },
        {
          type: 'content_block_start',
          index: 0,
          content_block: {type: 'text', text: ''},
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: {type: 'text_delta', text: 'Checking.'},
        },
        {type: 'content_block_stop', index: 0},
        {
          type: 'content_block_start',
          index: 1,
          content_block: {
            type: 'tool_use',
            id: 'toolu_abc',
            name: 'get_weather',
            input: {},
          },
        },
        {
          type: 'content_block_delta',
          index: 1,
          delta: {type: 'input_json_delta', partial_json: '{"city": '},
        },
        {
          type: 'content_block_delta',
          index: 1,
          delta: {type: 'input_json_delta', partial_json: '"Paris"}'},
        },
        {type: 'content_block_stop', index: 1},
        {
          type: 'message_delta',
          delta: {stop_reason: 'tool_use'},
          usage: {output_tokens: 12},
        },
        {type: 'message_stop'},
      ]);

      const responses = await collect(
        makeLlm().generateContentAsync(makeRequest(), true),
      );
      const final = responses[responses.length - 1];
      expect(final.partial).toBe(false);
      const parts = final.content!.parts!;
      expect(parts).toHaveLength(2);
      expect(parts[0].text).toBe('Checking.');
      expect(parts[1].functionCall).toEqual({
        id: 'toolu_abc',
        name: 'get_weather',
        args: {city: 'Paris'},
      });
    });

    it('defaults tool_use args to {} when no json delta arrives', async () => {
      mockFetchStream([
        {
          type: 'message_start',
          message: {usage: {input_tokens: 1, output_tokens: 0}},
        },
        {
          type: 'content_block_start',
          index: 0,
          content_block: {
            type: 'tool_use',
            id: 'toolu_x',
            name: 'noop',
            input: {},
          },
        },
        {type: 'content_block_stop', index: 0},
        {
          type: 'message_delta',
          delta: {stop_reason: 'tool_use'},
          usage: {output_tokens: 1},
        },
        {type: 'message_stop'},
      ]);
      const responses = await collect(
        makeLlm().generateContentAsync(makeRequest(), true),
      );
      expect(
        responses[responses.length - 1].content!.parts![0].functionCall,
      ).toEqual({id: 'toolu_x', name: 'noop', args: {}});
    });

    it('emits thinking partials and captures the signature delta', async () => {
      mockFetchStream([
        {
          type: 'message_start',
          message: {usage: {input_tokens: 15, output_tokens: 0}},
        },
        {
          type: 'content_block_start',
          index: 0,
          content_block: {type: 'thinking', thinking: '', signature: ''},
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: {type: 'thinking_delta', thinking: 'Step 1: '},
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: {type: 'thinking_delta', thinking: 'analyze.'},
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: {type: 'signature_delta', signature: 'sig_stream_123'},
        },
        {type: 'content_block_stop', index: 0},
        {
          type: 'content_block_start',
          index: 1,
          content_block: {type: 'text', text: ''},
        },
        {
          type: 'content_block_delta',
          index: 1,
          delta: {type: 'text_delta', text: 'The answer is 42.'},
        },
        {type: 'content_block_stop', index: 1},
        {
          type: 'message_delta',
          delta: {stop_reason: 'end_turn'},
          usage: {output_tokens: 10},
        },
        {type: 'message_stop'},
      ]);

      const responses = await collect(
        makeLlm().generateContentAsync(
          makeRequest({config: {thinkingConfig: {thinkingBudget: 5000}}}),
          true,
        ),
      );

      expect(responses).toHaveLength(4);
      expect(responses[0].content!.parts![0]).toEqual({
        text: 'Step 1: ',
        thought: true,
      });
      expect(responses[1].content!.parts![0].text).toBe('analyze.');
      expect(responses[2].content!.parts![0].text).toBe('The answer is 42.');

      const final = responses[3];
      expect(final.partial).toBe(false);
      const parts = final.content!.parts!;
      expect(parts).toHaveLength(2);
      expect(parts[0]).toEqual({
        text: 'Step 1: analyze.',
        thought: true,
        thoughtSignature: 'sig_stream_123',
      });
      expect(parts[1].text).toBe('The answer is 42.');
      // The aggregated thinking part round-trips back to a thinking block.
      expect(partToMessageBlock(parts[0])).toEqual({
        type: 'thinking',
        thinking: 'Step 1: analyze.',
        signature: 'sig_stream_123',
      });
    });

    it('preserves a redacted thinking block in the final aggregate', async () => {
      mockFetchStream([
        {
          type: 'message_start',
          message: {usage: {input_tokens: 8, output_tokens: 0}},
        },
        {
          type: 'content_block_start',
          index: 0,
          content_block: {type: 'redacted_thinking', data: 'encrypted_blob'},
        },
        {type: 'content_block_stop', index: 0},
        {
          type: 'content_block_start',
          index: 1,
          content_block: {type: 'text', text: ''},
        },
        {
          type: 'content_block_delta',
          index: 1,
          delta: {type: 'text_delta', text: 'Done.'},
        },
        {type: 'content_block_stop', index: 1},
        {
          type: 'message_delta',
          delta: {stop_reason: 'end_turn'},
          usage: {output_tokens: 4},
        },
        {type: 'message_stop'},
      ]);

      const responses = await collect(
        makeLlm().generateContentAsync(makeRequest(), true),
      );
      const parts = responses[responses.length - 1].content!.parts!;
      expect(parts[0]).toEqual({
        thought: true,
        thoughtSignature: 'encrypted_blob',
      });
      expect(parts[1].text).toBe('Done.');
    });

    it('reports cached tokens from message_start', async () => {
      mockFetchStream([
        {
          type: 'message_start',
          message: {
            usage: {
              input_tokens: 100,
              output_tokens: 0,
              cache_read_input_tokens: 40,
            },
          },
        },
        {
          type: 'content_block_start',
          index: 0,
          content_block: {type: 'text', text: ''},
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: {type: 'text_delta', text: 'hi'},
        },
        {type: 'content_block_stop', index: 0},
        {
          type: 'message_delta',
          delta: {stop_reason: 'end_turn'},
          usage: {output_tokens: 1},
        },
        {type: 'message_stop'},
      ]);
      const responses = await collect(
        makeLlm().generateContentAsync(makeRequest(), true),
      );
      expect(
        responses[responses.length - 1].usageMetadata!.cachedContentTokenCount,
      ).toBe(40);
    });

    it('omits system on the streaming path when absent', async () => {
      mockFetchStream([
        {
          type: 'message_start',
          message: {usage: {input_tokens: 1, output_tokens: 0}},
        },
        {
          type: 'content_block_start',
          index: 0,
          content_block: {type: 'text', text: ''},
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: {type: 'text_delta', text: 'ok'},
        },
        {type: 'content_block_stop', index: 0},
        {
          type: 'message_delta',
          delta: {stop_reason: 'end_turn'},
          usage: {output_tokens: 1},
        },
        {type: 'message_stop'},
      ]);
      await collect(
        makeLlm().generateContentAsync(makeRequest({config: undefined}), true),
      );
      expect(requestBody()).not.toHaveProperty('system');
    });

    it('ignores ping, unknown and stray-index delta events', async () => {
      mockFetchStream([
        {type: 'ping'},
        {
          type: 'message_start',
          message: {usage: {input_tokens: 3, output_tokens: 0}},
        },
        {
          type: 'content_block_delta',
          index: 9,
          delta: {type: 'thinking_delta', thinking: 'stray-think'},
        },
        {
          type: 'content_block_delta',
          index: 8,
          delta: {type: 'signature_delta', signature: 'stray-sig'},
        },
        {
          type: 'content_block_delta',
          index: 7,
          delta: {type: 'input_json_delta', partial_json: '{}'},
        },
        {
          type: 'content_block_delta',
          index: 6,
          delta: {type: 'text_delta', text: 'stray-text'},
        },
        {
          type: 'content_block_start',
          index: 0,
          content_block: {type: 'text', text: ''},
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: {type: 'text_delta', text: 'hi'},
        },
        {type: 'content_block_stop', index: 0},
        {type: 'some_future_event'},
        {
          type: 'message_delta',
          delta: {stop_reason: 'end_turn'},
          usage: {output_tokens: 2},
        },
        {type: 'message_stop'},
      ]);
      const responses = await collect(
        makeLlm().generateContentAsync(makeRequest(), true),
      );
      const final = responses[responses.length - 1];
      // Stray thinking delta (index 9) created a block via the fallback path.
      const strayThinking = final.content!.parts!.find(
        (p: Part) => p.text === 'stray-think',
      );
      expect(strayThinking).toBeDefined();
    });

    it('parses events split across chunk boundaries', async () => {
      const full = sseChunks([
        {
          type: 'message_start',
          message: {usage: {input_tokens: 2, output_tokens: 0}},
        },
        {
          type: 'content_block_start',
          index: 0,
          content_block: {type: 'text', text: ''},
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: {type: 'text_delta', text: 'chunked'},
        },
        {type: 'content_block_stop', index: 0},
        {
          type: 'message_delta',
          delta: {stop_reason: 'end_turn'},
          usage: {output_tokens: 1},
        },
        {type: 'message_stop'},
      ]).join('');
      const mid = Math.floor(full.length / 2);
      const body = makeStreamBody([full.slice(0, mid), full.slice(mid)]);
      globalThis.fetch = vi
        .fn()
        .mockResolvedValue({ok: true, status: 200, body});

      const responses = await collect(
        makeLlm().generateContentAsync(makeRequest(), true),
      );
      expect(responses[responses.length - 1].content!.parts![0].text).toBe(
        'chunked',
      );
    });

    it('flushes a trailing event that lacks a final blank line', async () => {
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1,"output_tokens":0}}}\n\n',
            ),
          );
          controller.enqueue(
            encoder.encode(
              'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":"tail"}}',
            ),
          );
          controller.close();
        },
      });
      globalThis.fetch = vi
        .fn()
        .mockResolvedValue({ok: true, status: 200, body});

      const responses = await collect(
        makeLlm().generateContentAsync(makeRequest(), true),
      );
      expect(responses[responses.length - 1].content!.parts![0].text).toBe(
        'tail',
      );
    });

    it('yields an empty aggregate when the response has no body', async () => {
      globalThis.fetch = vi
        .fn()
        .mockResolvedValue({ok: true, status: 200, body: null});
      const responses = await collect(
        makeLlm().generateContentAsync(makeRequest(), true),
      );
      expect(responses).toHaveLength(1);
      expect(responses[0].partial).toBe(false);
      expect(responses[0].content!.parts).toEqual([]);
    });
  });
});
