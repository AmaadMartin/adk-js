/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tests for the OpenAI Responses models that adk-python's suite does not
 * cover. Kept apart from `openai_responses_llm_test.ts` so the ported suite
 * stays comparable to the reference file, test for test.
 */

import {
  FinishReason,
  FunctionCallingConfigMode,
  Schema,
  Type,
} from '@google/genai';
import type OpenAI from 'openai';
import {describe, expect, it, vi} from 'vitest';
import {z} from 'zod';

import {
  AzureOpenAiResponsesLlm,
  OpenAiResponsesLlm,
} from '../../../src/labs/openai/openai_responses_llm.js';
import {
  contentToResponseInputItems,
  functionDeclarationToResponseTool,
  responseTextConfig,
  schemaToJsonObject,
  serializeSystemInstruction,
  serializeToolOutput,
  toolChoice,
} from '../../../src/labs/openai/openai_responses_request.js';
import {
  functionCallPart,
  mapFinishReason,
  responseToLlmResponse,
  toUsageMetadata,
} from '../../../src/labs/openai/openai_responses_response.js';
import {StreamAccumulator} from '../../../src/labs/openai/openai_responses_stream.js';
import {
  enforceStrictOpenAiSchema,
  isJsonObject,
  lowercaseSchemaTypes,
} from '../../../src/labs/openai/openai_schema.js';
import {logger} from '../../../src/utils/logger.js';

import {
  completedEvent,
  contentPartDoneEvent,
  createdEvent,
  drain,
  FakeResponsesClient,
  functionArgsDeltaEvent,
  functionArgsDoneEvent,
  functionCallItem,
  makeResponse,
  makeUsage,
  messageItem,
  outputItemAddedEvent,
  outputItemDoneEvent,
  outputText,
  reasoningItem,
  reasoningSummaryDeltaEvent,
  reasoningSummaryPartDoneEvent,
  reasoningTextDeltaEvent,
  reasoningTextDoneEvent,
  refusal,
  textDeltaEvent,
  textDoneEvent,
  userRequest,
} from './openai_responses_fixtures.js';

const {constructorSpy} = vi.hoisted(() => ({constructorSpy: vi.fn()}));

vi.mock('openai', () => {
  class FakeOpenAI {
    readonly responses = {
      create: () => Promise.resolve(makeMockedResponse()),
    };
    constructor(options: unknown) {
      constructorSpy(options);
    }
  }
  function makeMockedResponse() {
    return {
      id: 'resp_mock',
      created_at: 1,
      output_text: '',
      error: null,
      incomplete_details: null,
      instructions: null,
      metadata: null,
      model: 'gpt-5',
      object: 'response',
      output: [],
      parallel_tool_calls: true,
      temperature: null,
      tool_choice: 'auto',
      tools: [],
      top_p: null,
      status: 'completed',
    };
  }
  return {default: FakeOpenAI};
});

/** Feeds events to an accumulator and returns everything it produced. */
function accumulate(
  events: OpenAI.Responses.ResponseStreamEvent[],
  includeResponseMetadata = true,
): StreamAccumulator {
  const accumulator = new StreamAccumulator(includeResponseMetadata);
  for (const event of events) {
    accumulator.processEvent(event);
  }
  return accumulator;
}

