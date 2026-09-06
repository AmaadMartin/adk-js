/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tests for the paths adk-python's `test_experimental_semconv.py` does not
 * cover: the two config-dependent setters, redaction, value normalization, tool
 * resolution, and one emission through the real OpenTelemetry providers.
 *
 * The verbatim port of that reference file lives beside this one in
 * `_experimental_semconv_test.ts`.
 */

import {LlmRequest} from '@google/adk';
import {Type} from '@google/genai';
import {context, Span, trace} from '@opentelemetry/api';
import type {AnyValueMap, LogRecord} from '@opentelemetry/api-logs';
import {
  InMemoryLogRecordExporter,
  LoggerProvider,
  SimpleLogRecordProcessor,
} from '@opentelemetry/sdk-logs';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import {afterEach, describe, expect, it, vi} from 'vitest';

import {
  COMPLETION_DETAILS_EVENT_NAME,
  ExperimentalSemconvConfig,
  ExtendedUsageMetadata,
  maybeLogCompletionDetails,
  resolveToolDefinitions,
  setOperationDetailsAttributesFromRequest,
  setOperationDetailsAttributesFromResponse,
  setOperationDetailsCommonAttributes,
  toAnyValue,
  toolDefinitionFromDumpedTool,
} from '../../src/telemetry/_experimental_semconv.js';
import {logger} from '../../src/utils/logger.js';

const GEN_AI_INPUT_MESSAGES = 'gen_ai.input.messages';
const GEN_AI_OUTPUT_MESSAGES = 'gen_ai.output.messages';
const GEN_AI_SYSTEM_INSTRUCTIONS = 'gen_ai.system_instructions';
const GEN_AI_TOOL_DEFINITIONS = 'gen_ai.tool.definitions';

/** A config with every capture flag off. */
function config(
  overrides: Partial<ExperimentalSemconvConfig> = {},
): ExperimentalSemconvConfig {
  return {
    shouldUseExperimentalGenaiSemconv: true,
    shouldAddContentToLogs: false,
    shouldAddContentToExperimentalSpans: false,
    ...overrides,
  };
}

function llmRequest(overrides: Partial<LlmRequest> = {}): LlmRequest {
  return {
    model: 'some-model',
    contents: [],
    liveConnectConfig: {},
    toolsDict: {},
    ...overrides,
  };
}

/** Collects what a logger was asked to emit, with no OTel SDK involved. */
class RecordingLogger {
  readonly records: LogRecord[] = [];

  emit(logRecord: LogRecord): void {
    this.records.push(logRecord);
  }
}

/** A span that records the attributes set on it. */
function recordingSpan(): {span: Span; attributes: Record<string, unknown>} {
  const attributes: Record<string, unknown> = {};
  const tracer = new BasicTracerProvider().getTracer('test');
  const span = tracer.startSpan('test-span');
  const setAttribute = span.setAttribute.bind(span);
  span.setAttribute = (key: string, value: never) => {
    attributes[key] = value;
    return setAttribute(key, value);
  };
  return {span, attributes};
}

