/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Event, LlmResponse, RunConfig} from '@google/adk';
import {BasePlugin, Context, LlmAgent} from '@google/adk';
import {GenerateContentResponse} from '@google/genai';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {createRunner} from './test_case_utils.js';

function toGenAIResponse(response: LlmResponse): GenerateContentResponse {
  const result = new GenerateContentResponse();

  result.candidates = [
    {
      content: response.content,
      groundingMetadata: response.groundingMetadata,
      finishReason: response.finishReason,
    },
  ];
  result.usageMetadata = response.usageMetadata;

  return result;
}

/**
 * A plugin that captures all model responses.
 */
export class ModelEventCapturePlugin extends BasePlugin {
  private modelResponses: GenerateContentResponse[] = [];

  async afterModelCallback(params: {
    callbackContext: Context;
    llmResponse: LlmResponse;
  }): Promise<LlmResponse | undefined> {
    this.modelResponses.push(toGenAIResponse(params.llmResponse));
    return params.llmResponse;
  }

  dump(fileName: string): Promise<void> {
    const modelResponses = this.modelResponses;
    this.modelResponses = [];

    return fs.writeFile(
      path.join(process.cwd(), fileName),
      JSON.stringify(modelResponses, null, 2),
    );
  }
}

/**
 * A plugin that captures all agent events.
 */
export class AgentEventCapturePlugin extends BasePlugin {
  private events: Event[] = [];

  async onEventCallback(params: {event: Event}): Promise<Event | undefined> {
    this.events.push(params.event);
    return params.event;
  }

  dump(fileName: string): Promise<void> {
    const events = this.events;
    this.events = [];

    return fs.writeFile(
      path.join(process.cwd(), fileName),
      JSON.stringify(events, null, 2),
    );
  }
}

/**
 * Runs the agent with the given prompt and plugins.
 */
export async function runAndCapture(
  agent: LlmAgent,
  prompts: string | string[],
  {
    runConfig,
    events,
    modelResponses,
  }: {
    runConfig?: RunConfig;
    events?: string | boolean;
    modelResponses?: string | boolean;
  },
) {
  const plugins: BasePlugin[] = [];
  if (events) {
    plugins.push(new AgentEventCapturePlugin('agent_events'));
  }
  if (modelResponses) {
    plugins.push(new ModelEventCapturePlugin('model_responses'));
  }
  const runner = await createRunner(agent, plugins, runConfig);

  prompts = Array.isArray(prompts) ? prompts : [prompts];

  let i = 1;
  for (const prompt of prompts) {
    for await (const _e of runner.run(prompt)) {
      // Do nothing. The plugins will capture events and model responses.
    }

    for (const plugin of plugins) {
      if (plugin instanceof AgentEventCapturePlugin) {
        plugin.dump(
          typeof events === 'boolean'
            ? `events_turn_${i}.json`
            : (events as string),
        );
      }
      if (plugin instanceof ModelEventCapturePlugin) {
        plugin.dump(
          typeof modelResponses === 'boolean'
            ? `model_responses_turn_${i}.json`
            : (modelResponses as string),
        );
      }
    }

    i++;
  }
}