describe('openai_schema', () => {
  it('lowercases a type given as a list, leaving non-strings alone', () => {
    const schema = {type: ['STRING', 'NULL', 7]};

    lowercaseSchemaTypes(schema);

    expect(schema.type).toEqual(['string', 'null', 7]);
  });

  it('recurses through every schema keyword that holds a subschema', () => {
    const schema = {
      $defs: {Item: {type: 'OBJECT'}},
      properties: {a: {type: 'STRING'}},
      items: {type: 'INTEGER'},
      additionalProperties: {type: 'BOOLEAN'},
      anyOf: [{type: 'NUMBER'}],
      prefixItems: [{type: 'ARRAY'}],
    };

    lowercaseSchemaTypes(schema);

    expect(schema).toEqual({
      $defs: {Item: {type: 'object'}},
      properties: {a: {type: 'string'}},
      items: {type: 'integer'},
      additionalProperties: {type: 'boolean'},
      anyOf: [{type: 'number'}],
      prefixItems: [{type: 'array'}],
    });
  });

  it('lowercases each element of a list of schemas', () => {
    const schemas = [{type: 'STRING'}, 'not a schema'];

    lowercaseSchemaTypes(schemas);

    expect(schemas[0]).toEqual({type: 'string'});
  });

  it('leaves a value that is not a schema untouched', () => {
    expect(() => {
      lowercaseSchemaTypes('plain');
    }).not.toThrow();
    expect(isJsonObject([])).toBe(false);
    expect(isJsonObject(null)).toBe(false);
  });

  it('strips every sibling of a $ref', () => {
    const schema = {$ref: '#/$defs/Item', description: 'gone', type: 'object'};

    enforceStrictOpenAiSchema(schema);

    expect(schema).toEqual({$ref: '#/$defs/Item'});
  });

  it('recurses into oneOf, allOf and items', () => {
    const objectSchema = () => ({
      type: 'object',
      properties: {a: {type: 'string'}},
    });
    const schema = {
      oneOf: [objectSchema()],
      allOf: [objectSchema()],
      items: objectSchema(),
    };

    enforceStrictOpenAiSchema(schema);

    expect(schema.oneOf[0]).toMatchObject({additionalProperties: false});
    expect(schema.allOf[0]).toMatchObject({additionalProperties: false});
    expect(schema.items).toMatchObject({additionalProperties: false});
  });

  it('ignores a value that is not a schema object', () => {
    expect(() => {
      enforceStrictOpenAiSchema('plain');
    }).not.toThrow();
  });
});

describe('serializeSystemInstruction', () => {
  it('returns undefined when there is no instruction', () => {
    expect(serializeSystemInstruction(undefined)).toBeUndefined();
    expect(serializeSystemInstruction('')).toBeUndefined();
  });

  it('reads a bare Part', () => {
    expect(serializeSystemInstruction({text: 'Be brief.'})).toBe('Be brief.');
    expect(serializeSystemInstruction({})).toBe('');
  });

  it('joins the parts of a Content without a separator', () => {
    expect(
      serializeSystemInstruction({
        role: 'system',
        parts: [{text: 'Be '}, {text: 'brief.'}],
      }),
    ).toBe('Be brief.');
    expect(serializeSystemInstruction({role: 'system'})).toBe('');
  });

  it('joins a list of strings and Parts without a separator', () => {
    expect(serializeSystemInstruction(['Be ', {text: 'brief.'}])).toBe(
      'Be brief.',
    );
  });
});

describe('schemaToJsonObject', () => {
  it('renders a Zod type as JSON Schema', () => {
    const jsonSchema = schemaToJsonObject(z.object({answer: z.string()}));

    expect(jsonSchema).toMatchObject({
      type: 'object',
      properties: {answer: {type: 'string'}},
    });
  });

  it('returns an empty schema for a value that is not an object', () => {
    expect(schemaToJsonObject(7)).toEqual({});
  });

  it('returns an empty schema for an object that serializes to a scalar', () => {
    expect(schemaToJsonObject(new Date(0))).toEqual({});
  });
});

describe('responseTextConfig', () => {
  it('returns undefined when the schema carries no fields', () => {
    expect(responseTextConfig({responseSchema: {}})).toBeUndefined();
  });

  it('asks for a JSON object when only the mime type says so', () => {
    expect(responseTextConfig({responseMimeType: 'application/json'})).toEqual({
      format: {type: 'json_object'},
    });
  });

  it('returns undefined when the request asks for no format', () => {
    expect(responseTextConfig({})).toBeUndefined();
  });

  it('falls back to a default name when the title is unusable', () => {
    const withoutTitle = responseTextConfig({
      responseJsonSchema: {type: 'object', properties: {x: {type: 'string'}}},
    });
    const withNumericTitle = responseTextConfig({
      responseJsonSchema: {title: 7, type: 'string'},
    });
    const withPunctuationTitle = responseTextConfig({
      responseJsonSchema: {title: '!!', type: 'string'},
    });

    expect(withoutTitle?.format).toMatchObject({name: 'schema'});
    expect(withNumericTitle?.format).toMatchObject({name: 'schema'});
    expect(withPunctuationTitle?.format).toMatchObject({name: '__'});
  });

  it('falls back to a default name for an empty title', () => {
    const text = responseTextConfig({
      responseJsonSchema: {title: '', type: 'string'},
    });

    expect(text?.format).toMatchObject({name: 'schema'});
  });
});

