/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AttributeValue,
  Attributes,
  Span,
  SpanContext,
  trace,
} from '@opentelemetry/api';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {
  BaseAgent,
  BaseTool,
  ContentCapturingMode,
  Event,
  InvocationContext,
  LlmRequest,
  LlmResponse,
  Session,
  TelemetryConfig,
  createEventActions,
  createTelemetryConfig,
} from '@google/adk';
import {
  traceAgentInvocation,
  traceCallLlm,
  traceMergedToolCalls,
  traceSendData,
  traceToolCall,
} from '../../src/telemetry/tracing.js';

vi.hoisted(() => {
  vi.resetModules();
});
vi.mock('@opentelemetry/api');

describe('Telemetry Tracing Functions', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockSpan: any;
  let mockAgent: BaseAgent;
  let mockInvocationContext: InvocationContext;
  let mockTool: BaseTool;
  let mockEvent: Event;
  let mockLlmRequest: LlmRequest;
  let mockLlmResponse: LlmResponse;

  beforeEach(() => {
    vi.clearAllMocks();

    mockSpan = {
      setAttributes: vi.fn(),
      setAttribute: vi.fn(),
    };

    mockAgent = {
      name: 'test-agent',
      description: 'A test agent',
    } as BaseAgent;

    mockInvocationContext = {
      invocationId: 'test-invocation-id',
      session: {
        id: 'test-session-id',
      } as Session,
      agent: mockAgent,
    } as InvocationContext;

    mockTool = {
      name: 'test-tool',
      description: 'A test tool',
      constructor: {
        name: 'FunctionTool',
      },
    } as BaseTool;

    mockEvent = {
      id: 'test-event-id',
      invocationId: 'test-invocation-id',
      actions: createEventActions({skipSummarization: false}),
      timestamp: Date.now(),
      content: {
        parts: [
          {
            functionResponse: {
              id: 'test-call-id',
              response: {result: 'test-result'},
            },
          },
        ],
      },
    } as Event;

    mockLlmRequest = {
      model: 'test-model',
      contents: [],
      config: {
        topP: 0.8,
        maxOutputTokens: 100,
      },
      liveConnectConfig: {},
      toolsDict: {},
    } as LlmRequest;

    mockLlmResponse = {
      content: {parts: [{text: 'test-response'}]},
    } as LlmResponse;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('traceAgentInvocation', () => {
    it('should set correct attributes for agent invocation', () => {
      // Arrange
      vi.mocked(trace.getActiveSpan).mockReturnValue(mockSpan);

      // Act
      traceAgentInvocation({
        agent: mockAgent,
        invocationContext: mockInvocationContext,
      });

      // Assert
      expect(mockSpan.setAttributes).toHaveBeenCalledWith({
        'gen_ai.operation.name': 'invoke_agent',
        'gen_ai.agent.description': 'A test agent',
        'gen_ai.agent.name': 'test-agent',
        'gen_ai.conversation.id': 'test-session-id',
      });
    });
  });

  describe('traceToolCall', () => {
    it('should set correct attributes for tool call', () => {
      // Arrange
      vi.mocked(trace.getActiveSpan).mockReturnValue(mockSpan);
      const args = {param1: 'value1', param2: 123};

      // Act
      traceToolCall({
        tool: mockTool,
        args,
        functionResponseEvent: mockEvent,
      });

      // Assert
      expect(mockSpan.setAttributes).toHaveBeenCalledWith({
        'gen_ai.operation.name': 'execute_tool',
        'gen_ai.tool.description': 'A test tool',
        'gen_ai.tool.name': 'test-tool',
        'gen_ai.tool.type': 'FunctionTool',
        'gcp.vertex.agent.llm_request': '{}',
        'gcp.vertex.agent.llm_response': '{}',
        'gcp.vertex.agent.tool_call_args': expect.stringContaining('param1'),
      });

      expect(mockSpan.setAttributes).toHaveBeenCalledWith({
        'gen_ai.tool.call.id': 'test-call-id',
        'gcp.vertex.agent.event_id': 'test-event-id',
        'gcp.vertex.agent.tool_response':
          expect.stringContaining('test-result'),
      });
    });

    it('should handle tool call without function response', () => {
      // Arrange
      vi.mocked(trace.getActiveSpan).mockReturnValue(mockSpan);
      const eventWithoutResponse = {
        id: 'test-event-id',
        invocationId: 'test-invocation-id',
        actions: createEventActions({skipSummarization: false}),
        timestamp: Date.now(),
        content: {parts: []},
      } as Event;

      // Act
      traceToolCall({
        tool: mockTool,
        args: {},
        functionResponseEvent: eventWithoutResponse,
      });

      // Assert
      expect(mockSpan.setAttributes).toHaveBeenCalledWith({
        'gen_ai.tool.call.id': '<not specified>',
        'gcp.vertex.agent.event_id': 'test-event-id',
        'gcp.vertex.agent.tool_response':
          expect.stringContaining('not specified'),
      });
    });
  });

  describe('traceMergedToolCalls', () => {
    it('should set correct attributes for merged tool calls', () => {
      // Arrange
      vi.mocked(trace.getActiveSpan).mockReturnValue(mockSpan);
      const mockEventWithJson = {
        id: 'merged-event-id',
        invocationId: 'test-invocation-id',
        actions: createEventActions({skipSummarization: false}),
        timestamp: Date.now(),
        content: {
          parts: [
            {
              text: 'merged response data',
            },
          ],
        },
        model_dumps_json: vi.fn().mockReturnValue('{"merged": "data"}'),
      };

      // Act
      traceMergedToolCalls({
        responseEventId: 'merged-event-id',
        functionResponseEvent: mockEventWithJson as unknown as Event,
      });

      // Assert - setAttributes is called without tool_response
      expect(mockSpan.setAttributes).toHaveBeenCalledWith({
        'gen_ai.operation.name': 'execute_tool',
        'gen_ai.tool.name': '(merged tools)',
        'gen_ai.tool.description': '(merged tools)',
        'gen_ai.tool.call.id': 'merged-event-id',
        'gcp.vertex.agent.tool_call_args': 'N/A',
        'gcp.vertex.agent.event_id': 'merged-event-id',
        'gcp.vertex.agent.llm_request': '{}',
        'gcp.vertex.agent.llm_response': '{}',
      });

      // tool_response is set separately via setAttribute
      expect(mockSpan.setAttribute).toHaveBeenCalledWith(
        'gcp.vertex.agent.tool_response',
        expect.any(String),
      );
    });
  });

  describe('traceCallLlm', () => {
    it('should set correct attributes for LLM call', () => {
      // Arrange
      vi.mocked(trace.getActiveSpan).mockReturnValue(mockSpan);

      // Act
      traceCallLlm({
        invocationContext: mockInvocationContext,
        eventId: 'test-event-id',
        llmRequest: mockLlmRequest,
        llmResponse: mockLlmResponse,
      });

      // Assert
      expect(mockSpan.setAttributes).toHaveBeenCalledWith({
        'gen_ai.system': 'gcp.vertex.agent',
        'gen_ai.request.model': 'test-model',
        'gen_ai.agent.name': 'test-agent',
        'gcp.vertex.agent.invocation_id': 'test-invocation-id',
        'gcp.vertex.agent.session_id': 'test-session-id',
        'gcp.vertex.agent.event_id': 'test-event-id',
        'gcp.vertex.agent.llm_request': expect.stringContaining('test-model'),
      });

      expect(mockSpan.setAttribute).toHaveBeenCalledWith(
        'gen_ai.request.top_p',
        0.8,
      );
      expect(mockSpan.setAttribute).toHaveBeenCalledWith(
        'gen_ai.request.max_tokens',
        100,
      );
    });

    it('should handle LLM call without config', () => {
      // Arrange
      vi.mocked(trace.getActiveSpan).mockReturnValue(mockSpan);
      const requestWithoutConfig = {...mockLlmRequest, config: undefined};

      // Act
      traceCallLlm({
        invocationContext: mockInvocationContext,
        eventId: 'test-event-id',
        llmRequest: requestWithoutConfig,
        llmResponse: mockLlmResponse,
      });

      // Assert
      expect(mockSpan.setAttribute).not.toHaveBeenCalledWith(
        'gen_ai.request.top_p',
        expect.anything(),
      );
      expect(mockSpan.setAttribute).not.toHaveBeenCalledWith(
        'gen_ai.request.max_tokens',
        expect.anything(),
      );
    });
  });
});

/** A {@link Span} that keeps the attributes set on it, for assertions. */
class RecordingSpan implements Span {
  readonly attributes: Attributes = {};

  setAttribute(key: string, value: AttributeValue): this {
    this.attributes[key] = value;
    return this;
  }

  setAttributes(attributes: Attributes): this {
    Object.assign(this.attributes, attributes);
    return this;
  }

  spanContext(): SpanContext {
    return {traceId: '0'.repeat(32), spanId: '0'.repeat(16), traceFlags: 0};
  }

  addEvent(): this {
    return this;
  }

  addLink(): this {
    return this;
  }

  addLinks(): this {
    return this;
  }

  setStatus(): this {
    return this;
  }

  updateName(): this {
    return this;
  }

  end(): void {}

  isRecording(): boolean {
    return true;
  }

  recordException(): void {}
}

describe('Tracing with a per-request TelemetryConfig', () => {
  let span: RecordingSpan;

  function createContext(telemetry?: TelemetryConfig): InvocationContext {
    return {
      invocationId: 'test-invocation-id',
      session: {id: 'test-session-id'} as Session,
      agent: {name: 'test-agent'} as BaseAgent,
      runConfig: telemetry ? {telemetry} : undefined,
    } as InvocationContext;
  }

  const noContent = () =>
    createContext(
      createTelemetryConfig({
        captureMessageContent: ContentCapturingMode.NO_CONTENT,
      }),
    );

  const tool = {
    name: 'test-tool',
    description: 'A test tool',
    constructor: {name: 'FunctionTool'},
  } as BaseTool;

  const event = {
    id: 'test-event-id',
    invocationId: 'test-invocation-id',
    actions: createEventActions({skipSummarization: false}),
    timestamp: 0,
    content: {parts: [{text: 'response'}]},
  } as Event;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS', undefined);
    span = new RecordingSpan();
    vi.mocked(trace.getActiveSpan).mockReturnValue(span);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('redacts the tool call args when the run opts out', () => {
    traceToolCall({
      tool,
      args: {secret: 'value'},
      functionResponseEvent: event,
      invocationContext: noContent(),
    });

    expect(span.attributes['gcp.vertex.agent.tool_call_args']).toBe('{}');
    expect(span.attributes['gcp.vertex.agent.tool_response']).toBe('{}');
  });

  it('records the tool call args when the run opts in', () => {
    traceToolCall({
      tool,
      args: {topic: 'weather'},
      functionResponseEvent: event,
      invocationContext: createContext(
        createTelemetryConfig({
          captureMessageContent: ContentCapturingMode.SPAN_ONLY,
        }),
      ),
    });

    expect(span.attributes['gcp.vertex.agent.tool_call_args']).toBe(
      JSON.stringify({topic: 'weather'}),
    );
  });

  it('records content by default when the run sets no telemetry config', () => {
    traceToolCall({
      tool,
      args: {topic: 'weather'},
      functionResponseEvent: event,
      invocationContext: createContext(),
    });

    expect(span.attributes['gcp.vertex.agent.tool_call_args']).toBe(
      JSON.stringify({topic: 'weather'}),
    );
  });

  it('still honours the env var when the run sets no telemetry config', () => {
    vi.stubEnv('ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS', 'false');

    traceToolCall({
      tool,
      args: {topic: 'weather'},
      functionResponseEvent: event,
      invocationContext: createContext(),
    });

    expect(span.attributes['gcp.vertex.agent.tool_call_args']).toBe('{}');
  });

  it('redacts the merged tool response when the run opts out', () => {
    traceMergedToolCalls({
      responseEventId: 'merged-id',
      functionResponseEvent: event,
      invocationContext: noContent(),
    });

    expect(span.attributes['gcp.vertex.agent.tool_response']).toBe('{}');
  });

  it('redacts the llm request and response when the run opts out', () => {
    traceCallLlm({
      invocationContext: noContent(),
      eventId: 'test-event-id',
      llmRequest: {
        model: 'test-model',
        contents: [],
        liveConnectConfig: {},
        toolsDict: {},
      } as LlmRequest,
      llmResponse: {content: {parts: [{text: 'secret'}]}} as LlmResponse,
    });

    expect(span.attributes['gcp.vertex.agent.llm_request']).toBe('{}');
    expect(span.attributes['gcp.vertex.agent.llm_response']).toBe('{}');
  });

  it('redacts the streamed data when the run opts out', () => {
    traceSendData({
      invocationContext: noContent(),
      eventId: 'test-event-id',
      data: [{role: 'user', parts: [{text: 'secret'}]}],
    });

    expect(span.attributes['gcp.vertex.agent.data']).toBe('{}');
  });

  it('records the streamed data when the run sets no telemetry config', () => {
    const data = [{role: 'user', parts: [{text: 'hello'}]}];

    traceSendData({
      invocationContext: createContext(),
      eventId: 'test-event-id',
      data,
    });

    expect(span.attributes['gcp.vertex.agent.data']).toBe(JSON.stringify(data));
  });
});
