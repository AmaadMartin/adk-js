/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Event, LlmResponse, RunConfig} from '@google/adk';
import {
  BaseAgent,
  BasePlugin,
  Context,
  InMemoryRunner,
  LlmAgent,
} from '@google/adk';
import {GenerateContentResponse, createUserContent} from '@google/genai';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/**
 * Creates a runner for the given agent.
 * @param agent The agent to create a runner for.
 * @returns A runner for the given agent.
 */
export async function createRunner(
  agent: BaseAgent,
  plugins: BasePlugin[] = [],
  runConfig?: RunConfig,
) {
  const userId = 'test_user';
  const appName = agent.name;
  const runner = new InMemoryRunner({agent: agent, appName, plugins});
  const session = await runner.sessionService.createSession({
    appName,
    userId,
  });

  return {
    run(prompt: string): AsyncGenerator<Event, void, undefined> {
      return runner.runAsync({
        userId,
        sessionId: session.id,
        newMessage: createUserContent(prompt),
        runConfig,
      });
    },
  };
}

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
 * Writes `data` as pretty-printed JSON to `dir/fileName`, creating `dir` if it
 * does not exist. `dir` is always supplied by the caller: dumps are debugging
 * output and must never land in the process working directory, which under
 * vitest is the repository root.
 */
async function writeJsonDump(
  dir: string,
  fileName: string,
  data: unknown,
): Promise<void> {
  await fs.mkdir(dir, {recursive: true});
  return fs.writeFile(path.join(dir, fileName), JSON.stringify(data, null, 2));
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

  /**
   * Writes the captured responses to `dir/fileName` and empties the buffer.
   * @param dir Destination directory. Created if it does not exist.
   * @param fileName Name of the file to write inside `dir`.
   */
  dump(dir: string, fileName: string): Promise<void> {
    const modelResponses = this.modelResponses;
    this.modelResponses = [];

    return writeJsonDump(dir, fileName, modelResponses);
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

  /**
   * Writes the captured events to `dir/fileName` and empties the buffer.
   * @param dir Destination directory. Created if it does not exist.
   * @param fileName Name of the file to write inside `dir`.
   */
  dump(dir: string, fileName: string): Promise<void> {
    const events = this.events;
    this.events = [];

    return writeJsonDump(dir, fileName, events);
  }
}

/**
 * Runs the agent with the given prompts and dumps what the plugins captured.
 *
 * Every dump is written inside `outDir`, which is required and is created if
 * it does not exist. The returned promise resolves only after the last dump is
 * flushed to disk. The dump files are left in place: they are the artifact the
 * caller asked for.
 */
export async function runAndCapture(
  agent: LlmAgent,
  prompts: string | string[],
  {
    outDir,
    runConfig,
    events,
    modelResponses,
  }: {
    /** Directory the dump files are written to. Created if missing. */
    outDir: string;
    runConfig?: RunConfig;
    /** `true` for the default per-turn name, or an explicit file name. */
    events?: string | boolean;
    /** `true` for the default per-turn name, or an explicit file name. */
    modelResponses?: string | boolean;
  },
) {
  const eventPlugin = events
    ? new AgentEventCapturePlugin('agent_events')
    : undefined;
  const modelPlugin = modelResponses
    ? new ModelEventCapturePlugin('model_responses')
    : undefined;
  const plugins = [eventPlugin, modelPlugin].filter((p) => p !== undefined);
  const runner = await createRunner(agent, plugins, runConfig);

  prompts = Array.isArray(prompts) ? prompts : [prompts];

  let i = 1;
  for (const prompt of prompts) {
    for await (const _e of runner.run(prompt)) {
      // Do nothing. The plugins will capture events and model responses.
    }

    if (eventPlugin) {
      await eventPlugin.dump(
        outDir,
        typeof events === 'string' ? events : `events_turn_${i}.json`,
      );
    }
    if (modelPlugin) {
      await modelPlugin.dump(
        outDir,
        typeof modelResponses === 'string'
          ? modelResponses
          : `model_responses_turn_${i}.json`,
      );
    }

    i++;
  }
}
