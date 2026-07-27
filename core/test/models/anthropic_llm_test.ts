/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AnthropicGenerateContentConfig,
  AnthropicLlm,
  Claude,
  createAnthropicGenerateContentConfig,
  LlmAgent,
  LLMRegistry,
  LlmRequest,
  LlmResponse,
  Logger,
  setLogger,
  version,
} from '@google/adk';
// Internal conversion helpers are not part of the public API surface, so they
// are deep-imported here (mirroring interactions_utils_test.ts).
import {
  Content,
  FinishReason,
  FunctionDeclaration,
  Language,
  Outcome,
  ThinkingLevel,
  Type,
} from '@google/genai';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {
  contentBlockToPart,
  contentToMessageParam,
  functionDeclarationToToolParam,
  messageToGenerateContentResponse,
  partToMessageBlock,
  toClaudeRole,
  toGoogleGenaiFinishReason,
  ToolUseIdSanitizer,
  updateTypeString,
} from '../../src/models/anthropic_llm.js';

const hoisted = vi.hoisted(() => {
  const create = vi.fn<(...args: unknown[]) => Promise<unknown>>();
  const anthropicCtor = vi.fn(() => ({messages: {create}}));
  const vertexCtor = vi.fn(() => ({messages: {create}}));
  return {create, anthropicCtor, vertexCtor};
});

vi.mock('@anthropic-ai/sdk', () => ({default: hoisted.anthropicCtor}));
vi.mock('@anthropic-ai/vertex-sdk', () => ({
  AnthropicVertex: hoisted.vertexCtor,
}));

const warnSpy = vi.fn();
const infoSpy = vi.fn();
const mockLogger: Logger = {
  setLogLevel: vi.fn(),
  log: vi.fn(),
  debug: vi.fn(),
  info: infoSpy,
  warn: warnSpy,
  error: vi.fn(),
};

type Kwargs = Record<string, unknown>;
type Block = Record<string, unknown>;

/** Collects every response yielded by generateContentAsync. */
async function collect(
  gen: AsyncGenerator<LlmResponse, void>,
): Promise<LlmResponse[]> {
  const out: LlmResponse[] = [];
  for await (const response of gen) {
    out.push(response);
  }
  return out;
}

/** Builds a minimal LlmRequest. */
function makeRequest(
  contents: Content[],
  config?: LlmRequest['config'],
  model = 'claude-sonnet-4-20250514',
): LlmRequest {
  return {model, contents, config, liveConnectConfig: {}, toolsDict: {}};
}

/** Builds a non-streaming Anthropic Message for the mocked client. */
function makeMessage(
  text: string,
  usage: Record<string, unknown> = {input_tokens: 5, output_tokens: 2},
) {
  return {
    id: 'msg_test',
    content: [{type: 'text', text, citations: null}],
    model: 'claude-sonnet-4-20250514',
    role: 'assistant',
    stop_reason: 'end_turn',
    stop_sequence: null,
    type: 'message',
    usage,
  };
}

/** Wraps a list of raw stream events in an async iterable. */
async function* makeStream(events: unknown[]): AsyncGenerator<unknown> {
  for (const event of events) {
    yield event;
  }
}

/** Returns the kwargs object of the single messages.create call. */
function createKwargs(callIndex = 0): Kwargs {
  return hoisted.create.mock.calls[callIndex][0] as Kwargs;
}

const clearEnv = () => {
  delete process.env['GOOGLE_CLOUD_PROJECT'];
  delete process.env['GOOGLE_CLOUD_LOCATION'];
  delete process.env['GOOGLE_CLOUD_AGENT_ENGINE_ID'];
  delete process.env['ANTHROPIC_API_KEY'];
};

beforeEach(() => {
  clearEnv();
  hoisted.create.mockReset();
  hoisted.anthropicCtor.mockClear();
  hoisted.vertexCtor.mockClear();
  warnSpy.mockClear();
  infoSpy.mockClear();
  setLogger(mockLogger);
});

afterEach(() => {
  clearEnv();
  setLogger(null);
});

describe('supportedModels', () => {
  it('exposes exactly the two adk-python regexes', () => {
    const models = Claude.supportedModels;
    expect(models).toHaveLength(2);
    expect((models[0] as RegExp).source).toBe('claude-3-.*');
    expect((models[1] as RegExp).source).toBe('claude-.*-4.*');
  });
});

describe('constructor defaults', () => {
  it('defaults the direct model to claude-sonnet-4', () => {
    expect(new AnthropicLlm().model).toBe('claude-sonnet-4-20250514');
  });

  it('defaults the Vertex model to claude-3-5-sonnet', () => {
    expect(new Claude().model).toBe('claude-3-5-sonnet-v2@20241022');
  });
});

describe('LLMRegistry integration', () => {
  it('resolves a claude-3 name to Claude', () => {
    expect(LLMRegistry.resolve('claude-3-5-sonnet-v2@20241022')).toBe(Claude);
  });

  it('resolves a claude-4 name to Claude', () => {
    expect(LLMRegistry.resolve('claude-sonnet-4-20250514')).toBe(Claude);
  });

  it('resolves a string model in LlmAgent to a Claude instance', () => {
    const agent = new LlmAgent({
      name: 'assistant',
      model: 'claude-3-5-sonnet-v2@20241022',
    });
    expect(agent.canonicalModel).toBeInstanceOf(Claude);
  });

  it('newLlm builds a Claude for a claude-4 name', () => {
    expect(LLMRegistry.newLlm('claude-opus-4-20250101')).toBeInstanceOf(Claude);
  });
});

describe('Claude Vertex client creation', () => {
  it('passes project and location from env as projectId/region', async () => {
    process.env['GOOGLE_CLOUD_PROJECT'] = 'env-project';
    process.env['GOOGLE_CLOUD_LOCATION'] = 'env-location';
    hoisted.create.mockResolvedValue(makeMessage('hi'));
    const llm = new Claude({model: 'claude-3-5-sonnet-v2@20241022'});

    await collect(
      llm.generateContentAsync(
        makeRequest(
          [{role: 'user', parts: [{text: 'hi'}]}],
          undefined,
          'claude-3-5-sonnet-v2@20241022',
        ),
      ),
    );

    expect(hoisted.vertexCtor).toHaveBeenCalledTimes(1);
    const opts = (hoisted.vertexCtor.mock.calls[0] as unknown[])[0] as Kwargs;
    expect(opts['projectId']).toBe('env-project');
    expect(opts['region']).toBe('env-location');
  });

  it('parses project/location from a full resource-name model string', async () => {
    hoisted.create.mockResolvedValue(makeMessage('hi'));
    const model =
      'projects/test-project/locations/test-location/publishers/anthropic/models/claude-3-5-sonnet-v2@20241022';
    const llm = new Claude({model});

    await collect(
      llm.generateContentAsync(
        makeRequest([{role: 'user', parts: [{text: 'hi'}]}], undefined, model),
      ),
    );

    const opts = (hoisted.vertexCtor.mock.calls[0] as unknown[])[0] as Kwargs;
    expect(opts['projectId']).toBe('test-project');
    expect(opts['region']).toBe('test-location');
  });

  it('prefers explicit constructor project/location', async () => {
    hoisted.create.mockResolvedValue(makeMessage('hi'));
    const llm = new Claude({
      model: 'claude-3-5-sonnet-v2@20241022',
      project: 'ctor-project',
      location: 'ctor-location',
    });

    await collect(
      llm.generateContentAsync(
        makeRequest([{role: 'user', parts: [{text: 'hi'}]}]),
      ),
    );

    const opts = (hoisted.vertexCtor.mock.calls[0] as unknown[])[0] as Kwargs;
    expect(opts['projectId']).toBe('ctor-project');
    expect(opts['region']).toBe('ctor-location');
  });

  it('forwards tracking headers to the Vertex client', async () => {
    process.env['GOOGLE_CLOUD_PROJECT'] = 'test-project';
    process.env['GOOGLE_CLOUD_LOCATION'] = 'us-central1';
    hoisted.create.mockResolvedValue(makeMessage('hi'));
    const llm = new Claude({model: 'claude-3-5-sonnet-v2@20241022'});

    await collect(
      llm.generateContentAsync(
        makeRequest([{role: 'user', parts: [{text: 'hi'}]}]),
      ),
    );

    const opts = (hoisted.vertexCtor.mock.calls[0] as unknown[])[0] as Kwargs;
    const headers = opts['defaultHeaders'] as Record<string, string>;
    expect(headers['x-goog-api-client']).toContain(`google-adk/${version}`);
    expect(headers['user-agent']).toContain(`google-adk/${version}`);
  });

  it('throws when project/location are unavailable', async () => {
    const llm = new Claude({model: 'claude-3-5-sonnet-v2@20241022'});
    await expect(
      collect(
        llm.generateContentAsync(
          makeRequest([{role: 'user', parts: [{text: 'hi'}]}]),
        ),
      ),
    ).rejects.toThrow(
      'GOOGLE_CLOUD_PROJECT and GOOGLE_CLOUD_LOCATION must be set',
    );
  });

  it('memoizes the client across calls', async () => {
    process.env['GOOGLE_CLOUD_PROJECT'] = 'p';
    process.env['GOOGLE_CLOUD_LOCATION'] = 'l';
    hoisted.create.mockResolvedValue(makeMessage('hi'));
    const llm = new Claude({model: 'claude-3-5-sonnet-v2@20241022'});

    await collect(
      llm.generateContentAsync(
        makeRequest([{role: 'user', parts: [{text: 'a'}]}]),
      ),
    );
    await collect(
      llm.generateContentAsync(
        makeRequest([{role: 'user', parts: [{text: 'b'}]}]),
      ),
    );

    expect(hoisted.vertexCtor).toHaveBeenCalledTimes(1);
  });

  it('keeps constructor project/location for a non-matching projects/ model', async () => {
    hoisted.create.mockResolvedValue(makeMessage('hi'));
    const llm = new Claude({
      model: 'projects/only',
      project: 'ctor-project',
      location: 'ctor-location',
    });

    await collect(
      llm.generateContentAsync(
        makeRequest(
          [{role: 'user', parts: [{text: 'hi'}]}],
          undefined,
          'projects/only',
        ),
      ),
    );

    const opts = (hoisted.vertexCtor.mock.calls[0] as unknown[])[0] as Kwargs;
    expect(opts['projectId']).toBe('ctor-project');
    expect(opts['region']).toBe('ctor-location');
  });
});

