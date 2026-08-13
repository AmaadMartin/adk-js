/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {MeterProvider as ApiMeterProvider, metrics} from '@opentelemetry/api';
import {
  DataPoint,
  DataPointType,
  Histogram,
  HistogramMetricData,
  MeterProvider,
  MetricReader,
} from '@opentelemetry/sdk-metrics';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

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
import {logger} from '../../src/utils/logger.js';

/** Bucket boundaries the SDK applies when an instrument gives no advisory. */
const SDK_DEFAULT_BOUNDARIES = [
  0, 5, 10, 25, 50, 75, 100, 250, 500, 750, 1000, 2500, 5000, 7500, 10000,
];

class InMemoryMetricReader extends MetricReader {
  protected async onForceFlush(): Promise<void> {}
  protected async onShutdown(): Promise<void> {}
}

let reader: InMemoryMetricReader;
let provider: MeterProvider;

function installMeterProvider(): MeterProvider {
  reader = new InMemoryMetricReader();
  const installed = new MeterProvider({readers: [reader]});
  metrics.disable();
  metrics.setGlobalMeterProvider(installed);
  return installed;
}

async function collectHistograms(): Promise<Map<string, HistogramMetricData>> {
  const {resourceMetrics} = await reader.collect();
  const byName = new Map<string, HistogramMetricData>();
  for (const scopeMetric of resourceMetrics.scopeMetrics) {
    for (const metric of scopeMetric.metrics) {
      if (metric.dataPointType === DataPointType.HISTOGRAM) {
        byName.set(metric.descriptor.name, metric);
      }
    }
  }
  return byName;
}

async function collectHistogram(name: string): Promise<HistogramMetricData> {
  const metric = (await collectHistograms()).get(name);
  if (!metric) {
    expect.fail(`no measurement recorded for ${name}`);
  }
  return metric;
}

async function collectDataPoint(name: string): Promise<DataPoint<Histogram>> {
  const metric = await collectHistogram(name);
  expect(metric.dataPoints).toHaveLength(1);
  return metric.dataPoints[0];
}

const llmRequest = (model?: string): LlmRequest => ({
  model,
  contents: [],
  liveConnectConfig: {},
  toolsDict: {},
});

