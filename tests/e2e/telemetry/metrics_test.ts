/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {BaseLlmConnection, LlmRequest, LlmResponse} from '@google/adk';
import {
  Agent,
  BaseLlm,
  FunctionTool,
  InMemoryRunner,
  maybeSetOtelProviders,
} from '@google/adk';
import {createUserContent} from '@google/genai';
import {metrics, trace} from '@opentelemetry/api';
import type {
  DataPoint,
  Histogram,
  HistogramMetricData,
} from '@opentelemetry/sdk-metrics';
import {DataPointType, MetricReader} from '@opentelemetry/sdk-metrics';
import {afterAll, describe, expect, it} from 'vitest';
import {z} from 'zod';

class InMemoryMetricReader extends MetricReader {
  protected async onForceFlush(): Promise<void> {}
  protected async onShutdown(): Promise<void> {}
}

class FakeLlm extends BaseLlm {
  private responses: LlmResponse[];

  constructor(responses: LlmResponse[]) {
    super({model: 'fake-model'});
    this.responses = [...responses];
  }

  async *generateContentAsync(
    _llmRequest: LlmRequest,
    _stream?: boolean,
    _abortSignal?: AbortSignal,
  ): AsyncGenerator<LlmResponse, void, void> {
    const nextResponse = this.responses.shift();
    if (nextResponse) {
      yield nextResponse;
    }
  }

  override async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error('Not implemented');
  }
}

/**
 * Returns the data points recorded for `name`, failing the test if the
 * instrument was never recorded.
 */
function dataPointsOf(
  metricMap: Map<string, HistogramMetricData>,
  name: string,
): DataPoint<Histogram>[] {
  const metric = metricMap.get(name);
  expect(metric, `no data recorded for ${name}`).toBeDefined();
  return metric!.dataPoints;
}