describe('functionDeclarationToResponseTool', () => {
  it('rejects a declaration without a name', () => {
    expect(() => functionDeclarationToResponseTool({description: 'x'})).toThrow(
      'FunctionDeclaration must have a name.',
    );
  });

  it('sends an empty object schema when the tool takes no parameters', () => {
    expect(functionDeclarationToResponseTool({name: 'ping'})).toEqual({
      type: 'function',
      name: 'ping',
      description: '',
      parameters: {type: 'object', properties: {}},
      strict: false,
    });
  });
});

describe('serializeToolOutput', () => {
  it('returns an empty string when there is no response', () => {
    expect(serializeToolOutput(undefined)).toBe('');
  });

  it('passes through string content', () => {
    expect(serializeToolOutput({content: 'plain'})).toBe('plain');
  });

  it('renders a non-text content block as JSON', () => {
    expect(
      serializeToolOutput({content: [{type: 'image', data: 'x'}, 'raw']}),
    ).toBe('{"type":"image","data":"x"}\nraw');
  });

  it('prefers a string result over the whole response', () => {
    expect(serializeToolOutput({result: 'done'})).toBe('done');
    expect(serializeToolOutput({result: {ok: true}})).toBe('{"ok":true}');
  });

  it('falls back to the whole response as JSON', () => {
    expect(serializeToolOutput({content: [], temperature: '70 F'})).toBe(
      '{"content":[],"temperature":"70 F"}',
    );
  });
});

describe('contentToResponseInputItems', () => {
  it('keeps the system and developer roles', () => {
    expect(
      contentToResponseInputItems({role: 'system', parts: [{text: 'a'}]}),
    ).toEqual([
      {
        type: 'message',
        role: 'system',
        content: [{type: 'input_text', text: 'a'}],
      },
    ]);
    expect(
      contentToResponseInputItems({role: 'developer', parts: [{text: 'a'}]}),
    ).toEqual([
      {
        type: 'message',
        role: 'developer',
        content: [{type: 'input_text', text: 'a'}],
      },
    ]);
  });

  it('treats an unknown role as a user turn', () => {
    expect(
      contentToResponseInputItems({role: 'tool', parts: [{text: 'a'}]}),
    ).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [{type: 'input_text', text: 'a'}],
      },
    ]);
  });

  it('falls back to a generic file when inline data names nothing', () => {
    expect(
      contentToResponseInputItems({role: 'user', parts: [{inlineData: {}}]}),
    ).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [
          {
            type: 'input_file',
            filename: 'inline_data',
            file_data: 'data:application/octet-stream;base64,',
          },
        ],
      },
    ]);
  });

  it('sends file data with no mime type as a file URL', () => {
    expect(
      contentToResponseInputItems({role: 'user', parts: [{fileData: {}}]}),
    ).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [{type: 'input_file', file_url: ''}],
      },
    ]);
  });

  it('drops assistant file data with a warning', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    const items = contentToResponseInputItems({
      role: 'model',
      parts: [{fileData: {fileUri: 'file-abc'}}],
    });

    expect(items).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      'Media data is not supported in Responses assistant turns.',
    );
    warn.mockRestore();
  });

  it('starts a new message after a skipped thought', () => {
    const items = contentToResponseInputItems({
      role: 'user',
      parts: [{text: 'a'}, {text: 'why', thought: true}, {text: 'b'}],
    });

    expect(items).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [{type: 'input_text', text: 'a'}],
      },
      {
        type: 'message',
        role: 'user',
        content: [{type: 'input_text', text: 'b'}],
      },
    ]);
  });

  it('emits nothing for a part that carries no content', () => {
    expect(contentToResponseInputItems({role: 'user', parts: [{}]})).toEqual(
      [],
    );
    expect(contentToResponseInputItems({role: 'user'})).toEqual([]);
  });

  it('renders a code result with no output', () => {
    expect(
      contentToResponseInputItems({
        role: 'user',
        parts: [{codeExecutionResult: {}}],
      }),
    ).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [
          {type: 'input_text', text: 'Execution Result:```code_output\n\n```'},
        ],
      },
    ]);
  });

  it('sends an unnamed function call with empty arguments', () => {
    expect(
      contentToResponseInputItems({
        role: 'model',
        parts: [{functionCall: {id: 'call_1'}}],
      }),
    ).toEqual([
      {type: 'function_call', call_id: 'call_1', name: '', arguments: '{}'},
    ]);
  });

  it('renders an assistant code result as its own message', () => {
    expect(
      contentToResponseInputItems({
        role: 'model',
        parts: [{codeExecutionResult: {output: '1'}}],
      }),
    ).toEqual([
      {
        type: 'message',
        role: 'assistant',
        content: 'Execution Result:```code_output\n1\n```',
      },
    ]);
  });
});