describe('toClaudeRole', () => {
  it('maps model and assistant to assistant', () => {
    expect(toClaudeRole('model')).toBe('assistant');
    expect(toClaudeRole('assistant')).toBe('assistant');
  });

  it('maps user and unknown to user', () => {
    expect(toClaudeRole('user')).toBe('user');
    expect(toClaudeRole(undefined)).toBe('user');
    expect(toClaudeRole('system')).toBe('user');
  });
});

describe('toGoogleGenaiFinishReason', () => {
  const cases: Array<[string | null | undefined, FinishReason | undefined]> = [
    ['end_turn', FinishReason.STOP],
    ['stop_sequence', FinishReason.STOP],
    ['tool_use', FinishReason.STOP],
    ['pause_turn', FinishReason.STOP],
    ['max_tokens', FinishReason.MAX_TOKENS],
    ['refusal', FinishReason.SAFETY],
    [undefined, undefined],
    [null, undefined],
    ['something_new', FinishReason.FINISH_REASON_UNSPECIFIED],
  ];

  it.each(cases)('maps %s', (stopReason, expected) => {
    expect(toGoogleGenaiFinishReason(stopReason)).toBe(expected);
  });
});

describe('updateTypeString', () => {
  it('lowercases nested type strings across schema keywords', () => {
    const schema = {
      type: 'OBJECT',
      properties: {a: {type: 'STRING'}},
      $defs: {Ref: {type: 'INTEGER'}},
      items: {type: 'BOOLEAN'},
      anyOf: [{type: 'NULL'}],
      prefixItems: [{type: 'NUMBER'}],
    };
    updateTypeString(schema);
    expect(schema.type).toBe('object');
    expect(schema.properties.a.type).toBe('string');
    expect(schema.$defs.Ref.type).toBe('integer');
    expect(schema.items.type).toBe('boolean');
    expect(schema.anyOf[0].type).toBe('null');
    expect(schema.prefixItems[0].type).toBe('number');
  });

  it('ignores non-object, non-array values', () => {
    expect(() => updateTypeString('string')).not.toThrow();
    expect(() => updateTypeString(null)).not.toThrow();
    expect(() => updateTypeString(42)).not.toThrow();
  });
});

interface ToolCase {
  name: string;
  declaration: FunctionDeclaration;
  expected: {
    name: string;
    description: string;
    input_schema: Record<string, unknown>;
  };
}