describe('E2E Telemetry Metrics Integration', () => {
  afterAll(async () => {
    metrics.disable();
    trace.disable();
  });

  it('should collect usage metrics during agent execution', async () => {
    const inMemoryMetricReader = new InMemoryMetricReader();

    // Register InMemoryMetricReader
    maybeSetOtelProviders([
      {
        metricReaders: [inMemoryMetricReader],
      },
    ]);

    const fakeLlm = new FakeLlm([
      {
        content: {
          role: 'model',
          parts: [
            {
              functionCall: {
                name: 'fake_tool',
                args: {},
              },
            },
          ],
        },
        usageMetadata: {
          promptTokenCount: 15,
          toolUsePromptTokenCount: 0,
          candidatesTokenCount: 25,
          thoughtsTokenCount: 0,
        },
        modelVersion: 'fake-model-v2',
      },
      {
        content: {
          role: 'model',
          parts: [{text: 'Hello! I executed the tool.'}],
        },
        usageMetadata: {
          promptTokenCount: 15,
          toolUsePromptTokenCount: 0,
          candidatesTokenCount: 25,
          thoughtsTokenCount: 0,
        },
        modelVersion: 'fake-model-v2',
      },
    ]);

    const fakeTool = new FunctionTool({
      name: 'fake_tool',
      description: 'A fake tool for testing metrics',
      parameters: z.object({}),
      execute: async () => {
        return {result: 'tool-executed'};
      },
    });

    const agent = new Agent({
      name: 'metrics_e2e_agent',
      model: fakeLlm,
      instruction: 'You are a helpful assistant.',
      tools: [fakeTool],
    });

    const runner = new InMemoryRunner({
      agent,
      appName: 'e2e_metrics_test',
    });

    const session = await runner.sessionService.createSession({
      appName: 'e2e_metrics_test',
      userId: 'test_user',
    });

    // Run the agent
    const generator = runner.runAsync({
      userId: 'test_user',
      sessionId: session.id,
      newMessage: createUserContent('Hi there!'),
    });

    const events = [];
    for await (const event of generator) {
      events.push(event);
    }

    expect(events.length).toBeGreaterThan(0);

    // Collect metrics
    const metricsCollection = await inMemoryMetricReader.collect();
    const metricMap = new Map<string, HistogramMetricData>();

    for (const scopeMetric of metricsCollection.resourceMetrics.scopeMetrics) {
      for (const metric of scopeMetric.metrics) {
        if (metric.dataPointType === DataPointType.HISTOGRAM) {
          metricMap.set(metric.descriptor.name, metric);
        }
      }
    }

    // Verify gen_ai.invoke_agent.duration
    const durationPoints = dataPointsOf(
      metricMap,
      'gen_ai.invoke_agent.duration',
    );
    expect(durationPoints.length).toBe(1);
    expect(durationPoints[0].attributes).toEqual({
      'gen_ai.agent.name': 'metrics_e2e_agent',
    });

    // Verify gen_ai.agent.request.size
    const requestSizePoints = dataPointsOf(
      metricMap,
      'gen_ai.agent.request.size',
    );
    expect(requestSizePoints.length).toBe(1);
    expect(requestSizePoints[0].attributes).toEqual({
      'gen_ai.agent.name': 'metrics_e2e_agent',
    });
    // 'Hi there!' is 9 bytes of UTF-8 text.
    expect(requestSizePoints[0].value.sum).toBe(9);

    // Verify gen_ai.agent.response.size
    const responseSizePoints = dataPointsOf(
      metricMap,
      'gen_ai.agent.response.size',
    );
    expect(responseSizePoints.length).toBe(1);
    expect(responseSizePoints[0].attributes).toEqual({
      'gen_ai.agent.name': 'metrics_e2e_agent',
    });
    // 'Hello! I executed the tool.' is 27 bytes of UTF-8 text.
    expect(responseSizePoints[0].value.sum).toBe(27);

    // Verify gen_ai.agent.workflow.steps
    const stepsPoints = dataPointsOf(metricMap, 'gen_ai.agent.workflow.steps');
    expect(stepsPoints.length).toBe(1);
    expect(stepsPoints[0].attributes).toEqual({
      'gen_ai.agent.name': 'metrics_e2e_agent',
    });
    // The run is deterministic: the agent authors the function call event, the
    // function response event and the final text event.
    expect(stepsPoints[0].value.sum).toBe(3);

    // Verify gen_ai.client.operation.duration
    const operationPoints = dataPointsOf(
      metricMap,
      'gen_ai.client.operation.duration',
    );
    expect(operationPoints.length).toBe(1);
    expect(operationPoints[0].attributes).toEqual({
      'gen_ai.agent.name': 'metrics_e2e_agent',
      'gen_ai.operation.name': 'generate_content',
      'gen_ai.provider.name': 'gemini',
      'gen_ai.request.model': 'fake-model',
      'gen_ai.response.model': 'fake-model-v2',
    });
    // One call for the tool request and one for the final text response.
    expect(operationPoints[0].value.count).toBe(2);

    // Verify gen_ai.client.token.usage
    const tokenPoints = dataPointsOf(metricMap, 'gen_ai.client.token.usage');
    expect(tokenPoints.length).toBe(2); // input and output token types

    const inputTokenPoint = tokenPoints.find(
      (dp) => dp.attributes['gen_ai.token.type'] === 'input',
    );
    expect(inputTokenPoint).toBeDefined();
    expect(inputTokenPoint!.value.sum).toBe(30);
    expect(inputTokenPoint!.attributes).toEqual({
      'gen_ai.agent.name': 'metrics_e2e_agent',
      'gen_ai.operation.name': 'generate_content',
      'gen_ai.provider.name': 'gemini',
      'gen_ai.request.model': 'fake-model',
      'gen_ai.response.model': 'fake-model-v2',
      'gen_ai.token.type': 'input',
    });

    const outputTokenPoint = tokenPoints.find(
      (dp) => dp.attributes['gen_ai.token.type'] === 'output',
    );
    expect(outputTokenPoint).toBeDefined();
    expect(outputTokenPoint!.value.sum).toBe(50);
    expect(outputTokenPoint!.attributes).toEqual({
      'gen_ai.agent.name': 'metrics_e2e_agent',
      'gen_ai.operation.name': 'generate_content',
      'gen_ai.provider.name': 'gemini',
      'gen_ai.request.model': 'fake-model',
      'gen_ai.response.model': 'fake-model-v2',
      'gen_ai.token.type': 'output',
    });

    // Verify gen_ai.execute_tool.duration
    const toolDurationPoints = dataPointsOf(
      metricMap,
      'gen_ai.execute_tool.duration',
    );
    expect(toolDurationPoints.length).toBe(1);
    expect(toolDurationPoints[0].attributes).toEqual({
      'gen_ai.agent.name': 'metrics_e2e_agent',
      'gen_ai.tool.name': 'fake_tool',
      'gen_ai.tool.type': 'FunctionTool',
    });
  });
});