describe('telemetry metrics', () => {
  beforeEach(() => {
    provider = installMeterProvider();
  });

  afterEach(async () => {
    await provider.shutdown();
    metrics.disable();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  describe('instrument definitions', () => {
    const instruments = [
      {
        name: 'gen_ai.invoke_agent.duration',
        unit: 's',
        description: 'Duration of agent invocations.',
        boundaries: [
          0.1, 0.2, 0.4, 0.8, 1.6, 3.2, 6.4, 12.8, 25.6, 51.2, 102.4, 204.8,
          409.6,
        ],
        record: () => recordAgentInvocationDuration('an-agent', 1),
      },
      {
        name: 'gen_ai.execute_tool.duration',
        unit: 's',
        description: 'Duration of tool executions.',
        boundaries: [
          0.01, 0.02, 0.04, 0.08, 0.16, 0.32, 0.64, 1.28, 2.56, 5.12, 10.24,
          20.48, 40.96, 81.92,
        ],
        record: () =>
          recordToolExecutionDuration('a-tool', 'FunctionTool', 'an-agent', 1),
      },
      {
        name: 'gen_ai.client.operation.duration',
        unit: 's',
        description: 'GenAI operation duration.',
        boundaries: SDK_DEFAULT_BOUNDARIES,
        record: () =>
          recordClientOperationDuration({
            agentName: 'an-agent',
            elapsedS: 1,
            llmRequest: llmRequest('a-model'),
          }),
      },
      {
        name: 'gen_ai.client.token.usage',
        unit: '{token}',
        description: 'Number of input and output tokens used.',
        boundaries: SDK_DEFAULT_BOUNDARIES,
        record: () =>
          recordClientTokenUsage({
            agentName: 'an-agent',
            llmRequest: llmRequest('a-model'),
            response: {usageMetadata: {promptTokenCount: 1}},
          }),
      },
      {
        name: 'gen_ai.agent.request.size',
        unit: 'By',
        description: 'Size of agent requests.',
        boundaries: SDK_DEFAULT_BOUNDARIES,
        record: () =>
          recordAgentRequestSize('an-agent', {parts: [{text: 'x'}]}),
      },
      {
        name: 'gen_ai.agent.response.size',
        unit: 'By',
        description: 'Size of agent responses.',
        boundaries: SDK_DEFAULT_BOUNDARIES,
        record: () =>
          recordAgentResponseSize('an-agent', {parts: [{text: 'x'}]}),
      },
      {
        name: 'gen_ai.agent.workflow.steps',
        unit: '1',
        description: 'Length of agentic workflow (# of events).',
        boundaries: SDK_DEFAULT_BOUNDARIES,
        record: () => recordAgentWorkflowSteps('an-agent', 1),
      },
    ];

    it.each(instruments)(
      'declares $name with its unit, description and buckets',
      async ({name, unit, description, boundaries, record}) => {
        record();

        const metric = await collectHistogram(name);
        expect(metric.descriptor.unit).toBe(unit);
        expect(metric.descriptor.description).toBe(description);
        expect(metric.dataPoints[0].value.buckets.boundaries).toEqual(
          boundaries,
        );
      },
    );
  });

  describe('recordAgentInvocationDuration', () => {
    it('records the elapsed seconds against the agent name', async () => {
      recordAgentInvocationDuration('test_agent', 1.0);

      const dataPoint = await collectDataPoint('gen_ai.invoke_agent.duration');
      expect(dataPoint.value.sum).toBe(1.0);
      expect(dataPoint.attributes).toEqual({'gen_ai.agent.name': 'test_agent'});
    });

    it('adds the error type when the invocation failed', async () => {
      recordAgentInvocationDuration('test_agent', 1.0, new TypeError('boom'));

      const dataPoint = await collectDataPoint('gen_ai.invoke_agent.duration');
      expect(dataPoint.attributes).toEqual({
        'gen_ai.agent.name': 'test_agent',
        'error.type': 'TypeError',
      });
    });

    it('falls back to the class name if error.name is empty', async () => {
      const error = new TypeError('boom');
      error.name = '';
      recordAgentInvocationDuration('test_agent', 1.0, error);

      const dataPoint = await collectDataPoint('gen_ai.invoke_agent.duration');
      expect(dataPoint.attributes['error.type']).toBe('TypeError');
    });
  });

  describe('recordToolExecutionDuration', () => {
    it('records the tool name, type and agent', async () => {
      recordToolExecutionDuration(
        'test_tool',
        'test_tool_type',
        'test_agent',
        0.5,
      );

      const dataPoint = await collectDataPoint('gen_ai.execute_tool.duration');
      expect(dataPoint.value.sum).toBe(0.5);
      expect(dataPoint.attributes).toEqual({
        'gen_ai.agent.name': 'test_agent',
        'gen_ai.tool.name': 'test_tool',
        'gen_ai.tool.type': 'test_tool_type',
      });
    });

    it('adds the error type when the tool failed', async () => {
      recordToolExecutionDuration(
        'test_tool',
        'test_tool_type',
        'test_agent',
        0.5,
        new TypeError('tool failed'),
      );

      const dataPoint = await collectDataPoint('gen_ai.execute_tool.duration');
      expect(dataPoint.attributes['error.type']).toBe('TypeError');
    });
  });

  describe('recordAgentRequestSize', () => {
    it('records the request size against the agent name', async () => {
      recordAgentRequestSize('my-agent', {parts: [{text: 'Hello World'}]});

      const dataPoint = await collectDataPoint('gen_ai.agent.request.size');
      expect(dataPoint.value.sum).toBe(11);
      expect(dataPoint.attributes).toEqual({'gen_ai.agent.name': 'my-agent'});
    });

    it('records 0 when the invocation carried no content', async () => {
      recordAgentRequestSize('my-agent', undefined);

      expect(
        (await collectDataPoint('gen_ai.agent.request.size')).value.sum,
      ).toBe(0);
    });
  });

  describe('recordAgentResponseSize', () => {
    it('records the response size against the agent name', async () => {
      recordAgentResponseSize('my-agent', {parts: [{text: 'Second Response'}]});

      const dataPoint = await collectDataPoint('gen_ai.agent.response.size');
      expect(dataPoint.value.sum).toBe(15);
      expect(dataPoint.attributes).toEqual({'gen_ai.agent.name': 'my-agent'});
    });

    it('records 0 if the agent produced no content', async () => {
      recordAgentResponseSize('my-agent', undefined);

      expect(
        (await collectDataPoint('gen_ai.agent.response.size')).value.sum,
      ).toBe(0);
    });
  });

  describe('recordAgentWorkflowSteps', () => {
    it('records the given workflow step count', async () => {
      recordAgentWorkflowSteps('my-agent', 3);

      const dataPoint = await collectDataPoint('gen_ai.agent.workflow.steps');
      expect(dataPoint.value.sum).toBe(3);
      expect(dataPoint.attributes).toEqual({'gen_ai.agent.name': 'my-agent'});
    });
  });

  describe('recordClientOperationDuration', () => {
    it('records the request and response models', async () => {
      recordClientOperationDuration({
        agentName: 'test_agent',
        elapsedS: 0.1,
        llmRequest: llmRequest('model-a'),
        response: {modelVersion: 'model-a-v1'},
      });

      const dataPoint = await collectDataPoint(
        'gen_ai.client.operation.duration',
      );
      expect(dataPoint.value.sum).toBe(0.1);
      expect(dataPoint.attributes).toEqual({
        'gen_ai.agent.name': 'test_agent',
        'gen_ai.operation.name': 'generate_content',
        'gen_ai.provider.name': 'gemini',
        'gen_ai.request.model': 'model-a',
        'gen_ai.response.model': 'model-a-v1',
      });
    });

    it('reports vertex_ai when GOOGLE_GENAI_USE_VERTEXAI is set', async () => {
      vi.stubEnv('GOOGLE_GENAI_USE_VERTEXAI', 'true');

      recordClientOperationDuration({
        agentName: 'test_agent',
        elapsedS: 0.1,
        llmRequest: llmRequest('model-a'),
      });

      const dataPoint = await collectDataPoint(
        'gen_ai.client.operation.duration',
      );
      expect(dataPoint.attributes['gen_ai.provider.name']).toBe('vertex_ai');
    });

    it('falls back to the request model when the response omits it', async () => {
      recordClientOperationDuration({
        agentName: 'test_agent',
        elapsedS: 0.1,
        llmRequest: llmRequest('model-a'),
        response: {},
      });

      const dataPoint = await collectDataPoint(
        'gen_ai.client.operation.duration',
      );
      expect(dataPoint.attributes['gen_ai.response.model']).toBe('model-a');
    });

    it('omits the response model when no response arrived', async () => {
      recordClientOperationDuration({
        agentName: 'test_agent',
        elapsedS: 0.1,
        llmRequest: llmRequest('model-a'),
      });

      const dataPoint = await collectDataPoint(
        'gen_ai.client.operation.duration',
      );
      expect(dataPoint.attributes).not.toHaveProperty('gen_ai.response.model');
    });

    it('omits both models when neither is known', async () => {
      recordClientOperationDuration({
        agentName: 'test_agent',
        elapsedS: 0.1,
        llmRequest: llmRequest(undefined),
        response: {},
      });

      const dataPoint = await collectDataPoint(
        'gen_ai.client.operation.duration',
      );
      expect(dataPoint.attributes).toEqual({
        'gen_ai.agent.name': 'test_agent',
        'gen_ai.operation.name': 'generate_content',
        'gen_ai.provider.name': 'gemini',
      });
    });

    it('adds the error type when the call failed', async () => {
      recordClientOperationDuration({
        agentName: 'test_agent',
        elapsedS: 0.2,
        llmRequest: llmRequest('model-a'),
        error: new TypeError('LLM error'),
      });

      const dataPoint = await collectDataPoint(
        'gen_ai.client.operation.duration',
      );
      expect(dataPoint.attributes['error.type']).toBe('TypeError');
    });
  });

  describe('recordClientTokenUsage', () => {
    const usageResponse: LlmResponse = {
      modelVersion: 'test-model-v1',
      usageMetadata: {
        promptTokenCount: 20,
        candidatesTokenCount: 30,
        toolUsePromptTokenCount: 5,
        thoughtsTokenCount: 10,
      },
    };

    it('splits the usage into an input and an output measurement', async () => {
      recordClientTokenUsage({
        agentName: 'test_agent',
        llmRequest: llmRequest('test-model'),
        response: usageResponse,
      });

      const metric = await collectHistogram('gen_ai.client.token.usage');
      expect(metric.dataPoints).toHaveLength(2);
      const baseAttributes = {
        'gen_ai.agent.name': 'test_agent',
        'gen_ai.operation.name': 'generate_content',
        'gen_ai.provider.name': 'gemini',
        'gen_ai.request.model': 'test-model',
        'gen_ai.response.model': 'test-model-v1',
      };

      const input = metric.dataPoints.find(
        (dataPoint) => dataPoint.attributes['gen_ai.token.type'] === 'input',
      );
      const output = metric.dataPoints.find(
        (dataPoint) => dataPoint.attributes['gen_ai.token.type'] === 'output',
      );
      if (!input || !output) {
        expect.fail('missing input or output token usage');
      }
      // prompt (20) + tool use (5), and candidates (30) + thoughts (10).
      expect(input.value.sum).toBe(25);
      expect(input.attributes).toEqual({
        ...baseAttributes,
        'gen_ai.token.type': 'input',
      });
      expect(output.value.sum).toBe(40);
      expect(output.attributes).toEqual({
        ...baseAttributes,
        'gen_ai.token.type': 'output',
      });
    });

    it('records only the input side when there is no output', async () => {
      recordClientTokenUsage({
        agentName: 'test_agent',
        llmRequest: llmRequest('test-model'),
        response: {usageMetadata: {promptTokenCount: 10}},
      });

      const dataPoint = await collectDataPoint('gen_ai.client.token.usage');
      expect(dataPoint.value.sum).toBe(10);
      expect(dataPoint.attributes['gen_ai.token.type']).toBe('input');
      expect(dataPoint.attributes['gen_ai.response.model']).toBe('test-model');
    });

    it('records only the output side when there is no input', async () => {
      recordClientTokenUsage({
        agentName: 'test_agent',
        llmRequest: llmRequest('test-model'),
        response: {usageMetadata: {candidatesTokenCount: 12}},
      });

      const dataPoint = await collectDataPoint('gen_ai.client.token.usage');
      expect(dataPoint.value.sum).toBe(12);
      expect(dataPoint.attributes['gen_ai.token.type']).toBe('output');
    });

    it('records nothing when there is no response', async () => {
      recordClientTokenUsage({
        agentName: 'test_agent',
        llmRequest: llmRequest('test-model'),
      });

      expect((await collectHistograms()).has('gen_ai.client.token.usage')).toBe(
        false,
      );
    });

    it('warns and records nothing when the usage metadata is missing', async () => {
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});

      recordClientTokenUsage({
        agentName: 'test_agent',
        llmRequest: llmRequest('test-model'),
        response: {},
      });

      expect(warn).toHaveBeenCalledWith(
        'Skipping missing token usage metadata for agent test_agent and model test-model',
      );
      expect((await collectHistograms()).has('gen_ai.client.token.usage')).toBe(
        false,
      );
    });

    it('records nothing when every count is zero', async () => {
      recordClientTokenUsage({
        agentName: 'test_agent',
        llmRequest: llmRequest('test-model'),
        response: {
          usageMetadata: {
            promptTokenCount: 0,
            toolUsePromptTokenCount: 0,
            candidatesTokenCount: 0,
            thoughtsTokenCount: 0,
          },
        },
      });

      expect((await collectHistograms()).has('gen_ai.client.token.usage')).toBe(
        false,
      );
    });
  });

  describe('meter provider resolution', () => {
    it('records against a provider registered after the first call', async () => {
      metrics.disable();
      recordAgentInvocationDuration('test_agent', 1.0);

      provider = installMeterProvider();
      recordAgentInvocationDuration('test_agent', 2.0);

      const dataPoint = await collectDataPoint('gen_ai.invoke_agent.duration');
      expect(dataPoint.value.count).toBe(1);
      expect(dataPoint.value.sum).toBe(2.0);
    });

    it('never throws a telemetry failure at the caller', () => {
      const throwingProvider: ApiMeterProvider = {
        getMeter() {
          throw new Error('meter unavailable');
        },
      };
      const debug = vi.spyOn(logger, 'debug').mockImplementation(() => {});
      metrics.disable();
      metrics.setGlobalMeterProvider(throwingProvider);

      expect(() => {
        recordAgentInvocationDuration('test_agent', 1.0);
        recordToolExecutionDuration('t', 'FunctionTool', 'test_agent', 1.0);
        recordAgentRequestSize('test_agent', {parts: [{text: 'x'}]});
        recordAgentResponseSize('test_agent', {parts: [{text: 'x'}]});
        recordAgentWorkflowSteps('test_agent', 1);
        recordClientOperationDuration({
          agentName: 'test_agent',
          elapsedS: 1.0,
          llmRequest: llmRequest('model-a'),
        });
        recordClientTokenUsage({
          agentName: 'test_agent',
          llmRequest: llmRequest('model-a'),
          response: {usageMetadata: {promptTokenCount: 1}},
        });
      }).not.toThrow();
      expect(debug).toHaveBeenCalledTimes(7);
    });

    it('is a no-op when no meter provider is configured', () => {
      metrics.disable();

      expect(() => {
        recordAgentInvocationDuration('test_agent', 1.0);
        recordToolExecutionDuration('t', 'FunctionTool', 'test_agent', 1.0);
        recordAgentRequestSize('test_agent', {parts: [{text: 'x'}]});
        recordAgentResponseSize('test_agent', {parts: [{text: 'x'}]});
        recordAgentWorkflowSteps('test_agent', 1);
        recordClientOperationDuration({
          agentName: 'test_agent',
          elapsedS: 1.0,
          llmRequest: llmRequest('model-a'),
        });
        recordClientTokenUsage({
          agentName: 'test_agent',
          llmRequest: llmRequest('model-a'),
          response: {usageMetadata: {promptTokenCount: 1}},
        });
      }).not.toThrow();
    });
  });
});
