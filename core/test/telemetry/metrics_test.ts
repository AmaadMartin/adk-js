/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {createEvent} from '../../src/events/event.js';
import {LlmRequest} from '../../src/models/llm_request.js';
import {LlmResponse} from '../../src/models/llm_response.js';
import {
  recordAgentInvocationDuration,
  recordAgentRequestSize,
  recordAgentResponseSize,
  recordAgentWorkflowSteps,
  recordClientOperationDuration,
  recordClientTokenUsage,
  recordToolExecutionDuration,
} from '../../src/telemetry/metrics.js';
import {
  getGoogleLlmVariant,
  GoogleLLMVariant,
} from '../../src/utils/variant_utils.js';

// Define stable mock histograms at the top level so they survive across tests
const mockHistograms = {
  'gen_ai.agent.invocation.duration': {record: vi.fn()},
  'gen_ai.tool.execution.duration': {record: vi.fn()},
  'gen_ai.agent.request.size': {record: vi.fn()},
  'gen_ai.agent.response.size': {record: vi.fn()},
  'gen_ai.agent.workflow.steps': {record: vi.fn()},
  'gen_ai.client.operation.duration': {record: vi.fn()},
  'gen_ai.client.token.usage': {record: vi.fn()},
};

const mockMeter = {
  createHistogram: vi.fn((name: keyof typeof mockHistograms) => {
    return mockHistograms[name];
  }),
};

vi.mock('@opentelemetry/api', () => {
  return {
    metrics: {
      getMeter: vi.fn(() => mockMeter),
    },
  };
});

vi.mock('../../src/utils/variant_utils.js', () => {
  return {
    getGoogleLlmVariant: vi.fn(() => 'GEMINI_API'),
    GoogleLLMVariant: {
      VERTEX_AI: 'VERTEX_AI',
      GEMINI_API: 'GEMINI_API',
    },
  };
});