const toolCases: ToolCase[] = [
  {
    name: 'function_with_no_parameters',
    declaration: {
      name: 'get_current_time',
      description: 'Gets the current time.',
    },
    expected: {
      name: 'get_current_time',
      description: 'Gets the current time.',
      input_schema: {type: 'object', properties: {}},
    },
  },
  {
    name: 'function_with_one_optional_parameter',
    declaration: {
      name: 'get_weather',
      description: 'Gets weather information for a given location.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          location: {
            type: Type.STRING,
            description: 'City and state, e.g., San Francisco, CA',
          },
        },
      },
    },
    expected: {
      name: 'get_weather',
      description: 'Gets weather information for a given location.',
      input_schema: {
        type: 'object',
        properties: {
          location: {
            type: 'string',
            description: 'City and state, e.g., San Francisco, CA',
          },
        },
      },
    },
  },
  {
    name: 'function_with_one_required_parameter',
    declaration: {
      name: 'get_stock_price',
      description: 'Gets the current price for a stock ticker.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          ticker: {
            type: Type.STRING,
            description: 'The stock ticker, e.g., AAPL',
          },
        },
        required: ['ticker'],
      },
    },
    expected: {
      name: 'get_stock_price',
      description: 'Gets the current price for a stock ticker.',
      input_schema: {
        type: 'object',
        properties: {
          ticker: {type: 'string', description: 'The stock ticker, e.g., AAPL'},
        },
        required: ['ticker'],
      },
    },
  },
  {
    name: 'function_with_multiple_mixed_parameters',
    declaration: {
      name: 'submit_order',
      description: 'Submits a product order.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          product_id: {type: Type.STRING, description: 'The product ID'},
          quantity: {type: Type.INTEGER, description: 'The order quantity'},
          notes: {type: Type.STRING, description: 'Optional order notes'},
        },
        required: ['product_id', 'quantity'],
      },
    },
    expected: {
      name: 'submit_order',
      description: 'Submits a product order.',
      input_schema: {
        type: 'object',
        properties: {
          product_id: {type: 'string', description: 'The product ID'},
          quantity: {type: 'integer', description: 'The order quantity'},
          notes: {type: 'string', description: 'Optional order notes'},
        },
        required: ['product_id', 'quantity'],
      },
    },
  },
  {
    name: 'function_with_complex_nested_parameter',
    declaration: {
      name: 'create_playlist',
      description: 'Creates a playlist from a list of songs.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          playlist_name: {
            type: Type.STRING,
            description: 'The name for the new playlist',
          },
          songs: {
            type: Type.ARRAY,
            description: 'A list of songs to add to the playlist',
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
        required: ['playlist_name', 'songs'],
      },
    },
    expected: {
      name: 'create_playlist',
      description: 'Creates a playlist from a list of songs.',
      input_schema: {
        type: 'object',
        properties: {
          playlist_name: {
            type: 'string',
            description: 'The name for the new playlist',
          },
          songs: {
            type: 'array',
            description: 'A list of songs to add to the playlist',
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
        required: ['playlist_name', 'songs'],
      },
    },
  },
  {
    name: 'function_with_nested_object_parameter',
    declaration: {
      name: 'update_profile',
      description: 'Updates a user profile.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          profile: {
            type: Type.OBJECT,
            description: 'The profile data',
            properties: {
              name: {type: Type.STRING, description: 'Full name'},
              address: {
                type: Type.OBJECT,
                description: 'Mailing address',
                properties: {
                  city: {type: Type.STRING},
                  state: {type: Type.STRING},
                },
              },
            },
          },
        },
        required: ['profile'],
      },
    },
    expected: {
      name: 'update_profile',
      description: 'Updates a user profile.',
      input_schema: {
        type: 'object',
        properties: {
          profile: {
            type: 'object',
            description: 'The profile data',
            properties: {
              name: {type: 'string', description: 'Full name'},
              address: {
                type: 'object',
                description: 'Mailing address',
                properties: {
                  city: {type: 'string'},
                  state: {type: 'string'},
                },
              },
            },
          },
        },
        required: ['profile'],
      },
    },
  },
  {
    name: 'function_with_any_of_parameter',
    declaration: {
      name: 'set_value',
      description: 'Sets a value that can be a string or integer.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          value: {
            description: 'A string or integer value',
            anyOf: [{type: Type.STRING}, {type: Type.INTEGER}],
          },
        },
        required: ['value'],
      },
    },
    expected: {
      name: 'set_value',
      description: 'Sets a value that can be a string or integer.',
      input_schema: {
        type: 'object',
        properties: {
          value: {
            description: 'A string or integer value',
            anyOf: [{type: 'string'}, {type: 'integer'}],
          },
        },
        required: ['value'],
      },
    },
  },
  {
    name: 'function_with_additional_properties_parameter',
    declaration: {
      name: 'store_metadata',
      description: 'Stores arbitrary key-value metadata.',
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
    expected: {
      name: 'store_metadata',
      description: 'Stores arbitrary key-value metadata.',
      input_schema: {
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
    },
  },
  {
    name: 'function_with_parameters_json_schema_combinators',
    declaration: {
      name: 'validate_payload',
      description: 'Validates a payload with schema combinators.',
      parametersJsonSchema: {
        type: 'OBJECT',
        properties: {
          choice: {oneOf: [{type: 'STRING'}, {type: 'INTEGER'}]},
          config: {
            allOf: [{type: 'OBJECT', properties: {enabled: {type: 'BOOLEAN'}}}],
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
    expected: {
      name: 'validate_payload',
      description: 'Validates a payload with schema combinators.',
      input_schema: {
        type: 'object',
        properties: {
          choice: {oneOf: [{type: 'string'}, {type: 'integer'}]},
          config: {
            allOf: [{type: 'object', properties: {enabled: {type: 'boolean'}}}],
          },
          blocked: {not: {type: 'null'}},
          tuple_value: {
            type: 'array',
            items: [{type: 'string'}, {type: 'integer'}],
          },
        },
        required: ['choice'],
      },
    },
  },
  {
    name: 'function_with_parameters_json_schema',
    declaration: {
      name: 'search_database',
      description: 'Searches a database with given criteria.',
      parametersJsonSchema: {
        type: 'object',
        properties: {
          query: {type: 'string', description: 'The search query'},
          limit: {type: 'integer', description: 'Maximum number of results'},
        },
        required: ['query'],
      },
    },
    expected: {
      name: 'search_database',
      description: 'Searches a database with given criteria.',
      input_schema: {
        type: 'object',
        properties: {
          query: {type: 'string', description: 'The search query'},
          limit: {type: 'integer', description: 'Maximum number of results'},
        },
        required: ['query'],
      },
    },
  },
];

describe('functionDeclarationToToolParam', () => {
  it.each(toolCases)('$name', ({declaration, expected}) => {
    expect(functionDeclarationToToolParam(declaration)).toEqual(expected);
  });

  it('defaults a missing description to an empty string', () => {
    expect(functionDeclarationToToolParam({name: 'noop'})).toEqual({
      name: 'noop',
      description: '',
      input_schema: {type: 'object', properties: {}},
    });
  });

  it('throws when the declaration has no name', () => {
    expect(() =>
      functionDeclarationToToolParam({description: 'no name'}),
    ).toThrow('Function declaration must have a name.');
  });
});

describe('partToMessageBlock function responses', () => {
  it('extracts content-list text', () => {
    const result = partToMessageBlock({
      functionResponse: {
        id: 'test_id_123',
        name: 'generate_sample_filesystem',
        response: {
          content: [
            {
              type: 'text',
              text: '{"name":"root","node_type":"folder","children":[]}',
            },
          ],
        },
      },
    }) as unknown as Block;
    expect(result['tool_use_id']).toBe('test_id_123');
    expect(result['type']).toBe('tool_result');
    expect(result['is_error']).toBe(false);
    expect(result['content']).toContain('"name":"root"');
  });

  it('joins multiple content items with newlines', () => {
    const result = partToMessageBlock({
      functionResponse: {
        id: 'x',
        name: 'multi',
        response: {
          content: [
            {type: 'text', text: 'First part'},
            {type: 'text', text: 'Second part'},
          ],
        },
      },
    }) as unknown as Block;
    expect(result['content']).toBe('First part\nSecond part');
  });

  it('stringifies non-text content items', () => {
    const result = partToMessageBlock({
      functionResponse: {
        id: 'x',
        name: 'mixed',
        response: {content: [{type: 'image', url: 'u'}, 'plain']},
      },
    }) as unknown as Block;
    expect(result['content']).toBe('{"type":"image","url":"u"}\nplain');
  });

  it('extracts the traditional result field', () => {
    const result = partToMessageBlock({
      functionResponse: {
        id: 'test_id_456',
        name: 'some_tool',
        response: {result: 'This is the result from the tool'},
      },
    }) as unknown as Block;
    expect(result['content']).toBe('This is the result from the tool');
  });

  it('serializes dict results as JSON', () => {
    const result = partToMessageBlock({
      functionResponse: {
        id: 'x',
        name: 'get_topic',
        response: {result: {topic: 'travel', active: true, count: null}},
      },
    }) as unknown as Block;
    const parsed = JSON.parse(result['content'] as string);
    expect(parsed).toEqual({topic: 'travel', active: true, count: null});
  });

  it('serializes list results as JSON', () => {
    const result = partToMessageBlock({
      functionResponse: {
        id: 'x',
        name: 'get_items',
        response: {result: ['item1', 'item2']},
      },
    }) as unknown as Block;
    expect(JSON.parse(result['content'] as string)).toEqual(['item1', 'item2']);
  });

  it('does not drop empty dict/list results', () => {
    const emptyDict = partToMessageBlock({
      functionResponse: {id: 'x', name: 't', response: {result: {}}},
    }) as unknown as Block;
    expect(emptyDict['content']).toBe('{}');
    const emptyList = partToMessageBlock({
      functionResponse: {id: 'x', name: 't', response: {result: []}},
    }) as unknown as Block;
    expect(emptyList['content']).toBe('[]');
  });

  it('serializes arbitrary dicts as a JSON fallback', () => {
    const result = partToMessageBlock({
      functionResponse: {
        id: 'x',
        name: 'load_skill',
        response: {
          skill_name: 'my_skill',
          instructions: 'do this',
          frontmatter: {version: '1.0'},
        },
      },
    }) as unknown as Block;
    const parsed = JSON.parse(result['content'] as string);
    expect(parsed['skill_name']).toBe('my_skill');
    expect(parsed['frontmatter']['version']).toBe('1.0');
  });

  it('passes a scalar string content through unchanged', () => {
    const result = partToMessageBlock({
      functionResponse: {id: 'x', name: 't', response: {content: 'Hello'}},
    }) as unknown as Block;
    expect(result['content']).toBe('Hello');
  });

  it('falls through to JSON when content is an empty string', () => {
    const result = partToMessageBlock({
      functionResponse: {id: 'x', name: 't', response: {content: ''}},
    }) as unknown as Block;
    expect(JSON.parse(result['content'] as string)).toEqual({content: ''});
  });

  it('keeps sibling metadata when content is empty', () => {
    const result = partToMessageBlock({
      functionResponse: {
        id: 'x',
        name: 't',
        response: {content: '', extra: 'keep me'},
      },
    }) as unknown as Block;
    const parsed = JSON.parse(result['content'] as string);
    expect(parsed).toEqual({content: '', extra: 'keep me'});
  });

  it('keeps an empty response empty', () => {
    const result = partToMessageBlock({
      functionResponse: {id: 'x', name: 't', response: {}},
    }) as unknown as Block;
    expect(result['content']).toBe('');
  });

  it('treats a missing response as empty content', () => {
    const result = partToMessageBlock({
      functionResponse: {id: 'x', name: 't'},
    }) as unknown as Block;
    expect(result['content']).toBe('');
  });
});

describe('partToMessageBlock media and code', () => {
  it('converts image parts without re-encoding data', () => {
    const result = partToMessageBlock({
      inlineData: {mimeType: 'image/jpeg', data: 'ZmFrZQ=='},
    }) as unknown as Block;
    expect(result).toEqual({
      type: 'image',
      source: {type: 'base64', media_type: 'image/jpeg', data: 'ZmFrZQ=='},
    });
  });

  it('converts PDF document parts', () => {
    const result = partToMessageBlock({
      inlineData: {mimeType: 'application/pdf', data: 'JVBERi0='},
    }) as unknown as Block;
    expect(result).toEqual({
      type: 'document',
      source: {type: 'base64', media_type: 'application/pdf', data: 'JVBERi0='},
    });
  });

  it('preserves PDF MIME type parameters', () => {
    const result = partToMessageBlock({
      inlineData: {mimeType: 'application/pdf; name=doc.pdf', data: 'JVBERi0='},
    }) as unknown as Block;
    const source = result['source'] as Block;
    expect(source['media_type']).toBe('application/pdf; name=doc.pdf');
  });

  it('converts executable code parts', () => {
    const result = partToMessageBlock({
      executableCode: {code: 'print(1)', language: 'PYTHON' as Language},
    }) as unknown as Block;
    expect(result['type']).toBe('text');
    expect(result['text']).toBe('Code:```python\nprint(1)\n```');
  });

  it('converts code execution result parts', () => {
    const result = partToMessageBlock({
      codeExecutionResult: {output: '42', outcome: 'OUTCOME_OK' as Outcome},
    }) as unknown as Block;
    expect(result['type']).toBe('text');
    expect(result['text']).toBe('Execution Result:```code_output\n42\n```');
  });

  it('handles executable code with no code and empty results', () => {
    const code = partToMessageBlock({executableCode: {}}) as unknown as Block;
    expect(code['text']).toBe('Code:```python\n\n```');
    const result = partToMessageBlock({
      codeExecutionResult: {},
    }) as unknown as Block;
    expect(result['text']).toBe('Execution Result:```code_output\n\n```');
  });

  it('throws for an unsupported part', () => {
    expect(() => partToMessageBlock({})).toThrow('Not supported yet');
  });
});

describe('partToMessageBlock thinking round-trips', () => {
  it('maps thought text to a thinking block', () => {
    const result = partToMessageBlock({
      text: 'My reasoning steps.',
      thought: true,
      thoughtSignature: 'roundtrip_sig',
    }) as unknown as Block;
    expect(result).toEqual({
      type: 'thinking',
      thinking: 'My reasoning steps.',
      signature: 'roundtrip_sig',
    });
  });

  it('maps a thought without a signature to an empty signature', () => {
    const result = partToMessageBlock({
      text: 'My reasoning steps.',
      thought: true,
    }) as unknown as Block;
    expect(result).toEqual({
      type: 'thinking',
      thinking: 'My reasoning steps.',
      signature: '',
    });
  });

  it('maps redacted thoughts to a redacted_thinking block', () => {
    const result = partToMessageBlock({
      thought: true,
      thoughtSignature: 'encrypted_blob',
    }) as unknown as Block;
    expect(result).toEqual({
      type: 'redacted_thinking',
      data: 'encrypted_blob',
    });
  });
});

describe('partToMessageBlock tool ids', () => {
  it('preserves a valid function-call id', () => {
    const result = partToMessageBlock({
      functionCall: {id: 'toolu_01abc', name: 'test_tool', args: {k: 'v'}},
    }) as unknown as Block;
    expect(result['id']).toBe('toolu_01abc');
  });

  it('preserves a valid function-response id', () => {
    const result = partToMessageBlock({
      functionResponse: {
        id: 'toolu_01abc',
        name: 't',
        response: {result: 'ok'},
      },
    }) as unknown as Block;
    expect(result['tool_use_id']).toBe('toolu_01abc');
  });

  it('preserves an adk-<uuid> id and keeps the pair matched', () => {
    const id = 'adk-12345678-1234-1234-1234-123456789012';
    const call = partToMessageBlock({
      functionCall: {id, name: 't', args: {a: 1}},
    }) as unknown as Block;
    const response = partToMessageBlock({
      functionResponse: {id, name: 't', response: {result: 'ok'}},
    }) as unknown as Block;
    expect(call['id']).toBe(id);
    expect(response['tool_use_id']).toBe(id);
    expect(call['id']).toBe(response['tool_use_id']);
  });

  it('defaults function-call args to an empty object', () => {
    const result = partToMessageBlock({
      functionCall: {id: 'toolu_x', name: 't'},
    }) as unknown as Block;
    expect(result['input']).toEqual({});
  });

  it('throws when a function call has no name', () => {
    expect(() =>
      partToMessageBlock({functionCall: {id: 'toolu_x', args: {}}}),
    ).toThrow('Function call must have a name.');
  });

  it.each([
    ['null id', null],
    ['empty id', ''],
    ['invalid chars', 'invalid id with spaces!'],
  ])('generates a valid fallback id for %s', (_label, id) => {
    const result = partToMessageBlock({
      functionCall: {
        id: id ?? undefined,
        name: 'test_tool',
        args: {key: 'value'},
      },
    }) as unknown as Block;
    expect(result['id'] as string).toMatch(/^toolu_/);
    expect(result['id'] as string).toMatch(/^[a-zA-Z0-9_-]+$/);
  });
});

describe('ToolUseIdSanitizer', () => {
  it('returns valid ids unchanged', () => {
    const sanitizer = new ToolUseIdSanitizer();
    expect(sanitizer.sanitize('toolu_valid-1')).toBe('toolu_valid-1');
  });

  it('maps invalid ids deterministically and consistently', () => {
    const sanitizer = new ToolUseIdSanitizer();
    const first = sanitizer.sanitize('bad!');
    const second = sanitizer.sanitize('bad!');
    const other = sanitizer.sanitize('also bad!');
    expect(first).toBe('toolu_fallback_0');
    expect(second).toBe('toolu_fallback_0');
    expect(other).toBe('toolu_fallback_1');
  });

  it('collapses null and empty to the same fallback', () => {
    const sanitizer = new ToolUseIdSanitizer();
    expect(sanitizer.sanitize(null)).toBe('toolu_fallback_0');
    expect(sanitizer.sanitize('')).toBe('toolu_fallback_0');
  });
});

interface ContentCase {
  name: string;
  content: Content;
  role: string;
  length: number;
  warning?: string;
}

const contentCases: ContentCase[] = [
  {
    name: 'user_role_with_text_and_image',
    content: {
      role: 'user',
      parts: [
        {text: "What's in this image?"},
        {inlineData: {mimeType: 'image/jpeg', data: 'ZmFrZQ=='}},
      ],
    },
    role: 'user',
    length: 2,
  },
  {
    name: 'model_role_with_text_and_image',
    content: {
      role: 'model',
      parts: [
        {text: 'I see a cat.'},
        {inlineData: {mimeType: 'image/png', data: 'ZmFrZQ=='}},
      ],
    },
    role: 'assistant',
    length: 1,
    warning: 'Image data is not supported in Claude for assistant turns.',
  },
  {
    name: 'assistant_role_with_text_and_image',
    content: {
      role: 'assistant',
      parts: [
        {text: "Here's what I found."},
        {inlineData: {mimeType: 'image/webp', data: 'ZmFrZQ=='}},
      ],
    },
    role: 'assistant',
    length: 1,
    warning: 'Image data is not supported in Claude for assistant turns.',
  },
  {
    name: 'user_role_with_text_and_document',
    content: {
      role: 'user',
      parts: [
        {text: 'Summarize this document.'},
        {inlineData: {mimeType: 'application/pdf', data: 'JVBERi0='}},
      ],
    },
    role: 'user',
    length: 2,
  },
  {
    name: 'model_role_with_text_and_document',
    content: {
      role: 'model',
      parts: [
        {text: 'Here is the summary.'},
        {inlineData: {mimeType: 'application/pdf', data: 'JVBERi0='}},
      ],
    },
    role: 'assistant',
    length: 1,
    warning: 'PDF data is not supported in Claude for assistant turns.',
  },
];

describe('contentToMessageParam', () => {
  it.each(contentCases)('$name', ({content, role, length, warning}) => {
    const result = contentToMessageParam(content);
    expect(result.role).toBe(role);
    expect(result.content).toHaveLength(length);
    if (warning) {
      expect(warnSpy).toHaveBeenCalledWith(warning);
      expect(warnSpy).toHaveBeenCalledTimes(1);
    } else {
      expect(warnSpy).not.toHaveBeenCalled();
    }
  });

  it('handles content with no parts', () => {
    const result = contentToMessageParam({role: 'user'});
    expect(result.role).toBe('user');
    expect(result.content).toEqual([]);
  });
});

describe('contentBlockToPart', () => {
  it('maps a thinking block', () => {
    const part = contentBlockToPart({
      thinking: 'Let me reason about this.',
      signature: 'sig_abc123',
      type: 'thinking',
    });
    expect(part.text).toBe('Let me reason about this.');
    expect(part.thought).toBe(true);
    expect(part.thoughtSignature).toBe('sig_abc123');
  });

  it('maps a thinking block without a signature', () => {
    const part = contentBlockToPart({
      thinking: 'no sig',
      signature: '',
      type: 'thinking',
    });
    expect(part.text).toBe('no sig');
    expect(part.thought).toBe(true);
    expect(part.thoughtSignature).toBeUndefined();
  });

  it('maps a redacted thinking block', () => {
    const part = contentBlockToPart({
      data: 'redacted_data',
      type: 'redacted_thinking',
    });
    expect(part.thought).toBe(true);
    expect(part.text).toBeUndefined();
    expect(part.thoughtSignature).toBe('redacted_data');
  });

  it('maps a text block', () => {
    const part = contentBlockToPart({
      text: 'Hello.',
      type: 'text',
      citations: null,
    });
    expect(part.text).toBe('Hello.');
    expect(part.thought).not.toBe(true);
  });

  it('maps a tool_use block', () => {
    const part = contentBlockToPart({
      id: 'toolu_1',
      name: 'get_weather',
      input: {city: 'Paris'},
      type: 'tool_use',
      caller: {type: 'direct'},
    });
    expect(part.functionCall).toEqual({
      id: 'toolu_1',
      name: 'get_weather',
      args: {city: 'Paris'},
    });
  });

  it('throws for an unsupported block type', () => {
    expect(() =>
      contentBlockToPart({
        type: 'server_tool_use',
      } as unknown as Parameters<typeof contentBlockToPart>[0]),
    ).toThrow('Unsupported content block type');
  });
});

describe('messageToGenerateContentResponse', () => {
  it('maps thinking + redacted + text into three parts', () => {
    const response = messageToGenerateContentResponse({
      id: 'msg',
      content: [
        {thinking: 'I need to think.', signature: 'sig_xyz', type: 'thinking'},
        {data: 'hidden', type: 'redacted_thinking'},
        {text: 'Here is my answer.', type: 'text', citations: null},
      ],
      model: 'claude-sonnet-4-20250514',
      role: 'assistant',
      stop_reason: 'end_turn',
      stop_sequence: null,
      type: 'message',
      usage: {input_tokens: 10, output_tokens: 20},
    } as unknown as Parameters<typeof messageToGenerateContentResponse>[0]);

    const parts = response.content!.parts!;
    expect(parts).toHaveLength(3);
    expect(parts[0].thought).toBe(true);
    expect(parts[0].thoughtSignature).toBe('sig_xyz');
    expect(parts[1].thought).toBe(true);
    expect(parts[1].text).toBeUndefined();
    expect(parts[1].thoughtSignature).toBe('hidden');
    expect(parts[2].text).toBe('Here is my answer.');
    expect(response.finishReason).toBe(FinishReason.STOP);
  });

  it('maps cache_read_input_tokens to cachedContentTokenCount', () => {
    const response = messageToGenerateContentResponse({
      id: 'msg',
      content: [{text: 'hi', type: 'text', citations: null}],
      model: 'm',
      role: 'assistant',
      stop_reason: 'end_turn',
      stop_sequence: null,
      type: 'message',
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        cache_read_input_tokens: 75,
      },
    } as unknown as Parameters<typeof messageToGenerateContentResponse>[0]);
    expect(response.usageMetadata!.cachedContentTokenCount).toBe(75);
    expect(response.usageMetadata!.totalTokenCount).toBe(120);
  });

  it('leaves cachedContentTokenCount undefined when absent', () => {
    const response = messageToGenerateContentResponse({
      id: 'msg',
      content: [{text: 'hi', type: 'text', citations: null}],
      model: 'm',
      role: 'assistant',
      stop_reason: 'end_turn',
      stop_sequence: null,
      type: 'message',
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        cache_read_input_tokens: null,
      },
    } as unknown as Parameters<typeof messageToGenerateContentResponse>[0]);
    expect(response.usageMetadata!.cachedContentTokenCount).toBeUndefined();
  });
});

describe('buildAnthropicThinkingParam via non-streaming requests', () => {
  it('enables thinking with a positive budget', async () => {
    hoisted.create.mockResolvedValue(makeMessage('ok'));
    const llm = new AnthropicLlm({model: 'claude-sonnet-4-20250514'});
    await collect(
      llm.generateContentAsync(
        makeRequest([{role: 'user', parts: [{text: 'Think'}]}], {
          systemInstruction: 'Test',
          thinkingConfig: {thinkingBudget: 8000},
        }),
      ),
    );
    expect(createKwargs()['thinking']).toEqual({
      type: 'enabled',
      budget_tokens: 8000,
    });
  });

  it('omits thinking when no thinking config is present', async () => {
    hoisted.create.mockResolvedValue(makeMessage('ok'));
    const llm = new AnthropicLlm({model: 'claude-sonnet-4-20250514'});
    await collect(
      llm.generateContentAsync(
        makeRequest([{role: 'user', parts: [{text: 'Hi'}]}], {
          systemInstruction: 'Test',
        }),
      ),
    );
    expect(createKwargs()['thinking']).toBeUndefined();
  });

  it('disables thinking for a zero budget', async () => {
    hoisted.create.mockResolvedValue(makeMessage('ok'));
    const llm = new AnthropicLlm({model: 'claude-sonnet-4-20250514'});
    await collect(
      llm.generateContentAsync(
        makeRequest([{role: 'user', parts: [{text: 'Hi'}]}], {
          thinkingConfig: {thinkingBudget: 0},
        }),
      ),
    );
    expect(createKwargs()['thinking']).toEqual({type: 'disabled'});
  });

  it.each([-1, -5])('uses adaptive thinking for budget %s', async (budget) => {
    hoisted.create.mockResolvedValue(makeMessage('ok'));
    const llm = new AnthropicLlm({model: 'claude-sonnet-4-20250514'});
    await collect(
      llm.generateContentAsync(
        makeRequest([{role: 'user', parts: [{text: 'Hi'}]}], {
          thinkingConfig: {thinkingBudget: budget},
        }),
      ),
    );
    expect(createKwargs()['thinking']).toEqual({type: 'adaptive'});
  });

  it('throws when a thinking config lacks an explicit budget', async () => {
    hoisted.create.mockResolvedValue(makeMessage('ok'));
    const llm = new AnthropicLlm({model: 'claude-sonnet-4-20250514'});
    await expect(
      collect(
        llm.generateContentAsync(
          makeRequest([{role: 'user', parts: [{text: 'Hi'}]}], {
            thinkingConfig: {},
          }),
        ),
      ),
    ).rejects.toThrow('thinkingBudget must be set explicitly');
  });
});

describe('non-streaming generateContentAsync', () => {
  it('yields a single response with the model text', async () => {
    hoisted.create.mockResolvedValue(makeMessage('Hello, how can I help you?'));
    const llm = new Claude({
      model: 'claude-3-5-sonnet-v2@20241022',
      project: 'p',
      location: 'l',
    });
    const responses = await collect(
      llm.generateContentAsync(
        makeRequest(
          [{role: 'user', parts: [{text: 'Hello'}]}],
          {systemInstruction: 'You are a helpful assistant'},
          'claude-3-5-sonnet-v2@20241022',
        ),
      ),
    );
    expect(responses).toHaveLength(1);
    expect(responses[0].content!.parts![0].text).toBe(
      'Hello, how can I help you?',
    );
    expect(responses[0].finishReason).toBe(FinishReason.STOP);
  });

  it('works with the direct Anthropic backend', async () => {
    hoisted.create.mockResolvedValue(makeMessage('Hello, how can I help you?'));
    const llm = new AnthropicLlm({model: 'claude-sonnet-4-20250514'});
    const responses = await collect(
      llm.generateContentAsync(
        makeRequest([{role: 'user', parts: [{text: 'Hi'}]}]),
      ),
    );
    expect(responses[0].content!.parts![0].text).toBe(
      'Hello, how can I help you?',
    );
    expect(hoisted.anthropicCtor).toHaveBeenCalledTimes(1);
  });

  it('defaults max_tokens to 8192', async () => {
    hoisted.create.mockResolvedValue(makeMessage('ok'));
    const llm = new AnthropicLlm({model: 'claude-sonnet-4-20250514'});
    await collect(
      llm.generateContentAsync(
        makeRequest([{role: 'user', parts: [{text: 'Hi'}]}]),
      ),
    );
    expect(createKwargs()['max_tokens']).toBe(8192);
  });

  it('honors a custom maxTokens', async () => {
    hoisted.create.mockResolvedValue(makeMessage('ok'));
    const llm = new Claude({
      model: 'claude-3-5-sonnet-v2@20241022',
      maxTokens: 4096,
      project: 'p',
      location: 'l',
    });
    await collect(
      llm.generateContentAsync(
        makeRequest([{role: 'user', parts: [{text: 'Hi'}]}]),
      ),
    );
    expect(createKwargs()['max_tokens']).toBe(4096);
  });

  it('forwards generation config and does not pass stream', async () => {
    hoisted.create.mockResolvedValue(makeMessage('ok'));
    const llm = new AnthropicLlm({model: 'claude-sonnet-4-20250514'});
    await collect(
      llm.generateContentAsync(
        makeRequest([{role: 'user', parts: [{text: 'Hello'}]}], {
          temperature: 0.7,
          topP: 0.9,
          topK: 50,
          stopSequences: ['##'],
          maxOutputTokens: 1024,
        }),
      ),
    );
    const kwargs = createKwargs();
    expect(kwargs['temperature']).toBe(0.7);
    expect(kwargs['top_p']).toBe(0.9);
    expect(kwargs['top_k']).toBe(50);
    expect(kwargs['stop_sequences']).toEqual(['##']);
    expect(kwargs['max_tokens']).toBe(1024);
    expect('stream' in kwargs).toBe(false);
  });

  it('omits system when no system instruction is set', async () => {
    hoisted.create.mockResolvedValue(makeMessage('ok'));
    const llm = new AnthropicLlm({model: 'claude-sonnet-4-20250514'});
    await collect(
      llm.generateContentAsync(
        makeRequest([{role: 'user', parts: [{text: 'Hi'}]}]),
      ),
    );
    expect(createKwargs()['system']).toBeUndefined();
  });

  it('sets tool_choice auto when tools are registered', async () => {
    hoisted.create.mockResolvedValue(makeMessage('ok'));
    const llm = new AnthropicLlm({model: 'claude-sonnet-4-20250514'});
    const request = makeRequest([{role: 'user', parts: [{text: 'Hi'}]}], {
      tools: [
        {functionDeclarations: [{name: 'do_it', description: 'does it'}]},
      ],
    });
    request.toolsDict = {
      do_it: {name: 'do_it'} as unknown as LlmRequest['toolsDict'][string],
    };
    await collect(llm.generateContentAsync(request));
    const kwargs = createKwargs();
    expect(kwargs['tool_choice']).toEqual({type: 'auto'});
    expect(kwargs['tools']).toHaveLength(1);
  });

  it('omits tools when the tools list is empty', async () => {
    hoisted.create.mockResolvedValue(makeMessage('ok'));
    const llm = new AnthropicLlm({model: 'claude-sonnet-4-20250514'});
    await collect(
      llm.generateContentAsync(
        makeRequest([{role: 'user', parts: [{text: 'Hi'}]}], {tools: []}),
      ),
    );
    const kwargs = createKwargs();
    expect(kwargs['tools']).toBeUndefined();
    expect(kwargs['tool_choice']).toBeUndefined();
  });

  it('resolves a full resource-name model string', async () => {
    hoisted.create.mockResolvedValue(makeMessage('ok'));
    const llm = new AnthropicLlm({model: 'claude-sonnet-4-20250514'});
    await collect(
      llm.generateContentAsync(
        makeRequest(
          [{role: 'user', parts: [{text: 'Hi'}]}],
          undefined,
          'projects/p/locations/l/publishers/anthropic/models/claude-3-5-sonnet-v2@20241022',
        ),
      ),
    );
    expect(createKwargs()['model']).toBe('claude-3-5-sonnet-v2@20241022');
  });

  it('resolves an endpoints resource-name model string', async () => {
    hoisted.create.mockResolvedValue(makeMessage('ok'));
    const llm = new AnthropicLlm({model: 'claude-sonnet-4-20250514'});
    await collect(
      llm.generateContentAsync(
        makeRequest(
          [{role: 'user', parts: [{text: 'Hi'}]}],
          undefined,
          'projects/p/locations/l/endpoints/my-endpoint',
        ),
      ),
    );
    expect(createKwargs()['model']).toBe('my-endpoint');
  });

  it('leaves a non-matching projects/ model string unchanged', async () => {
    hoisted.create.mockResolvedValue(makeMessage('ok'));
    const llm = new AnthropicLlm({model: 'claude-sonnet-4-20250514'});
    await collect(
      llm.generateContentAsync(
        makeRequest(
          [{role: 'user', parts: [{text: 'Hi'}]}],
          undefined,
          'projects/only',
        ),
      ),
    );
    expect(createKwargs()['model']).toBe('projects/only');
  });

  it('falls back to the instance model when the request has none', async () => {
    hoisted.create.mockResolvedValue(makeMessage('ok'));
    const llm = new AnthropicLlm({model: 'claude-sonnet-4-20250514'});
    const request: LlmRequest = {
      contents: [{role: 'user', parts: [{text: 'Hi'}]}],
      liveConnectConfig: {},
      toolsDict: {},
    };
    await collect(llm.generateContentAsync(request));
    expect(createKwargs()['model']).toBe('claude-sonnet-4-20250514');
  });

  it('handles a request with no contents', async () => {
    hoisted.create.mockResolvedValue(makeMessage('ok'));
    const llm = new AnthropicLlm({model: 'claude-sonnet-4-20250514'});
    const request = {
      contents: undefined,
      liveConnectConfig: {},
      toolsDict: {},
    } as unknown as LlmRequest;
    await collect(llm.generateContentAsync(request));
    expect(createKwargs()['messages']).toEqual([]);
  });
});

describe('effort and sampling exclusion', () => {
  it('maps effort to output_config and omits thinking', async () => {
    hoisted.create.mockResolvedValue(makeMessage('ok'));
    const llm = new AnthropicLlm({model: 'claude-sonnet-4-20250514'});
    const config: AnthropicGenerateContentConfig = {effort: 'xhigh'};
    await collect(
      llm.generateContentAsync(
        makeRequest([{role: 'user', parts: [{text: 'Hi'}]}], config),
      ),
    );
    const kwargs = createKwargs();
    expect(kwargs['output_config']).toEqual({effort: 'xhigh'});
    expect(kwargs['thinking']).toBeUndefined();
  });

  it('warns and ignores the standard thinking_level', async () => {
    hoisted.create.mockResolvedValue(makeMessage('ok'));
    const llm = new AnthropicLlm({model: 'claude-sonnet-4-20250514'});
    await collect(
      llm.generateContentAsync(
        makeRequest([{role: 'user', parts: [{text: 'Hi'}]}], {
          thinkingConfig: {
            thinkingBudget: -1,
            thinkingLevel: 'MINIMAL' as ThinkingLevel,
          },
        }),
      ),
    );
    const kwargs = createKwargs();
    expect(kwargs['thinking']).toEqual({type: 'adaptive'});
    expect('output_config' in kwargs).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        'Standard thinking_config.thinking_level is not supported',
      ),
    );
  });

  it('excludes sampling params when thinking is enabled', async () => {
    hoisted.create.mockResolvedValue(makeMessage('ok'));
    const llm = new AnthropicLlm({model: 'claude-sonnet-4-20250514'});
    await collect(
      llm.generateContentAsync(
        makeRequest([{role: 'user', parts: [{text: 'Hi'}]}], {
          temperature: 0.7,
          topP: 0.9,
          topK: 50,
          thinkingConfig: {thinkingBudget: 1024},
        }),
      ),
    );
    const kwargs = createKwargs();
    expect('temperature' in kwargs).toBe(false);
    expect('top_p' in kwargs).toBe(false);
    expect('top_k' in kwargs).toBe(false);
    expect(kwargs['max_tokens']).toBe(8192);
    expect(kwargs['thinking']).toEqual({type: 'enabled', budget_tokens: 1024});
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Sampling parameters'),
    );
  });

  it('excludes sampling params when effort is set', async () => {
    hoisted.create.mockResolvedValue(makeMessage('ok'));
    const llm = new AnthropicLlm({model: 'claude-sonnet-4-20250514'});
    const config: AnthropicGenerateContentConfig = {
      temperature: 0.7,
      topP: 0.9,
      topK: 50,
      effort: 'xhigh',
    };
    await collect(
      llm.generateContentAsync(
        makeRequest([{role: 'user', parts: [{text: 'Hi'}]}], config),
      ),
    );
    const kwargs = createKwargs();
    expect('temperature' in kwargs).toBe(false);
    expect('top_p' in kwargs).toBe(false);
    expect('top_k' in kwargs).toBe(false);
    expect(kwargs['output_config']).toEqual({effort: 'xhigh'});
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Sampling parameters'),
    );
  });

  it('ignores thinking_level on an Anthropic config without effort', async () => {
    hoisted.create.mockResolvedValue(makeMessage('ok'));
    const llm = new AnthropicLlm({model: 'claude-sonnet-4-20250514'});
    const config: AnthropicGenerateContentConfig = {
      effort: undefined,
      thinkingConfig: {
        thinkingBudget: -1,
        thinkingLevel: 'MINIMAL' as ThinkingLevel,
      },
    };
    await collect(
      llm.generateContentAsync(
        makeRequest([{role: 'user', parts: [{text: 'Hi'}]}], config),
      ),
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        'Standard thinking_config.thinking_level is not supported',
      ),
    );
  });
});

