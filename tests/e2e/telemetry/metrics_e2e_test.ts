/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Agent,
  BaseLlm,
  BaseLlmConnection,
  FunctionTool,
  InMemoryRunner,
  LlmRequest,
  LlmResponse,
  maybeSetOtelProviders,
} from '@google/adk';
import {createUserContent} from '@google/genai';
import {metrics, trace} from '@opentelemetry/api';
import {MetricReader} from '@opentelemetry/sdk-metrics';
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

interface MetricDataPoint {
  attributes: Record<string, unknown>;
  value: unknown;
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
    const metricMap = new Map();

    for (const scopeMetric of metricsCollection.resourceMetrics.scopeMetrics) {
      for (const metric of scopeMetric.metrics) {
        metricMap.set(metric.descriptor.name, metric);
      }
    }

    // Verify gen_ai.agent.invocation.duration
    expect(metricMap.has('gen_ai.agent.invocation.duration')).toBe(true);
    const durationMetric = metricMap.get('gen_ai.agent.invocation.duration');
    expect(durationMetric.dataPoints.length).toBeGreaterThan(0);
    const durationDataPoint = durationMetric.dataPoints[0] as MetricDataPoint;
    expect(durationDataPoint.attributes).toEqual({
      'gen_ai.agent.name': 'metrics_e2e_agent',
    });

    // Verify gen_ai.agent.request.size
    expect(metricMap.has('gen_ai.agent.request.size')).toBe(true);
    const requestSizeMetric = metricMap.get('gen_ai.agent.request.size');
    expect(requestSizeMetric.dataPoints.length).toBeGreaterThan(0);
    const requestSizeDataPoint = requestSizeMetric
      .dataPoints[0] as MetricDataPoint;
    expect(requestSizeDataPoint.attributes).toEqual({
      'gen_ai.agent.name': 'metrics_e2e_agent',
    });

    // Verify gen_ai.agent.response.size
    expect(metricMap.has('gen_ai.agent.response.size')).toBe(true);
    const responseSizeMetric = metricMap.get('gen_ai.agent.response.size');
    expect(responseSizeMetric.dataPoints.length).toBeGreaterThan(0);
    const responseSizeDataPoint = responseSizeMetric
      .dataPoints[0] as MetricDataPoint;
    expect(responseSizeDataPoint.attributes).toEqual({
      'gen_ai.agent.name': 'metrics_e2e_agent',
    });

    // Verify gen_ai.client.token.usage
    expect(metricMap.has('gen_ai.client.token.usage')).toBe(true);
    const tokenUsageMetric = metricMap.get('gen_ai.client.token.usage');
    expect(tokenUsageMetric.dataPoints.length).toBe(2); // input and output token types

    const dataPoints = tokenUsageMetric.dataPoints as MetricDataPoint[];
    const inputTokenPoint = dataPoints.find(
      (dp) => dp.attributes['gen_ai.token.type'] === 'input',
    );
    expect(inputTokenPoint).toBeDefined();
    expect((inputTokenPoint!.value as {sum: number}).sum).toBe(30);
    expect(inputTokenPoint!.attributes).toEqual({
      'gen_ai.agent.name': 'metrics_e2e_agent',
      'gen_ai.operation.name': 'generate_content',
      'gen_ai.provider.name': 'gemini',
      'gen_ai.request.model': 'fake-model',
      'gen_ai.response.model': 'fake-model-v2',
      'gen_ai.token.type': 'input',
    });

    const outputTokenPoint = dataPoints.find(
      (dp) => dp.attributes['gen_ai.token.type'] === 'output',
    );
    expect(outputTokenPoint).toBeDefined();
    expect((outputTokenPoint!.value as {sum: number}).sum).toBe(50);
    expect(outputTokenPoint!.attributes).toEqual({
      'gen_ai.agent.name': 'metrics_e2e_agent',
      'gen_ai.operation.name': 'generate_content',
      'gen_ai.provider.name': 'gemini',
      'gen_ai.request.model': 'fake-model',
      'gen_ai.response.model': 'fake-model-v2',
      'gen_ai.token.type': 'output',
    });

    // Verify gen_ai.tool.execution.duration
    expect(metricMap.has('gen_ai.tool.execution.duration')).toBe(true);
    const toolDurationMetric = metricMap.get('gen_ai.tool.execution.duration');
    expect(toolDurationMetric.dataPoints.length).toBeGreaterThan(0);
    const toolDurationDataPoint = toolDurationMetric
      .dataPoints[0] as MetricDataPoint;
    expect(toolDurationDataPoint.attributes).toEqual({
      'gen_ai.agent.name': 'metrics_e2e_agent',
      'gen_ai.tool.name': 'fake_tool',
    });
  });
});