/** The details map produced by one declared function tool. */
function toolDetails(): AnyValueMap {
  const attributes: AnyValueMap = {};
  setOperationDetailsAttributesFromRequest(
    attributes,
    llmRequest({
      config: {
        tools: [
          {
            functionDeclarations: [
              {
                name: 'get_weather',
                description: 'Gets the weather.',
                parameters: {type: Type.OBJECT},
              },
            ],
            googleSearch: {},
          },
        ],
      },
      contents: [{role: 'user', parts: [{text: 'secret question'}]}],
    }),
  );
  return attributes;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('setOperationDetailsCommonAttributes', () => {
  it('copies the attributes into the common map', () => {
    const common: AnyValueMap = {'pre.existing': 'kept'};

    setOperationDetailsCommonAttributes(common, config(), {'a': 1});

    expect(common).toEqual({'pre.existing': 'kept', 'a': 1});
  });

  it('adds the log-only attributes when content goes to the logs', () => {
    const common: AnyValueMap = {};

    setOperationDetailsCommonAttributes(
      common,
      config({shouldAddContentToLogs: true}),
      {'a': 1},
      {'b': 2},
    );

    expect(common).toEqual({'a': 1, 'b': 2});
  });

  it('drops the log-only attributes when content stays off the logs', () => {
    const common: AnyValueMap = {};

    setOperationDetailsCommonAttributes(common, config(), {'a': 1}, {'b': 2});

    expect(common).toEqual({'a': 1});
  });

  it('treats an empty or absent log-only map as nothing to add', () => {
    const fromEmpty: AnyValueMap = {};
    const fromAbsent: AnyValueMap = {};
    const withLogs = config({shouldAddContentToLogs: true});

    setOperationDetailsCommonAttributes(fromEmpty, withLogs, {'a': 1}, {});
    setOperationDetailsCommonAttributes(fromAbsent, withLogs, {'a': 1});

    expect(fromEmpty).toEqual({'a': 1});
    expect(fromAbsent).toEqual({'a': 1});
  });
});

describe('maybeLogCompletionDetails', () => {
  it('emits nothing without a span', () => {
    const otelLogger = new RecordingLogger();

    maybeLogCompletionDetails(
      undefined,
      otelLogger,
      toolDetails(),
      {},
      config({
        shouldAddContentToLogs: true,
        shouldAddContentToExperimentalSpans: true,
      }),
    );

    expect(otelLogger.records).toEqual([]);
  });

  it('emits nothing when the experimental semconv is not opted in', () => {
    const otelLogger = new RecordingLogger();
    const {span, attributes} = recordingSpan();

    maybeLogCompletionDetails(
      span,
      otelLogger,
      toolDetails(),
      {},
      config({
        shouldUseExperimentalGenaiSemconv: false,
        shouldAddContentToLogs: true,
        shouldAddContentToExperimentalSpans: true,
      }),
    );

    expect(otelLogger.records).toEqual([]);
    expect(attributes).toEqual({});
  });

  it('correlates the record with the named span, not the active one', () => {
    const otelLogger = new RecordingLogger();
    const {span} = recordingSpan();
    const {span: activeSpan} = recordingSpan();

    context.with(trace.setSpan(context.active(), activeSpan), () => {
      maybeLogCompletionDetails(span, otelLogger, {}, {}, config());
    });

    expect(otelLogger.records).toHaveLength(1);
    const emitted = otelLogger.records[0];
    expect(emitted.eventName).toBe(COMPLETION_DETAILS_EVENT_NAME);
    const emittedContext = emitted.context;
    if (!emittedContext) {
      expect.fail('expected the emitted record to carry a context');
    }
    expect(trace.getSpan(emittedContext)).toBe(span);
    expect(trace.getSpan(emittedContext)).not.toBe(activeSpan);
  });

  it('keeps content out of the log record when logging is off', () => {
    const otelLogger = new RecordingLogger();
    const {span} = recordingSpan();

    maybeLogCompletionDetails(
      span,
      otelLogger,
      toolDetails(),
      {'gen_ai.request.model': 'some-model'},
      config({shouldAddContentToExperimentalSpans: true}),
    );

    expect(otelLogger.records[0].attributes).toEqual({
      'gen_ai.request.model': 'some-model',
      [GEN_AI_TOOL_DEFINITIONS]: [
        {
          name: 'get_weather',
          description: 'Gets the weather.',
          parameters: null,
          type: 'function',
        },
        {name: 'google_search', type: 'google_search'},
      ],
    });
  });

  it('puts content on the log record when logging is on', () => {
    const otelLogger = new RecordingLogger();
    const {span} = recordingSpan();

    maybeLogCompletionDetails(
      span,
      otelLogger,
      toolDetails(),
      {},
      config({shouldAddContentToLogs: true}),
    );

    expect(otelLogger.records[0].attributes).toEqual(toolDetails());
  });

  it('keeps content off the span while the log record carries it', () => {
    const otelLogger = new RecordingLogger();
    const {span, attributes} = recordingSpan();

    maybeLogCompletionDetails(
      span,
      otelLogger,
      toolDetails(),
      {},
      config({shouldAddContentToLogs: true}),
    );

    expect(otelLogger.records[0].attributes?.[GEN_AI_INPUT_MESSAGES]).toEqual([
      {role: 'user', parts: [{content: 'secret question', type: 'text'}]},
    ]);
    expect(attributes[GEN_AI_INPUT_MESSAGES]).toBeUndefined();
    expect(attributes[GEN_AI_TOOL_DEFINITIONS]).toBe(
      '[{"name":"get_weather","description":"Gets the weather.",' +
        '"parameters":null,"type":"function"},' +
        '{"name":"google_search","type":"google_search"}]',
    );
  });

  it('puts content on the span while the log record omits it', () => {
    const otelLogger = new RecordingLogger();
    const {span, attributes} = recordingSpan();

    maybeLogCompletionDetails(
      span,
      otelLogger,
      toolDetails(),
      {},
      config({shouldAddContentToExperimentalSpans: true}),
    );

    expect(
      otelLogger.records[0].attributes?.[GEN_AI_INPUT_MESSAGES],
    ).toBeUndefined();
    expect(attributes[GEN_AI_INPUT_MESSAGES]).toBe(
      '[{"role":"user","parts":[{"content":"secret question","type":"text"}]}]',
    );
  });

  it('serializes span attributes as JSON with no whitespace', () => {
    const otelLogger = new RecordingLogger();
    const {span, attributes} = recordingSpan();

    maybeLogCompletionDetails(
      span,
      otelLogger,
      toolDetails(),
      {},
      config({shouldAddContentToExperimentalSpans: true}),
    );

    expect(attributes[GEN_AI_SYSTEM_INSTRUCTIONS]).toBe('[]');
    expect(attributes[GEN_AI_INPUT_MESSAGES]).toBe(
      '[{"role":"user","parts":[{"content":"secret question","type":"text"}]}]',
    );
  });

  it('writes <not serializable> for a span attribute it cannot serialize', () => {
    const otelLogger = new RecordingLogger();
    const {span, attributes} = recordingSpan();
    const cyclic: AnyValueMap = {};
    cyclic['self'] = cyclic;

    maybeLogCompletionDetails(
      span,
      otelLogger,
      {
        [GEN_AI_INPUT_MESSAGES]: cyclic,
        [GEN_AI_OUTPUT_MESSAGES]: undefined,
      },
      {},
      config({shouldAddContentToExperimentalSpans: true}),
    );

    expect(attributes[GEN_AI_INPUT_MESSAGES]).toBe('<not serializable>');
    expect(attributes[GEN_AI_OUTPUT_MESSAGES]).toBe('<not serializable>');
  });
});

describe('the no-content view of the operation details', () => {
  it('keeps a generic definition verbatim and blanks a function schema', () => {
    const otelLogger = new RecordingLogger();
    const {span} = recordingSpan();

    maybeLogCompletionDetails(
      span,
      otelLogger,
      {
        [GEN_AI_TOOL_DEFINITIONS]: [
          {name: 'google_search', type: 'google_search'},
          {name: 'f', description: 5, parameters: {a: 1}, type: 'function'},
        ],
        [GEN_AI_OUTPUT_MESSAGES]: [{role: 'assistant', parts: []}],
      },
      {},
      config(),
    );

    expect(otelLogger.records[0].attributes).toEqual({
      [GEN_AI_TOOL_DEFINITIONS]: [
        {name: 'google_search', type: 'google_search'},
        {name: 'f', description: null, parameters: null, type: 'function'},
      ],
    });
  });

  it('drops a definition whose name or type is not a string', () => {
    const otelLogger = new RecordingLogger();
    const {span} = recordingSpan();

    maybeLogCompletionDetails(
      span,
      otelLogger,
      {
        [GEN_AI_TOOL_DEFINITIONS]: [
          {name: 7, type: 'function'},
          {name: 'f', type: 7},
          'not-an-object',
          {name: 'kept', type: 'google_search'},
        ],
      },
      {},
      config(),
    );

    expect(otelLogger.records[0].attributes).toEqual({
      [GEN_AI_TOOL_DEFINITIONS]: [{name: 'kept', type: 'google_search'}],
    });
  });

  it.each([
    {label: 'a non-array value', definitions: 'not-a-list'},
    {label: 'an empty array', definitions: []},
    {label: 'no key at all', definitions: undefined},
  ])('emits nothing for $label', ({definitions}) => {
    const otelLogger = new RecordingLogger();
    const {span} = recordingSpan();

    maybeLogCompletionDetails(
      span,
      otelLogger,
      {[GEN_AI_TOOL_DEFINITIONS]: definitions},
      {'kept': 1},
      config(),
    );

    expect(otelLogger.records[0].attributes).toEqual({'kept': 1});
  });
});

describe('toAnyValue', () => {
  it('passes scalars, null and bytes through', () => {
    const bytes = new Uint8Array([1, 2]);

    expect(toAnyValue('a')).toBe('a');
    expect(toAnyValue(1.5)).toBe(1.5);
    expect(toAnyValue(true)).toBe(true);
    expect(toAnyValue(null)).toBeNull();
    expect(toAnyValue(undefined)).toBeUndefined();
    expect(toAnyValue(bytes)).toBe(bytes);
  });

  it('drops undefined values and keeps an explicit null', () => {
    expect(toAnyValue({a: undefined, b: null, c: 1})).toEqual({b: null, c: 1});
  });

  it('reports a Map as not serializable, like any other class instance', () => {
    expect(toAnyValue(new Map<unknown, unknown>([[1, 'one']]))).toBe(
      '<not serializable>',
    );
  });

  it('reports a cycle rather than throwing', () => {
    const cyclic: Record<string, unknown> = {name: 'root'};
    cyclic['self'] = cyclic;

    expect(toAnyValue(cyclic)).toEqual({
      name: 'root',
      self: '<not serializable>',
    });
  });

  it('normalizes one shared object twice when it is not a cycle', () => {
    const shared = {a: 1};

    expect(toAnyValue([shared, shared])).toEqual([{a: 1}, {a: 1}]);
  });

  it.each([
    {label: 'a function', value: () => 1},
    {label: 'a symbol', value: Symbol('s')},
    {label: 'a class instance', value: new (class Opaque {})()},
    {label: 'a Date', value: new Date(0)},
  ])('reports $label as not serializable', ({value}) => {
    expect(toAnyValue(value)).toBe('<not serializable>');
  });
});

describe('tool resolution', () => {
  it('reports generic tool fields under their snake_case key', () => {
    expect(
      resolveToolDefinitions([{googleSearch: {}, urlContext: {}}]),
    ).toEqual([
      {name: 'google_search', type: 'google_search'},
      {name: 'url_context', type: 'url_context'},
    ]);
  });

  it('names a function declaration that carries none', () => {
    expect(resolveToolDefinitions([{functionDeclarations: [{}]}])).toEqual([
      {
        name: 'FunctionDeclaration',
        description: null,
        parameters: null,
        type: 'function',
      },
    ]);
  });

  it('falls back to the JSON schema when there is no Schema', () => {
    expect(
      resolveToolDefinitions([
        {
          functionDeclarations: [
            {name: 'f', parametersJsonSchema: {type: 'object'}},
          ],
        },
      ]),
    ).toEqual([
      {
        name: 'f',
        description: null,
        parameters: {type: 'object'},
        type: 'function',
      },
    ]);
  });

  it('describes parameters that are not a mapping', () => {
    expect(
      resolveToolDefinitions([
        {functionDeclarations: [{name: 'f', parametersJsonSchema: 'oops'}]},
      ]),
    ).toEqual([
      {
        name: 'f',
        description: null,
        parameters: {
          type: 'object',
          properties: {
            serialization_error: {
              type: 'string',
              description: 'Expected a mapping for parameters, got string',
            },
          },
        },
        type: 'function',
      },
    ]);
  });

  it('ignores a functionDeclarations field that is not a list', () => {
    expect(
      resolveToolDefinitions([{functionDeclarations: 'nonsense'}]),
    ).toEqual([]);
  });

  it('reports a plain function by its name', () => {
    function myTool() {}

    expect(resolveToolDefinitions([myTool, () => 1])).toEqual([
      {name: 'myTool', description: '', parameters: null, type: 'function'},
      {name: 'Function', description: '', parameters: null, type: 'function'},
    ]);
  });

  it('warns about a CallableTool and drops it', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    expect(resolveToolDefinitions([{tool: () => Promise.resolve({})}])).toEqual(
      [],
    );
    expect(warn).toHaveBeenCalledOnce();
  });

  it('reports a tool entry it cannot recognize', () => {
    expect(
      resolveToolDefinitions([{unrelated: 1}, 7, null, Object.create(null)]),
    ).toEqual([
      {name: 'UnserializableTool', type: 'Object'},
      {name: 'UnserializableTool', type: 'number'},
      {name: 'UnserializableTool', type: 'object'},
      {name: 'UnserializableTool', type: 'object'},
    ]);
  });
});