describe('toolChoice', () => {
  it('returns undefined when the request configures no tool choice', () => {
    expect(toolChoice({})).toBeUndefined();
    expect(toolChoice({toolConfig: {}})).toBeUndefined();
    expect(
      toolChoice({
        toolConfig: {
          functionCallingConfig: {
            mode: FunctionCallingConfigMode.MODE_UNSPECIFIED,
          },
        },
      }),
    ).toBeUndefined();
  });
});

describe('response conversion', () => {
  it('warns about a function call with no name and falls back to its id', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    const part = functionCallPart({
      type: 'function_call',
      call_id: '',
      id: 'fc_1',
      name: '',
      arguments: '{}',
    });

    expect(part.functionCall).toEqual({id: 'fc_1', name: '', args: {}});
    expect(warn).toHaveBeenCalledWith(
      'OpenAI Responses function call is missing a name.',
    );
    warn.mockRestore();
  });

  it('computes the total token count when the provider omits it', () => {
    expect(toUsageMetadata({input_tokens: 4, output_tokens: 6})).toMatchObject({
      totalTokenCount: 10,
    });
    expect(toUsageMetadata({input_tokens: 4})).toMatchObject({
      totalTokenCount: undefined,
    });
    expect(toUsageMetadata(undefined)).toBeUndefined();
  });

  it('maps the remaining response statuses', () => {
    expect(mapFinishReason(makeResponse({status: 'cancelled'}))).toBe(
      FinishReason.OTHER,
    );
    expect(
      mapFinishReason(makeResponse({status: 'in_progress'})),
    ).toBeUndefined();
    expect(
      mapFinishReason(
        makeResponse({status: 'incomplete', incomplete_details: {}}),
      ),
    ).toBe(FinishReason.OTHER);
  });

  it('records an output item it cannot map', () => {
    const unmappable: OpenAI.Responses.ResponseOutputItem = {
      id: 'ws_1',
      type: 'web_search_call',
      status: 'completed',
      action: {type: 'search'},
    };

    const llmResponse = responseToLlmResponse(
      makeResponse({output: [unmappable]}),
      true,
    );

    expect(llmResponse.content).toBeUndefined();
    expect(llmResponse.customMetadata).toMatchObject({
      openai_response: {unmapped_output: [unmappable]},
    });
  });

  it('leaves the error message unset when the response carries no error', () => {
    const llmResponse = responseToLlmResponse(
      makeResponse({status: 'cancelled'}),
      true,
    );

    expect(llmResponse.errorCode).toBe(FinishReason.OTHER);
    expect(llmResponse.errorMessage).toBeUndefined();
  });

  it('records no reasoning metadata for an item with neither id nor content', () => {
    const llmResponse = responseToLlmResponse(
      makeResponse({output: [reasoningItem({id: '', summary: ['Think']})]}),
      true,
    );

    expect(llmResponse.customMetadata).not.toHaveProperty(
      'openai_response.reasoning',
    );
  });

  it('skips an empty text block and an empty refusal', () => {
    const llmResponse = responseToLlmResponse(
      makeResponse({output: [messageItem([outputText(''), refusal('')])]}),
      true,
    );

    expect(llmResponse.content).toBeUndefined();
  });
});