describe('createAnthropicGenerateContentConfig', () => {
  it('throws when thinkingLevel is set', () => {
    expect(() =>
      createAnthropicGenerateContentConfig({
        effort: 'xhigh',
        thinkingConfig: {
          thinkingBudget: -1,
          thinkingLevel: 'MINIMAL' as ThinkingLevel,
        },
      }),
    ).toThrow('thinkingLevel is not supported');
  });

  it('returns the config when valid', () => {
    const config: AnthropicGenerateContentConfig = {effort: 'high'};
    expect(createAnthropicGenerateContentConfig(config)).toBe(config);
  });
});

describe('streaming generateContentAsync', () => {
  it('yields partial text chunks and a final aggregate', async () => {
    const events = [
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
    ];
    hoisted.create.mockResolvedValue(makeStream(events));
    const llm = new AnthropicLlm({model: 'claude-sonnet-4-20250514'});
    const responses = await collect(
      llm.generateContentAsync(
        makeRequest([{role: 'user', parts: [{text: 'Hi'}]}], {
          systemInstruction: 'You are helpful',
        }),
        true,
      ),
    );

    expect(responses).toHaveLength(3);
    expect(responses[0].partial).toBe(true);
    expect(responses[0].content!.parts![0].text).toBe('Hello ');
    expect(responses[1].partial).toBe(true);
    expect(responses[1].content!.parts![0].text).toBe('world!');
    expect(responses[2].partial).toBe(false);
    expect(responses[2].content!.parts![0].text).toBe('Hello world!');
    expect(responses[2].usageMetadata!.promptTokenCount).toBe(10);
    expect(responses[2].usageMetadata!.candidatesTokenCount).toBe(5);
    expect(responses[2].finishReason).toBe(FinishReason.STOP);
    expect(createKwargs()['stream']).toBe(true);
  });

  it('accumulates streamed tool_use arguments', async () => {
    const events = [
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
        delta: {type: 'input_json_delta', partial_json: '{"city": "Paris"}'},
      },
      {type: 'content_block_stop', index: 1},
      {
        type: 'message_delta',
        delta: {stop_reason: 'tool_use'},
        usage: {output_tokens: 12},
      },
      {type: 'message_stop'},
    ];
    hoisted.create.mockResolvedValue(makeStream(events));
    const llm = new AnthropicLlm({model: 'claude-sonnet-4-20250514'});
    const responses = await collect(
      llm.generateContentAsync(
        makeRequest([{role: 'user', parts: [{text: 'Weather?'}]}], {
          systemInstruction: 'You are helpful',
        }),
        true,
      ),
    );

    expect(responses).toHaveLength(2);
    const final = responses[responses.length - 1];
    expect(final.partial).toBe(false);
    expect(final.content!.parts).toHaveLength(2);
    expect(final.content!.parts![0].text).toBe('Checking.');
    expect(final.content!.parts![1].functionCall).toEqual({
      id: 'toolu_abc',
      name: 'get_weather',
      args: {city: 'Paris'},
    });
  });

  it('defaults tool_use args to an empty object when no json streamed', async () => {
    const events = [
      {
        type: 'message_start',
        message: {usage: {input_tokens: 3, output_tokens: 0}},
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
    ];
    hoisted.create.mockResolvedValue(makeStream(events));
    const llm = new AnthropicLlm({model: 'claude-sonnet-4-20250514'});
    const responses = await collect(
      llm.generateContentAsync(
        makeRequest([{role: 'user', parts: [{text: 'Hi'}]}]),
        true,
      ),
    );
    const final = responses[responses.length - 1];
    expect(final.content!.parts![0].functionCall).toEqual({
      id: 'toolu_x',
      name: 'noop',
      args: {},
    });
  });

  it('yields thinking partials and forwards the thinking param', async () => {
    const events = [
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
    ];
    hoisted.create.mockResolvedValue(makeStream(events));
    const llm = new AnthropicLlm({model: 'claude-sonnet-4-20250514'});
    const responses = await collect(
      llm.generateContentAsync(
        makeRequest([{role: 'user', parts: [{text: 'What?'}]}], {
          thinkingConfig: {thinkingBudget: 5000},
        }),
        true,
      ),
    );

    expect(responses).toHaveLength(4);
    expect(responses[0].content!.parts![0].thought).toBe(true);
    expect(responses[0].content!.parts![0].text).toBe('Step 1: ');
    expect(responses[1].content!.parts![0].text).toBe('analyze.');
    expect(responses[2].content!.parts![0].text).toBe('The answer is 42.');
    const final = responses[3];
    expect(final.content!.parts).toHaveLength(2);
    expect(final.content!.parts![0].text).toBe('Step 1: analyze.');
    expect(final.content!.parts![1].text).toBe('The answer is 42.');
    expect(createKwargs()['thinking']).toEqual({
      type: 'enabled',
      budget_tokens: 5000,
    });
    expect(createKwargs()['stream']).toBe(true);
  });

  it('captures a streamed signature delta and round-trips it', async () => {
    const events = [
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
        delta: {type: 'thinking_delta', thinking: 'Reason.'},
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: {type: 'signature_delta', signature: 'sig_stream_123'},
      },
      {type: 'content_block_stop', index: 0},
      {
        type: 'message_delta',
        delta: {stop_reason: 'end_turn'},
        usage: {output_tokens: 5},
      },
      {type: 'message_stop'},
    ];
    hoisted.create.mockResolvedValue(makeStream(events));
    const llm = new AnthropicLlm({model: 'claude-sonnet-4-20250514'});
    const responses = await collect(
      llm.generateContentAsync(
        makeRequest([{role: 'user', parts: [{text: 'What?'}]}], {
          thinkingConfig: {thinkingBudget: 5000},
        }),
        true,
      ),
    );

    const final = responses[responses.length - 1];
    const thinkingPart = final.content!.parts![0];
    expect(thinkingPart.thought).toBe(true);
    expect(thinkingPart.text).toBe('Reason.');
    expect(thinkingPart.thoughtSignature).toBe('sig_stream_123');

    const block = partToMessageBlock(thinkingPart) as unknown as Block;
    expect(block['type']).toBe('thinking');
    expect(block['signature']).toBe('sig_stream_123');
  });

  it('preserves a redacted-thinking block in the final response', async () => {
    const events = [
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
    ];
    hoisted.create.mockResolvedValue(makeStream(events));
    const llm = new AnthropicLlm({model: 'claude-sonnet-4-20250514'});
    const responses = await collect(
      llm.generateContentAsync(
        makeRequest([{role: 'user', parts: [{text: 'Hi'}]}], {
          thinkingConfig: {thinkingBudget: 3000},
        }),
        true,
      ),
    );

    const final = responses[responses.length - 1];
    expect(final.content!.parts).toHaveLength(2);
    expect(final.content!.parts![0].thought).toBe(true);
    expect(final.content!.parts![0].text).toBeUndefined();
    expect(final.content!.parts![0].thoughtSignature).toBe('encrypted_blob');
    expect(final.content!.parts![1].text).toBe('Done.');
  });

  it('omits system on the streaming path when absent', async () => {
    const events = [
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
    ];
    hoisted.create.mockResolvedValue(makeStream(events));
    const llm = new AnthropicLlm({model: 'claude-sonnet-4-20250514'});
    await collect(
      llm.generateContentAsync(
        makeRequest([{role: 'user', parts: [{text: 'Hi'}]}]),
        true,
      ),
    );
    expect(createKwargs()['system']).toBeUndefined();
  });

  it('reports cached tokens from the message_start usage', async () => {
    const events = [
      {
        type: 'message_start',
        message: {
          usage: {
            input_tokens: 30,
            output_tokens: 0,
            cache_read_input_tokens: 12,
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
        delta: {type: 'text_delta', text: 'ok'},
      },
      {type: 'content_block_stop', index: 0},
      {
        type: 'message_delta',
        delta: {stop_reason: 'end_turn'},
        usage: {output_tokens: 2},
      },
      {type: 'message_stop'},
    ];
    hoisted.create.mockResolvedValue(makeStream(events));
    const llm = new AnthropicLlm({model: 'claude-sonnet-4-20250514'});
    const responses = await collect(
      llm.generateContentAsync(
        makeRequest([{role: 'user', parts: [{text: 'Hi'}]}]),
        true,
      ),
    );
    expect(
      responses[responses.length - 1].usageMetadata!.cachedContentTokenCount,
    ).toBe(12);
  });

  it('handles a text delta without a block start', async () => {
    const events = [
      {
        type: 'message_start',
        message: {usage: {input_tokens: 2, output_tokens: 0}},
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: {type: 'text_delta', text: 'Hi'},
      },
      {
        type: 'message_delta',
        delta: {stop_reason: 'end_turn'},
        usage: {output_tokens: 1},
      },
      {type: 'message_stop'},
    ];
    hoisted.create.mockResolvedValue(makeStream(events));
    const llm = new AnthropicLlm({model: 'claude-sonnet-4-20250514'});
    const responses = await collect(
      llm.generateContentAsync(
        makeRequest([{role: 'user', parts: [{text: 'Hi'}]}]),
        true,
      ),
    );
    expect(responses[responses.length - 1].content!.parts![0].text).toBe('Hi');
  });

  it('handles thinking and signature deltas without a block start', async () => {
    const events = [
      {
        type: 'message_start',
        message: {usage: {input_tokens: 4, output_tokens: 0}},
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: {type: 'thinking_delta', thinking: 'Reason.'},
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: {type: 'signature_delta', signature: 'late_sig'},
      },
      {
        type: 'message_delta',
        delta: {stop_reason: 'end_turn'},
        usage: {output_tokens: 2},
      },
      {type: 'message_stop'},
    ];
    hoisted.create.mockResolvedValue(makeStream(events));
    const llm = new AnthropicLlm({model: 'claude-sonnet-4-20250514'});
    const responses = await collect(
      llm.generateContentAsync(
        makeRequest([{role: 'user', parts: [{text: 'Hi'}]}], {
          thinkingConfig: {thinkingBudget: 1024},
        }),
        true,
      ),
    );
    const final = responses[responses.length - 1];
    expect(final.content!.parts![0].text).toBe('Reason.');
    expect(final.content!.parts![0].thoughtSignature).toBe('late_sig');
  });
});

interface ToolIdCase {
  name: string;
  callIds: Array<string | null>;
  responseIds: Array<string | null>;
  unique: number;
}

const toolIdCases: ToolIdCase[] = [
  {
    name: 'distinct_invalid_pair_uniquely',
    callIds: ['bad A!', 'bad B!'],
    responseIds: ['bad A!', 'bad B!'],
    unique: 2,
  },
  {
    name: 'matching_empty_ids_pair',
    callIds: [''],
    responseIds: [''],
    unique: 1,
  },
  {
    name: 'none_and_empty_collapse',
    callIds: [null],
    responseIds: [''],
    unique: 1,
  },
  {
    name: 'repeated_invalid_id_consistent',
    callIds: ['bad!'],
    responseIds: ['bad!'],
    unique: 1,
  },
];

describe('tool-id pairing across a request', () => {
  it.each(toolIdCases)('$name', async ({callIds, responseIds, unique}) => {
    hoisted.create.mockResolvedValue(makeMessage('ok'));
    const llm = new AnthropicLlm({model: 'claude-sonnet-4-20250514'});
    const contents: Content[] = [
      {role: 'user', parts: [{text: 'Hi'}]},
      {
        role: 'model',
        parts: callIds.map((id, i) => ({
          functionCall: {id: id ?? undefined, name: `tool_${i}`, args: {}},
        })),
      },
      {
        role: 'user',
        parts: responseIds.map((id, i) => ({
          functionResponse: {
            id: id ?? undefined,
            name: `tool_${i}`,
            response: {result: 'ok'},
          },
        })),
      },
    ];

    await collect(llm.generateContentAsync(makeRequest(contents)));

    const messages = createKwargs()['messages'] as Array<{content: Block[]}>;
    const useIds = messages[1].content
      .filter((b) => b['type'] === 'tool_use')
      .map((b) => b['id'] as string);
    const resultIds = messages[2].content
      .filter((b) => b['type'] === 'tool_result')
      .map((b) => b['tool_use_id'] as string);

    expect(new Set(useIds).size).toBe(unique);
    expect(new Set(useIds)).toEqual(new Set(resultIds));
  });
});

describe('connect', () => {
  it('throws because Anthropic has no live API', async () => {
    const llm = new AnthropicLlm({model: 'claude-sonnet-4-20250514'});
    await expect(
      llm.connect(makeRequest([{role: 'user', parts: [{text: 'Hi'}]}])),
    ).rejects.toThrow('Live connection is not supported for Anthropic models.');
  });
});