describe('toolDefinitionFromDumpedTool', () => {
  it('labels a descriptor whose name is not a usable string', () => {
    expect(toolDefinitionFromDumpedTool({name: ''})).toEqual({
      name: 'Object',
      description: null,
      parameters: null,
      type: 'function',
    });
  });
});

describe('system instructions', () => {
  it.each([
    {label: 'a single part', systemInstruction: {text: 'Be terse.'}},
    {label: 'a list of parts', systemInstruction: [{text: 'Be terse.'}]},
    {label: 'a list of strings', systemInstruction: ['Be terse.']},
    {
      label: 'a Content',
      systemInstruction: {role: 'user', parts: [{text: 'Be terse.'}]},
    },
  ])('flattens $label to bare parts', ({systemInstruction}) => {
    const attributes: AnyValueMap = {};

    setOperationDetailsAttributesFromRequest(
      attributes,
      llmRequest({config: {systemInstruction}}),
    );

    expect(attributes[GEN_AI_SYSTEM_INSTRUCTIONS]).toEqual([
      {content: 'Be terse.', type: 'text'},
    ]);
  });

  it('emits nothing for an empty instruction', () => {
    const attributes: AnyValueMap = {};

    setOperationDetailsAttributesFromRequest(
      attributes,
      llmRequest({config: {systemInstruction: ''}}),
    );

    expect(attributes[GEN_AI_SYSTEM_INSTRUCTIONS]).toEqual([]);
  });
});