describe('StreamAccumulator', () => {
  it('accumulates reasoning text deltas and their done event', () => {
    const accumulator = accumulate([
      createdEvent(makeResponse({id: 'resp_stream'})),
      outputItemAddedEvent({item: reasoningItem({})}),
      reasoningTextDeltaEvent({delta: 'Thin'}),
      reasoningTextDeltaEvent({delta: 'king'}),
      reasoningTextDoneEvent({text: 'Thinking hard'}),
    ]);

    expect(accumulator.finalResponse()?.content?.parts).toEqual([
      {text: 'Thinking hard', thought: true},
    ]);
  });

  it('keeps the accumulated reasoning when the done event carries no text', () => {
    const accumulator = accumulate([
      outputItemAddedEvent({item: reasoningItem({})}),
      reasoningTextDeltaEvent({delta: 'Thinking'}),
      reasoningTextDoneEvent({text: ''}),
    ]);

    expect(accumulator.finalResponse()?.content?.parts).toEqual([
      {text: 'Thinking', thought: true},
    ]);
  });

  it('takes the reasoning summary from a summary part done event', () => {
    const accumulator = accumulate([
      outputItemAddedEvent({item: reasoningItem({})}),
      reasoningSummaryDeltaEvent({delta: 'draft'}),
      reasoningSummaryPartDoneEvent({text: 'Summary'}),
    ]);

    expect(accumulator.finalResponse()?.content?.parts).toEqual([
      {text: 'Summary', thought: true},
    ]);
  });

  it('takes the message text from an output text done event', () => {
    const accumulator = accumulate([
      outputItemAddedEvent({item: messageItem([])}),
      textDeltaEvent({delta: 'partial'}),
      textDoneEvent({text: 'Final text'}),
    ]);

    expect(accumulator.finalResponse()?.content?.parts).toEqual([
      {text: 'Final text'},
    ]);
  });

  it('takes the message text from a content part done event', () => {
    const accumulator = accumulate([
      outputItemAddedEvent({item: messageItem([])}),
      contentPartDoneEvent({part: outputText('From the part')}),
    ]);

    expect(accumulator.finalResponse()?.content?.parts).toEqual([
      {text: 'From the part'},
    ]);
  });

  it('ignores a content part done event carrying a refusal', () => {
    const accumulator = accumulate([
      outputItemAddedEvent({item: messageItem([])}),
      textDeltaEvent({delta: 'kept'}),
      contentPartDoneEvent({part: refusal('no')}),
    ]);

    expect(accumulator.finalResponse()?.content?.parts).toEqual([
      {text: 'kept'},
    ]);
  });

  it('names a function call from its arguments done event', () => {
    const accumulator = accumulate([
      functionArgsDeltaEvent({delta: '{}'}),
      functionArgsDoneEvent({args: '{"city":"Paris"}', name: 'get_weather'}),
    ]);

    expect(
      accumulator.finalResponse()?.content?.parts?.[0].functionCall,
    ).toEqual({id: undefined, name: 'get_weather', args: {city: 'Paris'}});
  });

  it('keeps the streamed arguments when a done item omits them', () => {
    const accumulator = accumulate([
      outputItemAddedEvent({
        item: functionCallItem({
          callId: 'call_1',
          name: 'get_weather',
          args: '',
        }),
      }),
      functionArgsDeltaEvent({delta: '{"city":"Rome"}'}),
      outputItemDoneEvent({
        item: functionCallItem({callId: '', name: '', args: ''}),
      }),
    ]);

    expect(
      accumulator.finalResponse()?.content?.parts?.[0].functionCall,
    ).toEqual({id: 'call_1', name: 'get_weather', args: {city: 'Rome'}});
  });

  it('falls back to the accumulated text when a done item has no content', () => {
    const accumulator = accumulate([
      outputItemAddedEvent({item: messageItem([])}),
      textDeltaEvent({delta: 'streamed'}),
      outputItemDoneEvent({item: messageItem([])}),
    ]);

    expect(accumulator.finalResponse()?.content?.parts).toEqual([
      {text: 'streamed'},
    ]);
  });

  it('prefers the reasoning of a done item over the accumulated deltas', () => {
    const accumulator = accumulate([
      outputItemAddedEvent({item: reasoningItem({})}),
      reasoningSummaryDeltaEvent({delta: 'partial'}),
      outputItemDoneEvent({item: reasoningItem({summary: ['Complete']})}),
    ]);

    expect(accumulator.finalResponse()?.content?.parts).toEqual([
      {text: 'Complete', thought: true},
    ]);
  });

  it('falls back to the accumulated reasoning when a done item has none', () => {
    const accumulator = accumulate([
      outputItemAddedEvent({item: reasoningItem({})}),
      reasoningSummaryDeltaEvent({delta: 'partial'}),
      outputItemDoneEvent({item: reasoningItem({})}),
    ]);

    expect(accumulator.finalResponse()?.content?.parts).toEqual([
      {text: 'partial', thought: true},
    ]);
  });

  it('skips an output item that accumulated no text', () => {
    const accumulator = accumulate([
      outputItemAddedEvent({outputIndex: 0, item: reasoningItem({})}),
      outputItemAddedEvent({outputIndex: 1, item: messageItem([])}),
      outputItemAddedEvent({outputIndex: 2, item: reasoningItem({id: 'rs_2'})}),
      reasoningSummaryDeltaEvent({outputIndex: 2, delta: 'Think'}),
      outputItemAddedEvent({outputIndex: 3, item: messageItem([], 'msg_2')}),
      textDeltaEvent({outputIndex: 3, delta: 'Hi'}),
    ]);

    expect(accumulator.finalResponse()?.content?.parts).toEqual([
      {text: 'Think', thought: true},
      {text: 'Hi'},
    ]);
  });

  it('produces nothing for an output item it cannot reconstruct', () => {
    const accumulator = accumulate([
      outputItemAddedEvent({
        item: {
          id: 'ws_1',
          type: 'web_search_call',
          status: 'completed',
          action: {type: 'search'},
        },
      }),
    ]);

    expect(accumulator.finalResponse()).toBeUndefined();
  });

  it('ignores an event type it does not handle', () => {
    const accumulator = new StreamAccumulator(true);

    expect(
      accumulator.processEvent({
        type: 'response.in_progress',
        response: makeResponse({}),
        sequence_number: 0,
      }),
    ).toEqual([]);
  });

  it('reports a stream error event and yields no final response', () => {
    const accumulator = new StreamAccumulator(true);

    const responses = accumulator.processEvent({
      type: 'error',
      code: 'server_error',
      message: 'boom',
      param: null,
      sequence_number: 0,
    });

    expect(responses[0].errorMessage).toContain('boom');
    expect(accumulator.finalResponse()).toBeUndefined();
  });

  it('emits no reasoning boundary when response metadata is switched off', () => {
    const accumulator = new StreamAccumulator(false);
    accumulator.processEvent(reasoningSummaryDeltaEvent({delta: 'Think'}));

    const responses = accumulator.processEvent(textDeltaEvent({delta: 'Hi'}));

    expect(responses).toHaveLength(1);
    expect(responses[0].content?.parts?.[0].text).toBe('Hi');
  });

  it('carries the completed response usage into the final response', () => {
    const accumulator = accumulate([
      completedEvent(
        makeResponse({
          usage: makeUsage({input: 2, output: 3, total: 5}),
          output: [messageItem([outputText('Hi')])],
        }),
      ),
    ]);

    expect(accumulator.finalResponse()?.usageMetadata?.totalTokenCount).toBe(5);
  });
});

