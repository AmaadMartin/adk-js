/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Drives a real `Runner` through a full turn with a tool call and reads back
 * the file `DebugLoggingPlugin` wrote. The model is scripted so the run stays
 * offline; everything else is the real runtime.
 */

import {
  BaseLlm,
  BaseLlmConnection,
  DebugEntryType,
  DebugLoggingPlugin,
  Event,
  FunctionTool,
  InMemoryRunner,
  LlmAgent,
  LlmRequest,
  LlmResponse,
} from '@google/adk';
import {createUserContent} from '@google/genai';
import yaml from 'js-yaml';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {z} from 'zod/v3';

const APP_NAME = 'debug_logging_app';
const SENTINEL_API_KEY = 'sentinel-api-key-3c91fe';

/** A model that replays a fixed script, so the turn's tool call is exact. */
class ScriptedLlm extends BaseLlm {
  private index = 0;

  constructor(private readonly script: LlmResponse[]) {
    super({model: 'scripted-llm'});
  }

  async *generateContentAsync(
    _request: LlmRequest,
  ): AsyncGenerator<LlmResponse, void, void> {
    yield this.script[this.index++] ?? {
      content: {role: 'model', parts: [{text: 'ok'}]},
    };
  }

  async connect(_request: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error('Live connections are not used in this test.');
  }
}

let tempDir = '';
let outputFile = '';

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-debug-e2e-'));
  outputFile = path.join(tempDir, 'adk_debug.yaml');
});

afterEach(async () => {
  await fs.rm(tempDir, {recursive: true, force: true});
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

describe('DebugLoggingPlugin over a real Runner', () => {
  it('writes one document holding the whole turn in callback order', async () => {
    const lookup = new FunctionTool({
      name: 'lookup_city',
      description: 'Looks a city up.',
      parameters: z.object({city: z.string()}),
      execute: async ({city}) => ({
        city,
        population: 8_000_000,
        'api_key': SENTINEL_API_KEY,
      }),
    });
    const agent = new LlmAgent({
      name: 'debug_agent',
      model: new ScriptedLlm([
        {
          content: {
            role: 'model',
            parts: [
              {
                functionCall: {
                  id: 'fc-1',
                  name: 'lookup_city',
                  args: {city: 'Zurich'},
                },
              },
            ],
          },
        },
        {content: {role: 'model', parts: [{text: 'Zurich has 8 million.'}]}},
      ]),
      instruction: 'Answer questions about cities.',
      tools: [lookup],
    });
    const runner = new InMemoryRunner({
      agent,
      appName: APP_NAME,
      plugins: [new DebugLoggingPlugin({outputPath: outputFile})],
    });
    const session = await runner.sessionService.createSession({
      appName: APP_NAME,
      userId: 'user',
    });

    const events: Event[] = [];
    for await (const event of runner.runAsync({
      userId: 'user',
      sessionId: session.id,
      newMessage: createUserContent('How big is Zurich?'),
    })) {
      events.push(event);
    }

    expect(events.length).toBeGreaterThan(0);
    const raw = await fs.readFile(outputFile, 'utf-8');
    const documents = yaml.loadAll(raw);
    expect(documents).toHaveLength(1);
    const document = documents[0];
    if (!isRecord(document)) {
      expect.fail('the debug document is not a mapping');
    }

    expect(document['appName']).toBe(APP_NAME);
    expect(document['sessionId']).toBe(session.id);

    const entries = document['entries'];
    if (!Array.isArray(entries)) {
      expect.fail('the debug document holds no entries list');
    }
    const kinds = entries.map((entry) =>
      isRecord(entry) ? entry['entryType'] : undefined,
    );

    for (const expected of [
      DebugEntryType.INVOCATION_START,
      DebugEntryType.USER_MESSAGE,
      DebugEntryType.LLM_REQUEST,
      DebugEntryType.TOOL_CALL,
      DebugEntryType.TOOL_RESPONSE,
      DebugEntryType.LLM_RESPONSE,
      DebugEntryType.EVENT,
      DebugEntryType.SESSION_STATE_SNAPSHOT,
      DebugEntryType.INVOCATION_END,
    ]) {
      expect(kinds).toContain(expected);
    }

    // The user message reaches the plugin before the run callback, so it must
    // still be recorded, and it must come first.
    expect(kinds[0]).toBe(DebugEntryType.USER_MESSAGE);
    expect(kinds.indexOf(DebugEntryType.TOOL_CALL)).toBeLessThan(
      kinds.indexOf(DebugEntryType.TOOL_RESPONSE),
    );
    expect(kinds[kinds.length - 1]).toBe(DebugEntryType.INVOCATION_END);

    // A secret the tool returned never reaches the file.
    expect(raw).toContain('lookup_city');
    expect(raw).not.toContain(SENTINEL_API_KEY);
  });
});