describe('token usage', () => {
  it('emits a reported zero and omits an absent bucket', () => {
    const common: AnyValueMap = {};

    setOperationDetailsAttributesFromResponse(
      {usageMetadata: {promptTokenCount: 0}},
      {},
      common,
    );

    expect(common).toEqual({'gen_ai.usage.input_tokens': 0});
  });

  it('adds tool-use tokens to input and reasoning tokens to output', () => {
    const common: AnyValueMap = {};

    setOperationDetailsAttributesFromResponse(
      {
        usageMetadata: {
          promptTokenCount: 10,
          toolUsePromptTokenCount: 3,
          candidatesTokenCount: 20,
          thoughtsTokenCount: 5,
        },
      },
      {},
      common,
    );

    expect(common).toEqual({
      'gen_ai.usage.input_tokens': 13,
      'gen_ai.usage.output_tokens': 25,
      'gen_ai.usage.reasoning.output_tokens': 5,
    });
  });

  it('reports only output tokens when the prompt count is missing', () => {
    const common: AnyValueMap = {};

    setOperationDetailsAttributesFromResponse(
      {usageMetadata: {candidatesTokenCount: 4}},
      {},
      common,
    );

    expect(common).toEqual({'gen_ai.usage.output_tokens': 4});
  });

  it('reports the two counts genai does not declare', () => {
    const common: AnyValueMap = {};
    // `ExtendedUsageMetadata` is assignable to the field's declared type, so a
    // response can carry the counts adk-python reads defensively.
    const usageMetadata: ExtendedUsageMetadata = {
      promptTokenCount: 1,
      cacheCreationInputTokens: 8,
      systemInstructionTokens: 3,
    };

    setOperationDetailsAttributesFromResponse({usageMetadata}, {}, common);

    expect(common).toEqual({
      'gen_ai.usage.input_tokens': 1,
      'gen_ai.usage.cache_creation.input_tokens': 8,
      'gen_ai.usage.experimental.system_instruction_tokens': 3,
    });
  });

  it('reports tool-use tokens on their own as input tokens', () => {
    const common: AnyValueMap = {};

    setOperationDetailsAttributesFromResponse(
      {usageMetadata: {toolUsePromptTokenCount: 5, thoughtsTokenCount: 2}},
      {},
      common,
    );

    expect(common).toEqual({
      'gen_ai.usage.input_tokens': 5,
      'gen_ai.usage.output_tokens': 2,
      'gen_ai.usage.reasoning.output_tokens': 2,
    });
  });
});