describe('OpenAiResponsesLlm options', () => {
  it('defaults to gpt-5 and registers no model name patterns', () => {
    expect(new OpenAiResponsesLlm().model).toBe('gpt-5');
    expect(OpenAiResponsesLlm.supportedModels).toEqual([]);
  });

  it('rejects a live connection', async () => {
    const llm = new OpenAiResponsesLlm({model: 'gpt-5'});

    await expect(llm.connect()).rejects.toThrow(
      'Live connection is not supported for gpt-5.',
    );
  });

  it('sends the instance-level request options', async () => {
    const client = new FakeResponsesClient();
    const llm = new OpenAiResponsesLlm({
      model: 'gpt-5',
      client,
      parallelToolCalls: false,
      truncation: 'auto',
      serviceTier: 'flex',
    });

    await drain(
      llm.generateContentAsync(
        userRequest({
          toolConfig: {
            functionCallingConfig: {mode: FunctionCallingConfigMode.ANY},
          },
        }),
      ),
    );

    expect(client.responses.body).toMatchObject({
      parallel_tool_calls: false,
      truncation: 'auto',
      service_tier: 'flex',
      tool_choice: 'required',
    });
  });

  it('skips a tool that declares no functions', async () => {
    const client = new FakeResponsesClient();
    const llm = new OpenAiResponsesLlm({model: 'gpt-5', client});

    await drain(
      llm.generateContentAsync(
        userRequest({
          tools: [{googleSearch: {}}, {functionDeclarations: undefined}],
        }),
      ),
    );

    expect(client.responses.body?.tools).toBeUndefined();
  });

  it('accepts a genai Schema for structured output', async () => {
    const client = new FakeResponsesClient();
    const llm = new OpenAiResponsesLlm({model: 'gpt-5', client});
    const schema: Schema = {
      title: 'Answer',
      type: Type.OBJECT,
      properties: {answer: {type: Type.STRING}},
    };

    await drain(
      llm.generateContentAsync(userRequest({responseSchema: schema})),
    );

    expect(client.responses.body?.text?.format).toMatchObject({
      name: 'Answer',
      strict: true,
    });
  });

  it('forwards the abort signal to the client', async () => {
    const client = new FakeResponsesClient();
    const llm = new OpenAiResponsesLlm({model: 'gpt-5', client});
    const controller = new AbortController();

    await drain(
      llm.generateContentAsync(userRequest(), false, controller.signal),
    );

    expect(client.responses.options).toEqual({signal: controller.signal});
  });

  it('builds the default client once and reuses it', async () => {
    constructorSpy.mockClear();
    const llm = new OpenAiResponsesLlm({model: 'gpt-5', apiKey: 'secret'});

    await drain(llm.generateContentAsync(userRequest()));
    await drain(llm.generateContentAsync(userRequest()));

    expect(constructorSpy).toHaveBeenCalledTimes(1);
  });

  it('builds an Azure client without a base URL when no endpoint is set', async () => {
    constructorSpy.mockClear();
    const llm = new AzureOpenAiResponsesLlm({model: 'deployment', apiKey: 'k'});

    await drain(llm.generateContentAsync(userRequest()));

    expect(constructorSpy).toHaveBeenCalledWith({apiKey: 'k'});
  });

  it('leaves the API key unresolved when none is configured', async () => {
    constructorSpy.mockClear();
    const previous = process.env['AZURE_OPENAI_API_KEY'];
    delete process.env['AZURE_OPENAI_API_KEY'];
    try {
      const llm = new AzureOpenAiResponsesLlm({model: 'deployment'});

      await drain(llm.generateContentAsync(userRequest()));

      expect(constructorSpy).toHaveBeenCalledWith({apiKey: undefined});
    } finally {
      if (previous !== undefined) {
        process.env['AZURE_OPENAI_API_KEY'] = previous;
      }
    }
  });
});