describe('Telemetry Metrics Functions', () => {
  beforeEach(() => {
    // Clear call history but keep mock references stable
    vi.clearAllMocks();
    vi.mocked(getGoogleLlmVariant).mockReturnValue(GoogleLLMVariant.GEMINI_API);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('recordAgentInvocationDuration', () => {
    it('should record agent invocation duration with correct attributes', () => {
      recordAgentInvocationDuration('my-agent', 123.45);
      expect(
        mockHistograms['gen_ai.agent.invocation.duration'].record,
      ).toHaveBeenCalledWith(123.45, {
        'gen_ai.agent.name': 'my-agent',
      });
    });

    it('should record agent invocation duration with error.type attribute if error is provided', () => {
      const err = new Error('Test error');
      recordAgentInvocationDuration('my-agent', 123.45, err);
      expect(
        mockHistograms['gen_ai.agent.invocation.duration'].record,
      ).toHaveBeenCalledWith(123.45, {
        'gen_ai.agent.name': 'my-agent',
        'error.type': 'Error',
      });
    });

    it('should fall back to constructor name if error.name is empty', () => {
      const err = new Error('Test error');
      err.name = '';
      recordAgentInvocationDuration('my-agent', 123.45, err);
      expect(
        mockHistograms['gen_ai.agent.invocation.duration'].record,
      ).toHaveBeenCalledWith(123.45, {
        'gen_ai.agent.name': 'my-agent',
        'error.type': 'Error',
      });
    });

    it('should handle errors gracefully when recording fails', () => {
      mockHistograms[
        'gen_ai.agent.invocation.duration'
      ].record.mockImplementationOnce(() => {
        throw new Error('Recording failed');
      });
      expect(() => {
        recordAgentInvocationDuration('my-agent', 123.45);
      }).not.toThrow();
    });
  });

  describe('recordToolExecutionDuration', () => {
    it('should record tool execution duration with correct attributes', () => {
      recordToolExecutionDuration('my-tool', 'my-agent', 456.78);
      expect(
        mockHistograms['gen_ai.tool.execution.duration'].record,
      ).toHaveBeenCalledWith(456.78, {
        'gen_ai.agent.name': 'my-agent',
        'gen_ai.tool.name': 'my-tool',
      });
    });

    it('should record tool execution duration with error.type attribute if error is provided', () => {
      const err = new TypeError('Test type error');
      recordToolExecutionDuration('my-tool', 'my-agent', 456.78, err);
      expect(
        mockHistograms['gen_ai.tool.execution.duration'].record,
      ).toHaveBeenCalledWith(456.78, {
        'gen_ai.agent.name': 'my-agent',
        'gen_ai.tool.name': 'my-tool',
        'error.type': 'TypeError',
      });
    });

    it('should fall back to constructor name if error.name is empty', () => {
      const err = new TypeError('Test type error');
      err.name = '';
      recordToolExecutionDuration('my-tool', 'my-agent', 456.78, err);
      expect(
        mockHistograms['gen_ai.tool.execution.duration'].record,
      ).toHaveBeenCalledWith(456.78, {
        'gen_ai.agent.name': 'my-agent',
        'gen_ai.tool.name': 'my-tool',
        'error.type': 'TypeError',
      });
    });

    it('should handle errors gracefully when recording fails', () => {
      mockHistograms[
        'gen_ai.tool.execution.duration'
      ].record.mockImplementationOnce(() => {
        throw new Error('Recording failed');
      });
      expect(() => {
        recordToolExecutionDuration('my-tool', 'my-agent', 456.78);
      }).not.toThrow();
    });
  });

  describe('recordAgentRequestSize', () => {
    it('should record 0 size for null/undefined content', () => {
      recordAgentRequestSize('my-agent', null);
      expect(
        mockHistograms['gen_ai.agent.request.size'].record,
      ).toHaveBeenCalledWith(0, {
        'gen_ai.agent.name': 'my-agent',
      });
    });

    it('should record 0 size for content with no parts', () => {
      recordAgentRequestSize('my-agent', {parts: []});
      expect(
        mockHistograms['gen_ai.agent.request.size'].record,
      ).toHaveBeenCalledWith(0, {
        'gen_ai.agent.name': 'my-agent',
      });
    });

    it('should record correct byte size for text content', () => {
      recordAgentRequestSize('my-agent', {
        parts: [{text: 'Hello World'}], // 11 bytes
      });
      expect(
        mockHistograms['gen_ai.agent.request.size'].record,
      ).toHaveBeenCalledWith(11, {
        'gen_ai.agent.name': 'my-agent',
      });
    });

    it('should record correct byte size for base64 inlineData', () => {
      recordAgentRequestSize('my-agent', {
        parts: [{inlineData: {data: 'SGVsbG8=', mimeType: 'text/plain'}}], // "Hello" -> 5 bytes
      });
      expect(
        mockHistograms['gen_ai.agent.request.size'].record,
      ).toHaveBeenCalledWith(5, {
        'gen_ai.agent.name': 'my-agent',
      });
    });

    it('should record correct byte size for base64 inlineData with padding = 2', () => {
      recordAgentRequestSize('my-agent', {
        parts: [{inlineData: {data: 'QQ==', mimeType: 'text/plain'}}], // 1 byte
      });
      expect(
        mockHistograms['gen_ai.agent.request.size'].record,
      ).toHaveBeenCalledWith(1, {
        'gen_ai.agent.name': 'my-agent',
      });
    });

    it('should record 0 byte size for empty base64 inlineData', () => {
      recordAgentRequestSize('my-agent', {
        parts: [{inlineData: {data: '', mimeType: 'text/plain'}}],
      });
      expect(
        mockHistograms['gen_ai.agent.request.size'].record,
      ).toHaveBeenCalledWith(0, {
        'gen_ai.agent.name': 'my-agent',
      });
    });

    it('should handle errors gracefully when recording fails', () => {
      mockHistograms['gen_ai.agent.request.size'].record.mockImplementationOnce(
        () => {
          throw new Error('Recording failed');
        },
      );
      expect(() => {
        recordAgentRequestSize('my-agent', {parts: [{text: 'Hello'}]});
      }).not.toThrow();
    });
  });

  describe('recordAgentResponseSize', () => {
    it('should record 0 size if no matching event found with content', () => {
      const events = [
        createEvent({
          author: 'other-agent',
          content: {parts: [{text: 'Hello'}]},
        }),
      ];
      recordAgentResponseSize('my-agent', events);
      expect(
        mockHistograms['gen_ai.agent.response.size'].record,
      ).toHaveBeenCalledWith(0, {
        'gen_ai.agent.name': 'my-agent',
      });
    });

    it('should record correct size from the last matching event content', () => {
      const events = [
        createEvent({author: 'my-agent', content: {parts: [{text: 'First'}]}}),
        createEvent({
          author: 'my-agent',
          content: {parts: [{text: 'Second Response'}]},
        }), // 15 bytes
        createEvent({
          author: 'other-agent',
          content: {parts: [{text: 'Third'}]},
        }),
      ];
      recordAgentResponseSize('my-agent', events);
      expect(
        mockHistograms['gen_ai.agent.response.size'].record,
      ).toHaveBeenCalledWith(15, {
        'gen_ai.agent.name': 'my-agent',
      });
    });

    it('should handle errors gracefully when recording fails', () => {
      mockHistograms[
        'gen_ai.agent.response.size'
      ].record.mockImplementationOnce(() => {
        throw new Error('Recording failed');
      });
      expect(() => {
        recordAgentResponseSize('my-agent', []);
      }).not.toThrow();
    });
  });

  describe('recordAgentWorkflowSteps', () => {
    it('should record correct workflow step count', () => {
      const events = [
        createEvent({author: 'my-agent'}),
        createEvent({author: 'other-agent'}),
        createEvent({author: 'my-agent'}),
        createEvent({author: 'my-agent'}),
      ];
      recordAgentWorkflowSteps('my-agent', events);
      expect(
        mockHistograms['gen_ai.agent.workflow.steps'].record,
      ).toHaveBeenCalledWith(3, {
        'gen_ai.agent.name': 'my-agent',
      });
    });

    it('should handle errors gracefully when recording fails', () => {
      mockHistograms[
        'gen_ai.agent.workflow.steps'
      ].record.mockImplementationOnce(() => {
        throw new Error('Recording failed');
      });
      expect(() => {
        recordAgentWorkflowSteps('my-agent', []);
      }).not.toThrow();
    });
  });

  describe('recordClientOperationDuration', () => {
    it('should record client operation duration converted to seconds with Gemini provider', () => {
      const llmRequest: LlmRequest = {model: 'model-a'} as LlmRequest;
      const responses: LlmResponse[] = [
        {modelVersion: 'model-a-v1'} as LlmResponse,
      ];
      recordClientOperationDuration('my-agent', 1500, llmRequest, responses);
      expect(
        mockHistograms['gen_ai.client.operation.duration'].record,
      ).toHaveBeenCalledWith(1.5, {
        'gen_ai.agent.name': 'my-agent',
        'gen_ai.operation.name': 'generate_content',
        'gen_ai.provider.name': 'gemini',
        'gen_ai.request.model': 'model-a',
        'gen_ai.response.model': 'model-a-v1',
      });
    });

    it('should record client operation duration converted to seconds with Vertex AI provider', () => {
      vi.mocked(getGoogleLlmVariant).mockReturnValue(
        GoogleLLMVariant.VERTEX_AI,
      );
      const llmRequest: LlmRequest = {model: 'model-a'} as LlmRequest;
      const responses: LlmResponse[] = [
        {modelVersion: 'model-a-v1'} as LlmResponse,
      ];
      recordClientOperationDuration('my-agent', 1500, llmRequest, responses);
      expect(
        mockHistograms['gen_ai.client.operation.duration'].record,
      ).toHaveBeenCalledWith(1.5, {
        'gen_ai.agent.name': 'my-agent',
        'gen_ai.operation.name': 'generate_content',
        'gen_ai.provider.name': 'vertex_ai',
        'gen_ai.request.model': 'model-a',
        'gen_ai.response.model': 'model-a-v1',
      });
    });

    it('should fall back to llmRequest.model if lastResponse.modelVersion is missing', () => {
      const llmRequest: LlmRequest = {model: 'model-a'} as LlmRequest;
      const responses: LlmResponse[] = [{} as LlmResponse];
      recordClientOperationDuration('my-agent', 1500, llmRequest, responses);
      expect(
        mockHistograms['gen_ai.client.operation.duration'].record,
      ).toHaveBeenCalledWith(1.5, {
        'gen_ai.agent.name': 'my-agent',
        'gen_ai.operation.name': 'generate_content',
        'gen_ai.provider.name': 'gemini',
        'gen_ai.request.model': 'model-a',
        'gen_ai.response.model': 'model-a',
      });
    });

    it('should handle getGoogleLlmVariant throwing error', () => {
      vi.mocked(getGoogleLlmVariant).mockImplementationOnce(() => {
        throw new Error('Variant error');
      });
      const llmRequest: LlmRequest = {model: 'model-a'} as LlmRequest;
      const responses: LlmResponse[] = [
        {modelVersion: 'model-a-v1'} as LlmResponse,
      ];
      recordClientOperationDuration('my-agent', 1500, llmRequest, responses);
      expect(
        mockHistograms['gen_ai.client.operation.duration'].record,
      ).toHaveBeenCalledWith(1.5, {
        'gen_ai.agent.name': 'my-agent',
        'gen_ai.operation.name': 'generate_content',
        'gen_ai.provider.name': 'gemini',
        'gen_ai.request.model': 'model-a',
        'gen_ai.response.model': 'model-a-v1',
      });
    });

    it('should handle empty responses array and no models', () => {
      const llmRequest: LlmRequest = {} as LlmRequest;
      recordClientOperationDuration('my-agent', 1500, llmRequest, []);
      expect(
        mockHistograms['gen_ai.client.operation.duration'].record,
      ).toHaveBeenCalledWith(1.5, {
        'gen_ai.agent.name': 'my-agent',
        'gen_ai.operation.name': 'generate_content',
        'gen_ai.provider.name': 'gemini',
      });
    });

    it('should record client operation duration with error', () => {
      const llmRequest: LlmRequest = {model: 'model-a'} as LlmRequest;
      const err = new Error('LLM Error');
      recordClientOperationDuration('my-agent', 2000, llmRequest, [], err);
      expect(
        mockHistograms['gen_ai.client.operation.duration'].record,
      ).toHaveBeenCalledWith(2.0, {
        'gen_ai.agent.name': 'my-agent',
        'gen_ai.operation.name': 'generate_content',
        'gen_ai.provider.name': 'gemini',
        'gen_ai.request.model': 'model-a',
        'error.type': 'Error',
      });
    });

    it('should fall back to constructor name if error.name is empty', () => {
      const llmRequest: LlmRequest = {model: 'model-a'} as LlmRequest;
      const err = new Error('LLM Error');
      err.name = '';
      recordClientOperationDuration('my-agent', 2000, llmRequest, [], err);
      expect(
        mockHistograms['gen_ai.client.operation.duration'].record,
      ).toHaveBeenCalledWith(2.0, {
        'gen_ai.agent.name': 'my-agent',
        'gen_ai.operation.name': 'generate_content',
        'gen_ai.provider.name': 'gemini',
        'gen_ai.request.model': 'model-a',
        'error.type': 'Error',
      });
    });

    it('should handle errors gracefully when recording fails', () => {
      mockHistograms[
        'gen_ai.client.operation.duration'
      ].record.mockImplementationOnce(() => {
        throw new Error('Recording failed');
      });
      expect(() => {
        recordClientOperationDuration('my-agent', 1500, {} as LlmRequest, []);
      }).not.toThrow();
    });
  });

  describe('recordClientTokenUsage', () => {
    it('should skip if no responses provided', () => {
      const llmRequest: LlmRequest = {model: 'model-a'} as LlmRequest;
      recordClientTokenUsage('my-agent', llmRequest, []);
      expect(
        mockHistograms['gen_ai.client.token.usage'].record,
      ).not.toHaveBeenCalled();
    });

    it('should skip if usageMetadata is missing in last response', () => {
      const llmRequest: LlmRequest = {model: 'model-a'} as LlmRequest;
      const responses: LlmResponse[] = [{} as LlmResponse];
      recordClientTokenUsage('my-agent', llmRequest, responses);
      expect(
        mockHistograms['gen_ai.client.token.usage'].record,
      ).not.toHaveBeenCalled();
    });

    it('should record input and output token usage correctly', () => {
      const llmRequest: LlmRequest = {model: 'model-a'} as LlmRequest;
      const responses: LlmResponse[] = [
        {
          modelVersion: 'model-a-v1',
          usageMetadata: {
            promptTokenCount: 10,
            toolUsePromptTokenCount: 5,
            candidatesTokenCount: 20,
            thoughtsTokenCount: 3,
          },
        } as LlmResponse,
      ];
      recordClientTokenUsage('my-agent', llmRequest, responses);

      // Input usage = promptTokenCount (10) + toolUsePromptTokenCount (5) = 15
      expect(
        mockHistograms['gen_ai.client.token.usage'].record,
      ).toHaveBeenCalledWith(15, {
        'gen_ai.agent.name': 'my-agent',
        'gen_ai.operation.name': 'generate_content',
        'gen_ai.provider.name': 'gemini',
        'gen_ai.request.model': 'model-a',
        'gen_ai.response.model': 'model-a-v1',
        'gen_ai.token.type': 'input',
      });

      // Output usage = candidatesTokenCount (20) + thoughtsTokenCount (3) = 23
      expect(
        mockHistograms['gen_ai.client.token.usage'].record,
      ).toHaveBeenCalledWith(23, {
        'gen_ai.agent.name': 'my-agent',
        'gen_ai.operation.name': 'generate_content',
        'gen_ai.provider.name': 'gemini',
        'gen_ai.request.model': 'model-a',
        'gen_ai.response.model': 'model-a-v1',
        'gen_ai.token.type': 'output',
      });
    });

    it('should fall back to llmRequest.model if responses has no modelVersion', () => {
      const llmRequest: LlmRequest = {model: 'model-a'} as LlmRequest;
      const responses: LlmResponse[] = [
        {
          usageMetadata: {
            promptTokenCount: 10,
          },
        } as LlmResponse,
      ];
      recordClientTokenUsage('my-agent', llmRequest, responses);
      expect(
        mockHistograms['gen_ai.client.token.usage'].record,
      ).toHaveBeenCalledWith(10, {
        'gen_ai.agent.name': 'my-agent',
        'gen_ai.operation.name': 'generate_content',
        'gen_ai.provider.name': 'gemini',
        'gen_ai.request.model': 'model-a',
        'gen_ai.response.model': 'model-a',
        'gen_ai.token.type': 'input',
      });
    });

    it('should not record if input or output token count is zero', () => {
      const llmRequest: LlmRequest = {model: 'model-a'} as LlmRequest;
      const responses: LlmResponse[] = [
        {
          usageMetadata: {
            promptTokenCount: 0,
            toolUsePromptTokenCount: 0,
            candidatesTokenCount: 0,
            thoughtsTokenCount: 0,
          },
        } as LlmResponse,
      ];
      recordClientTokenUsage('my-agent', llmRequest, responses);
      expect(
        mockHistograms['gen_ai.client.token.usage'].record,
      ).not.toHaveBeenCalled();
    });

    it('should handle errors gracefully when recording fails', () => {
      mockHistograms['gen_ai.client.token.usage'].record.mockImplementationOnce(
        () => {
          throw new Error('Recording failed');
        },
      );
      const llmRequest: LlmRequest = {model: 'model-a'} as LlmRequest;
      const responses: LlmResponse[] = [
        {
          usageMetadata: {
            promptTokenCount: 10,
          },
        } as LlmResponse,
      ];
      expect(() => {
        recordClientTokenUsage('my-agent', llmRequest, responses);
      }).not.toThrow();
    });
  });
});
