/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  FunctionTool,
  InMemoryRunner,
  LlmAgent,
  maybeSetOtelProviders,
} from '@google/adk';
import {createUserContent} from '@google/genai';
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import {describe, expect, it} from 'vitest';
import {z} from 'zod';

describe('E2E Telemetry Tool Call Tracing', () => {
  const envPath = path.resolve(__dirname, '../../../.env');
  const envExists = fs.existsSync(envPath);

  if (envExists) {
    dotenv.config({path: envPath});
  }

  const isPlaceholder = (val: string | undefined) =>
    !val ||
    val.trim() === '' ||
    val.toLowerCase().includes('placeholder') ||
    val.toLowerCase().includes('todo') ||
    val.toLowerCase().includes('your-');

  const hasAKey =
    (!!process.env.GEMINI_API_KEY &&
      !isPlaceholder(process.env.GEMINI_API_KEY)) ||
    (!!process.env.GOOGLE_GENAI_API_KEY &&
      !isPlaceholder(process.env.GOOGLE_GENAI_API_KEY)) ||
    (!!process.env.GOOGLE_CLOUD_PROJECT &&
      !isPlaceholder(process.env.GOOGLE_CLOUD_PROJECT));

  it.skipIf(!hasAKey)(
    'should generate spans with correct attributes for tool calls',
    async () => {
      const exporter = new InMemorySpanExporter();
      const spanProcessor = new SimpleSpanProcessor(exporter);

      maybeSetOtelProviders([{spanProcessors: [spanProcessor]}]);

      const testTool = new FunctionTool({
        name: 'getWeather',
        description: 'Get weather for a city',
        parameters: z.object({
          city: z.string(),
        }),
        execute: async ({city}) => {
          return {weather: `Sunny in ${city}`};
        },
      });

      const agent = new LlmAgent({
        name: 'weather_agent',
        description: 'A weather agent.',
        instruction: 'Call the getWeather tool when user asks for weather.',
        model: 'gemini-2.5-flash',
        tools: [testTool],
      });

      const runner = new InMemoryRunner({
        agent,
        appName: 'e2e_tracing_test',
      });

      const session = await runner.sessionService.createSession({
        appName: 'e2e_tracing_test',
        userId: 'test_user',
      });

      for await (const _event of runner.runAsync({
        userId: 'test_user',
        sessionId: session.id,
        newMessage: createUserContent('What is the weather in Seattle?'),
      })) {
        // Run until completion
      }

      const spans = exporter.getFinishedSpans();

      // Let's find the tool execution spans
      const toolSpans = spans.filter((s) => s.name.startsWith('execute_tool'));
      expect(toolSpans.length).toBeGreaterThanOrEqual(1);

      const singleToolSpan = toolSpans.find(
        (s) => s.name === 'execute_tool getWeather',
      );
      expect(singleToolSpan).toBeDefined();
      expect(singleToolSpan!.attributes['gen_ai.operation.name']).toBe(
        'execute_tool',
      );
      expect(singleToolSpan!.attributes['gen_ai.tool.name']).toBe('getWeather');
      expect(singleToolSpan!.attributes['gen_ai.tool.type']).toBe(
        'FunctionTool',
      );
      expect(
        singleToolSpan!.attributes['gcp.vertex.agent.tool_call_args'],
      ).toContain('Seattle');
      expect(
        singleToolSpan!.attributes['gcp.vertex.agent.tool_response'],
      ).toContain('Sunny');
    },
    30000,
  );
});
