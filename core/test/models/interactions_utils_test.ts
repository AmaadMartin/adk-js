/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  buildGenerationConfig,
  buildInteractionsEventLog,
  buildInteractionsRequestLog,
  buildInteractionsResponseLog,
  convertContentsToTurns,
  convertContentToTurn,
  convertInteractionEventToLlmResponse,
  convertInteractionOutputToPart,
  convertInteractionToLlmResponse,
  convertPartToInteractionContent,
  convertToolsConfigToInteractionsFormat,
  extractStreamInteractionId,
  extractSystemInstruction,
  generateContentViaInteractions,
  getLatestUserContents,
  LlmRequest,
} from '@google/adk';
import {GoogleGenAI, Part} from '@google/genai';
import {describe, expect, it, vi} from 'vitest';

describe('interactions_utils', () => {
  describe('extractStreamInteractionId', () => {
    it('should extract interaction_id', () => {
      expect(extractStreamInteractionId({interaction_id: 'i1'})).toBe('i1');
    });
    it('should extract interactionId', () => {
      expect(extractStreamInteractionId({interactionId: 'i2'})).toBe('i2');
    });
    it('should extract interaction.id', () => {
      expect(extractStreamInteractionId({interaction: {id: 'i3'}})).toBe('i3');
    });
    it('should extract from eventType interaction', () => {
      expect(
        extractStreamInteractionId({eventType: 'interaction', id: 'i4'}),
      ).toBe('i4');
      expect(
        extractStreamInteractionId({event_type: 'interaction', id: 'i5'}),
      ).toBe('i5');
    });
    it('should return undefined when missing', () => {
      expect(
        extractStreamInteractionId({eventType: 'unknown'}),
      ).toBeUndefined();
    });
  });

  describe('convertPartToInteractionContent', () => {
    it('should convert text', () => {
      expect(convertPartToInteractionContent({text: 'hello'})).toEqual({
        type: 'text',
        text: 'hello',
      });
    });

    it('should convert functionCall without thoughtSignature', () => {
      expect(
        convertPartToInteractionContent({
          functionCall: {name: 'fn', args: {x: 1}},
        }),
      ).toEqual({
        type: 'function_call',
        id: '',
        name: 'fn',
        arguments: {x: 1},
      });
    });

    it('should convert functionCall with thoughtSignature', () => {
      expect(
        convertPartToInteractionContent({
          functionCall: {id: 'c1', name: 'fn', args: {}},
          // @ts-expect-error test thoughtSignature casting
          thoughtSignature: 'sig',
        }),
      ).toEqual({
        type: 'function_call',
        id: 'c1',
        name: 'fn',
        arguments: {},
        thought_signature: 'sig',
      });

      expect(
        convertPartToInteractionContent({
          functionCall: {id: 'c1', name: 'fn', args: {}},
          // @ts-expect-error test thoughtSignature Buffer casting
          thoughtSignature: Buffer.from('sig'),
        }),
      ).toEqual({
        type: 'function_call',
        id: 'c1',
        name: 'fn',
        arguments: {},
        thought_signature: Buffer.from('sig').toString('base64'),
      });
    });

    it('should convert functionResponse', () => {
      expect(
        convertPartToInteractionContent({
          functionResponse: {id: 'r1', name: 'fn', response: {output: 'ok'}},
        }),
      ).toEqual({
        type: 'function_result',
        call_id: 'r1',
        name: 'fn',
        result: {output: 'ok'},
      });

      expect(
        convertPartToInteractionContent({
          functionResponse: {id: 'r1', name: 'fn', response: 'ok'},
        }),
      ).toEqual({
        type: 'function_result',
        call_id: 'r1',
        name: 'fn',
        result: 'ok',
      });
    });

    it('should convert inlineData', () => {
      expect(
        convertPartToInteractionContent({
          inlineData: {data: 'base64', mimeType: 'image/png'},
        }),
      ).toEqual({type: 'image', data: 'base64', mime_type: 'image/png'});
      expect(
        convertPartToInteractionContent({
          inlineData: {data: 'base64', mimeType: 'audio/mp3'},
        }),
      ).toEqual({type: 'audio', data: 'base64', mime_type: 'audio/mp3'});
      expect(
        convertPartToInteractionContent({
          inlineData: {data: 'base64', mimeType: 'video/mp4'},
        }),
      ).toEqual({type: 'video', data: 'base64', mime_type: 'video/mp4'});
      expect(
        convertPartToInteractionContent({
          inlineData: {data: 'base64', mimeType: 'text/plain'},
        }),
      ).toEqual({type: 'document', data: 'base64', mime_type: 'text/plain'});
    });

    it('should convert fileData', () => {
      expect(
        convertPartToInteractionContent({
          fileData: {fileUri: 'gs://im', mimeType: 'image/png'},
        }),
      ).toEqual({type: 'image', uri: 'gs://im', mime_type: 'image/png'});
      expect(
        convertPartToInteractionContent({
          fileData: {fileUri: 'gs://im', mimeType: 'audio/mp3'},
        }),
      ).toEqual({type: 'audio', uri: 'gs://im', mime_type: 'audio/mp3'});
      expect(
        convertPartToInteractionContent({
          fileData: {fileUri: 'gs://im', mimeType: 'video/mp4'},
        }),
      ).toEqual({type: 'video', uri: 'gs://im', mime_type: 'video/mp4'});
      expect(
        convertPartToInteractionContent({
          fileData: {fileUri: 'gs://im', mimeType: 'text/plain'},
        }),
      ).toEqual({type: 'document', uri: 'gs://im', mime_type: 'text/plain'});
    });

    it('should convert thought', () => {
      expect(
        convertPartToInteractionContent({
          thought: true,
          // @ts-expect-error test thoughtSignature
          thoughtSignature: 'sig',
        }),
      ).toEqual({type: 'thought', signature: 'sig'});

      expect(
        convertPartToInteractionContent({
          thought: true,
          // @ts-expect-error test thoughtSignature buffer
          thoughtSignature: Buffer.from('sig'),
        }),
      ).toEqual({
        type: 'thought',
        signature: Buffer.from('sig').toString('base64'),
      });
    });

    it('should convert codeExecutionResult', () => {
      expect(
        convertPartToInteractionContent({
          codeExecutionResult: {output: 'done', outcome: 'OUTCOME_OK'},
        }),
      ).toEqual({
        type: 'code_execution_result',
        call_id: '',
        result: 'done',
        is_error: false,
      });

      expect(
        convertPartToInteractionContent({
          codeExecutionResult: {output: 'err', outcome: 'OUTCOME_FAILED'},
        }),
      ).toEqual({
        type: 'code_execution_result',
        call_id: '',
        result: 'err',
        is_error: true,
      });
    });

    it('should convert executableCode', () => {
      expect(
        convertPartToInteractionContent({
          executableCode: {code: 'print(1)', language: 'PYTHON'},
        }),
      ).toEqual({
        type: 'code_execution_call',
        id: '',
        arguments: {code: 'print(1)', language: 'PYTHON'},
      });
    });

    it('should return null for empty part', () => {
      expect(convertPartToInteractionContent({})).toBeNull();
    });
  });

  describe('convertContentsToTurns', () => {
    it('should convert contents to turns', () => {
      const res = convertContentsToTurns([
        {role: 'user', parts: [{text: 'x'}]},
        {role: 'model', parts: [{text: 'y'}]},
        {role: 'user', parts: []},
      ]);
      expect(res).toEqual([
        {role: 'user', content: [{type: 'text', text: 'x'}]},
        {role: 'model', content: [{type: 'text', text: 'y'}]},
      ]);
    });

    it('should handle undefined content parts', () => {
      expect(convertContentToTurn({role: 'user'})).toEqual({
        role: 'user',
        content: [],
      });
    });
  });

  describe('convertToolsConfigToInteractionsFormat', () => {
    it('should return empty array for empty tools', () => {
      expect(convertToolsConfigToInteractionsFormat({})).toEqual([]);
    });

    it('should convert tools', () => {
      const res = convertToolsConfigToInteractionsFormat({
        tools: [
          {
            functionDeclarations: [
              {
                name: 'fn',
                description: 'desc',
                parameters: {type: 'object', properties: {}},
              },
            ],
          },
          {googleSearch: {}},
          {codeExecution: {}},
          // @ts-expect-error custom tool test
          {urlContext: {}},
          // @ts-expect-error custom tool test
          {computerUse: {}},
        ],
      });
      expect(res).toEqual([
        {
          type: 'function',
          name: 'fn',
          description: 'desc',
          parameters: {type: 'object', properties: {}},
        },
        {type: 'google_search'},
        {type: 'code_execution'},
        {type: 'url_context'},
        {type: 'computer_use'},
      ]);
    });
  });

  describe('convertInteractionOutputToPart', () => {
    it('should return null for empty output', () => {
      expect(convertInteractionOutputToPart(null)).toBeNull();
      expect(convertInteractionOutputToPart({type: 'thought'})).toBeNull();
    });

    it('should convert text', () => {
      expect(convertInteractionOutputToPart({type: 'text', text: 't'})).toEqual(
        {
          text: 't',
        },
      );
    });

    it('should convert function_call', () => {
      expect(
        convertInteractionOutputToPart({
          type: 'function_call',
          id: '1',
          name: 'fn',
          arguments: {a: 1},
          thought_signature: 'sig',
        }),
      ).toEqual({
        functionCall: {id: '1', name: 'fn', args: {a: 1}},
        thoughtSignature: Buffer.from('sig', 'base64'),
      });

      expect(
        convertInteractionOutputToPart({
          type: 'function_call',
          name: 'fn',
          thought_signature: Buffer.from('sig'),
        }),
      ).toEqual({
        functionCall: {id: '', name: 'fn', args: {}},
        thoughtSignature: Buffer.from('sig'),
      });
    });

    it('should convert function_result', () => {
      expect(
        convertInteractionOutputToPart({
          type: 'function_result',
          call_id: '1',
          name: 'fn',
          result: {items: [1]},
        }),
      ).toEqual({
        functionResponse: {id: '1', name: 'fn', response: [1]},
      });
    });

    it('should convert image and audio', () => {
      expect(
        convertInteractionOutputToPart({
          type: 'image',
          data: 'buf',
          mime_type: 'image/png',
        }),
      ).toEqual({inlineData: {data: 'buf', mimeType: 'image/png'}});
      expect(
        convertInteractionOutputToPart({
          type: 'image',
          uri: 'gs://i',
          mime_type: 'image/png',
        }),
      ).toEqual({fileData: {fileUri: 'gs://i', mimeType: 'image/png'}});
      expect(
        convertInteractionOutputToPart({
          type: 'audio',
          data: 'buf',
          mime_type: 'audio/mp3',
        }),
      ).toEqual({inlineData: {data: 'buf', mimeType: 'audio/mp3'}});
      expect(
        convertInteractionOutputToPart({
          type: 'audio',
          uri: 'gs://i',
          mime_type: 'audio/mp3',
        }),
      ).toEqual({fileData: {fileUri: 'gs://i', mimeType: 'audio/mp3'}});
    });

    it('should convert code execution output', () => {
      expect(
        convertInteractionOutputToPart({
          type: 'code_execution_result',
          result: 'done',
          is_error: true,
        }),
      ).toEqual({
        codeExecutionResult: {output: 'done', outcome: 'outcomeFailed'},
      });
      expect(
        convertInteractionOutputToPart({
          type: 'code_execution_call',
          arguments: {code: 'p()', language: 'PYTHON'},
        }),
      ).toEqual({
        executableCode: {code: 'p()', language: 'PYTHON'},
      });
    });

    it('should convert google_search_result', () => {
      expect(
        convertInteractionOutputToPart({
          type: 'google_search_result',
          result: ['abc', 'def'],
        }),
      ).toEqual({text: 'abc\ndef'});
      expect(
        convertInteractionOutputToPart({type: 'google_search_result'}),
      ).toBeNull();
    });
  });

  describe('convertInteractionToLlmResponse', () => {
    it('should handle failed interaction', () => {
      expect(convertInteractionToLlmResponse({status: 'failed'})).toEqual({
        errorCode: 'UNKNOWN_ERROR',
        errorMessage: 'Unknown error',
        interactionId: undefined,
      });
      expect(
        convertInteractionToLlmResponse({
          status: 'failed',
          error: {code: 'ERR', message: 'M'},
          id: 'i1',
        }),
      ).toEqual({errorCode: 'ERR', errorMessage: 'M', interactionId: 'i1'});
    });

    it('should convert valid interaction', () => {
      expect(
        convertInteractionToLlmResponse({
          status: 'completed',
          id: 'i1',
          outputs: [{type: 'text', text: 'hi'}, {type: 'thought'}],
          usage: {total_input_tokens: 10, total_output_tokens: 20},
        }),
      ).toEqual({
        content: {role: 'model', parts: [{text: 'hi'}]},
        finishReason: 'STOP',
        interactionId: 'i1',
        turnComplete: true,
        usageMetadata: {
          promptTokenCount: 10,
          candidatesTokenCount: 20,
          totalTokenCount: 30,
        },
      });
    });
  });

  describe('convertInteractionEventToLlmResponse', () => {
    it('should handle delta text', () => {
      const parts: Part[] = [];
      expect(
        convertInteractionEventToLlmResponse(
          {eventType: 'content.delta', delta: {type: 'text', text: 'hi'}},
          parts,
          'i1',
        ),
      ).toEqual({
        content: {role: 'model', parts: [{text: 'hi'}]},
        interactionId: 'i1',
        partial: true,
        turnComplete: false,
      });
      expect(parts).toHaveLength(1);
    });

    it('should handle delta function_call with and without thoughtSignature', () => {
      const parts: Part[] = [];
      expect(
        convertInteractionEventToLlmResponse(
          {
            eventType: 'content.delta',
            delta: {
              type: 'function_call',
              name: 'fn',
              thought_signature: 'sig',
            },
          },
          parts,
          'i1',
        ),
      ).toBeNull();
      expect(parts).toHaveLength(1);

      expect(
        convertInteractionEventToLlmResponse(
          {
            eventType: 'content.delta',
            delta: {
              type: 'function_call',
              name: 'fn2',
              thought_signature: Buffer.from('sig2'),
            },
          },
          parts,
          'i1',
        ),
      ).toBeNull();
      expect(parts).toHaveLength(2);
    });

    it('should handle delta image', () => {
      const parts: Part[] = [];
      expect(
        convertInteractionEventToLlmResponse(
          {eventType: 'content.delta', delta: {type: 'image', data: 'buf'}},
          parts,
          'i1',
        ),
      ).toEqual({
        content: {
          role: 'model',
          parts: [{inlineData: {data: 'buf', mimeType: undefined}}],
        },
        interactionId: 'i1',
        partial: false,
        turnComplete: false,
      });
      expect(
        convertInteractionEventToLlmResponse(
          {eventType: 'content.delta', delta: {type: 'image', uri: 'gs'}},
          parts,
          'i1',
        ),
      ).toEqual({
        content: {
          role: 'model',
          parts: [{fileData: {fileUri: 'gs', mimeType: undefined}}],
        },
        interactionId: 'i1',
        partial: false,
        turnComplete: false,
      });
    });

    it('should handle status update and error', () => {
      const parts: Part[] = [{text: 'all'}];
      expect(
        convertInteractionEventToLlmResponse(
          {eventType: 'content.stop'},
          parts,
          'i1',
        ),
      ).toEqual({
        content: {role: 'model', parts: [{text: 'all'}]},
        interactionId: 'i1',
        partial: false,
        turnComplete: false,
      });

      expect(
        convertInteractionEventToLlmResponse(
          {eventType: 'interaction.status_update', status: 'completed'},
          parts,
          'i1',
        ),
      ).toEqual({
        content: {role: 'model', parts: [{text: 'all'}]},
        interactionId: 'i1',
        partial: false,
        turnComplete: true,
        finishReason: 'STOP',
      });

      expect(
        convertInteractionEventToLlmResponse(
          {eventType: 'interaction.status_update', status: 'failed'},
          parts,
          'i1',
        ),
      ).toEqual({
        errorCode: 'UNKNOWN_ERROR',
        errorMessage: 'Unknown error',
        interactionId: 'i1',
        turnComplete: true,
      });

      expect(
        convertInteractionEventToLlmResponse(
          {eventType: 'error', code: 'E1', message: 'M1'},
          parts,
          'i1',
        ),
      ).toEqual({
        errorCode: 'E1',
        errorMessage: 'M1',
        interactionId: 'i1',
        turnComplete: true,
      });
    });
  });

  describe('getLatestUserContents', () => {
    it('should trim empty contents', () => {
      expect(getLatestUserContents([])).toEqual([]);
    });

    it('should return continuous user messages', () => {
      expect(
        getLatestUserContents([
          {role: 'user', parts: [{text: '1'}]},
          {role: 'model', parts: [{text: '2'}]},
          {role: 'user', parts: [{text: '3'}]},
          {role: 'user', parts: [{text: '4'}]},
        ]),
      ).toEqual([
        {role: 'user', parts: [{text: '3'}]},
        {role: 'user', parts: [{text: '4'}]},
      ]);
    });

    it('should include preceding model turn when user sends functionResponse', () => {
      expect(
        getLatestUserContents([
          {role: 'user', parts: [{text: '1'}]},
          {
            role: 'model',
            parts: [{functionCall: {name: 'fn', args: {}}}],
          },
          {
            role: 'user',
            parts: [{functionResponse: {name: 'fn', response: {}}}],
          },
        ]),
      ).toEqual([
        {
          role: 'model',
          parts: [{functionCall: {name: 'fn', args: {}}}],
        },
        {
          role: 'user',
          parts: [{functionResponse: {name: 'fn', response: {}}}],
        },
      ]);
    });
  });

  describe('extractSystemInstruction and buildGenerationConfig', () => {
    it('should extract instructions', () => {
      expect(extractSystemInstruction({systemInstruction: 'sys'})).toBe('sys');
      expect(
        extractSystemInstruction({
          // @ts-expect-error content casting
          systemInstruction: {parts: [{text: 'sys2'}]},
        }),
      ).toBe('sys2');
    });

    it('should build generation config', () => {
      expect(
        buildGenerationConfig({temperature: 0.5, stopSequences: ['a']}),
      ).toEqual({temperature: 0.5, stopSequences: ['a']});
    });

    it('should format logs', () => {
      expect(
        buildInteractionsRequestLog({
          model: 'gemini',
          stream: true,
          previousInteractionId: 'i1',
        }),
      ).toContain('Interactions API Request');
      expect(
        buildInteractionsResponseLog({id: 'i1', status: 'completed'}),
      ).toContain('Interactions API Response');
      expect(buildInteractionsEventLog({eventType: 'content.delta'})).toContain(
        'Interactions SSE Event',
      );
    });
  });

  describe('generateContentViaInteractions', () => {
    it('should generate content without streaming and with config/tools', async () => {
      const mockInteractionsCreate = vi.fn().mockResolvedValue({
        status: 'completed',
        id: 'i1',
        outputs: [{type: 'text', text: 'reply'}],
      });

      const client = {
        interactions: {create: mockInteractionsCreate},
      } as unknown as GoogleGenAI;

      const req: LlmRequest = {
        model: 'gemini',
        contents: [{role: 'user', parts: [{text: 'h'}]}],
        previousInteractionId: 'i0',
        config: {
          temperature: 0.7,
          tools: [{googleSearch: {}}],
        },
        liveConnectConfig: {},
        toolsDict: {},
      };

      const gen = generateContentViaInteractions(client, req, false);
      const resp = await gen.next();
      expect(resp.value).toEqual({
        content: {role: 'model', parts: [{text: 'reply'}]},
        finishReason: 'STOP',
        interactionId: 'i1',
        turnComplete: true,
        usageMetadata: undefined,
      });
      expect(mockInteractionsCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          tools: [{type: 'google_search'}],
          generationConfig: {temperature: 0.7},
          previousInteractionId: 'i0',
        }),
      );
    });

    it('should generate content with streaming and with config/tools', async () => {
      const mockStream = async function* () {
        yield {eventType: 'content.delta', delta: {type: 'text', text: 'hi'}};
        yield {eventType: 'interaction', id: 'i1', status: 'completed'};
      };
      const mockInteractionsCreate = vi.fn().mockReturnValue(mockStream());

      const client = {
        interactions: {create: mockInteractionsCreate},
      } as unknown as GoogleGenAI;

      const req: LlmRequest = {
        model: 'gemini',
        contents: [{role: 'user', parts: [{text: 'h'}]}],
        previousInteractionId: 'i0',
        config: {
          temperature: 0.5,
          tools: [{googleSearch: {}}],
        },
        liveConnectConfig: {},
        toolsDict: {},
      };

      const gen = generateContentViaInteractions(client, req, true);
      const res1 = await gen.next();
      expect(res1.value).toEqual({
        content: {role: 'model', parts: [{text: 'hi'}]},
        interactionId: undefined,
        partial: true,
        turnComplete: false,
      });

      const res2 = await gen.next();
      expect(res2.value).toEqual({
        content: undefined,
        finishReason: 'STOP',
        interactionId: 'i1',
        turnComplete: true,
        usageMetadata: undefined,
      });

      const res3 = await gen.next();
      expect(res3.value).toEqual({
        content: {role: 'model', parts: [{text: 'hi'}]},
        partial: false,
        turnComplete: true,
        finishReason: 'STOP',
        interactionId: 'i1',
      });

      const res4 = await gen.next();
      expect(res4.done).toBe(true);

      expect(mockInteractionsCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          tools: [{type: 'google_search'}],
          generationConfig: {temperature: 0.5},
          previousInteractionId: 'i0',
        }),
      );
    });

    it('should throw error if interactions API is missing', async () => {
      const client = {} as unknown as GoogleGenAI;
      const req: LlmRequest = {
        model: 'gemini',
        contents: [],
        liveConnectConfig: {},
        toolsDict: {},
      };
      const gen = generateContentViaInteractions(client, req, false);
      await expect(gen.next()).rejects.toThrow(/Interactions API/);
    });
  });
});