describe('parts with nothing set', () => {
  it('substitutes empty strings and an empty part list', () => {
    const attributes: AnyValueMap = {};

    setOperationDetailsAttributesFromRequest(
      attributes,
      llmRequest({
        contents: [
          {
            role: 'user',
            parts: [{inlineData: {}}, {fileData: {}}, {functionCall: {}}],
          },
          {role: 'user'},
        ],
      }),
    );

    expect(attributes[GEN_AI_INPUT_MESSAGES]).toEqual([
      {
        role: 'user',
        parts: [
          {mime_type: '', data: '', type: 'blob'},
          {mime_type: '', uri: '', type: 'file_data'},
          {id: '2', name: '', arguments: null, type: 'tool_call'},
        ],
      },
      {role: 'user', parts: []},
    ]);
  });

  it('emits no instruction part for a Content that carries none', () => {
    const attributes: AnyValueMap = {};

    setOperationDetailsAttributesFromRequest(
      attributes,
      llmRequest({config: {systemInstruction: {role: 'user'}}}),
    );

    expect(attributes[GEN_AI_SYSTEM_INSTRUCTIONS]).toEqual([]);
  });
});

describe('a tool call argument that is not a plain object', () => {
  it('wraps what it could normalize under a value key', () => {
    class OpaqueArgs {}
    const args: Record<string, unknown> = {city: 'Zurich'};
    Object.setPrototypeOf(args, OpaqueArgs.prototype);
    const attributes: AnyValueMap = {};

    setOperationDetailsAttributesFromRequest(
      attributes,
      llmRequest({
        contents: [
          {
            role: 'user',
            parts: [{functionCall: {name: 'f', args}}],
          },
        ],
      }),
    );

    expect(attributes[GEN_AI_INPUT_MESSAGES]).toEqual([
      {
        role: 'user',
        parts: [
          {
            id: 'f_0',
            name: 'f',
            arguments: {value: '<not serializable>'},
            type: 'tool_call',
          },
        ],
      },
    ]);
  });
});

describe('a tool call with no arguments', () => {
  it('reports null arguments and a synthesized id', () => {
    const attributes: AnyValueMap = {};

    setOperationDetailsAttributesFromRequest(
      attributes,
      llmRequest({
        contents: [
          {
            role: 'model',
            parts: [{functionCall: {name: 'f', args: undefined}}],
          },
          {
            role: 'user',
            parts: [{functionResponse: {name: 'f', response: {value: 1}}}],
          },
        ],
      }),
    );

    expect(attributes[GEN_AI_INPUT_MESSAGES]).toEqual([
      {
        role: 'assistant',
        parts: [{id: 'f_0', name: 'f', arguments: null, type: 'tool_call'}],
      },
      {
        role: 'user',
        parts: [{id: 'f_0', response: {value: 1}, type: 'tool_call_response'}],
      },
    ]);
  });
});

describe('the completion details through the OpenTelemetry SDK', () => {
  it('exports one record correlated with the span, and the span attributes', async () => {
    const logExporter = new InMemoryLogRecordExporter();
    const loggerProvider = new LoggerProvider({
      processors: [new SimpleLogRecordProcessor(logExporter)],
    });
    const spanExporter = new InMemorySpanExporter();
    const tracerProvider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(spanExporter)],
    });
    const span = tracerProvider.getTracer('adk-test').startSpan('call_llm');

    const details: AnyValueMap = {};
    const common: AnyValueMap = {};
    setOperationDetailsAttributesFromRequest(
      details,
      llmRequest({
        contents: [{role: 'user', parts: [{text: 'What is the weather?'}]}],
        config: {systemInstruction: 'Be terse.'},
      }),
    );
    setOperationDetailsAttributesFromResponse(
      {
        content: {role: 'model', parts: [{text: 'Sunny.'}]},
        finishReason: undefined,
        usageMetadata: {promptTokenCount: 6, candidatesTokenCount: 2},
      },
      details,
      common,
    );
    maybeLogCompletionDetails(
      span,
      loggerProvider.getLogger('adk-test'),
      details,
      common,
      config({
        shouldAddContentToLogs: true,
        shouldAddContentToExperimentalSpans: true,
      }),
    );
    span.end();
    await loggerProvider.forceFlush();
    await tracerProvider.forceFlush();

    const [record] = logExporter.getFinishedLogRecords();
    expect(record.eventName).toBe(COMPLETION_DETAILS_EVENT_NAME);
    expect(record.spanContext?.spanId).toBe(span.spanContext().spanId);
    expect(record.attributes['gen_ai.usage.input_tokens']).toBe(6);
    expect(record.attributes['gen_ai.usage.output_tokens']).toBe(2);
    // `@opentelemetry/sdk-logs` 0.205.0 rejects an attribute that is a list of
    // objects, so the message lists this module emits do not reach an exporter
    // through its `LogRecord`. The span below carries them instead.
    expect(record.attributes[GEN_AI_INPUT_MESSAGES]).toBeUndefined();
    expect(record.attributes[GEN_AI_OUTPUT_MESSAGES]).toBeUndefined();

    const [exportedSpan] = spanExporter.getFinishedSpans();
    expect(exportedSpan.attributes[GEN_AI_SYSTEM_INSTRUCTIONS]).toBe(
      '[{"content":"Be terse.","type":"text"}]',
    );
    expect(exportedSpan.attributes[GEN_AI_OUTPUT_MESSAGES]).toBe(
      '[{"role":"assistant","parts":[{"content":"Sunny.","type":"text"}],' +
        '"finish_reason":""}]',
    );

    await loggerProvider.shutdown();
    await tracerProvider.shutdown();
  });
});
