/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {LlmAgent} from '@google/adk';
import {FinishReason} from '@google/genai';
import {existsSync, readdirSync} from 'node:fs';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {runAndCapture} from './state_dump_utils.js';
import {GeminiWithMockResponses} from './test_case_utils.js';

function agentWithReplies(replies: string[]): LlmAgent {
  return new LlmAgent({
    name: 'state_dump_agent',
    model: new GeminiWithMockResponses(
      replies.map((text) => ({
        candidates: [
          {
            content: {role: 'model', parts: [{text}]},
            finishReason: FinishReason.STOP,
          },
        ],
      })),
    ),
  });
}

async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await readFile(file, 'utf8'));
}

describe('runAndCapture', () => {
  let outDir: string;

  beforeEach(async () => {
    outDir = await mkdtemp(path.join(os.tmpdir(), 'adk-state-dump-'));
  });

  afterEach(async () => {
    await rm(outDir, {recursive: true, force: true});
  });

  it('writes both dumps into outDir with the default names', async () => {
    await runAndCapture(agentWithReplies(['ok']), 'hello', {
      outDir,
      events: true,
      modelResponses: true,
    });

    // Read synchronously: with an unawaited dump() the write has not been
    // issued yet when this line runs, so a sync read is what proves the flush
    // happened.
    expect(readdirSync(outDir)).toEqual(
      expect.arrayContaining([
        'events_turn_1.json',
        'model_responses_turn_1.json',
      ]),
    );

    const events = await readJson(path.join(outDir, 'events_turn_1.json'));
    expect(events).toMatchObject([
      {author: 'state_dump_agent', content: {parts: [{text: 'ok'}]}},
    ]);

    const responses = await readJson(
      path.join(outDir, 'model_responses_turn_1.json'),
    );
    expect(responses).toMatchObject([
      {candidates: [{content: {parts: [{text: 'ok'}]}}]},
    ]);
  });

  it('leaves the repository root clean', async () => {
    await runAndCapture(agentWithReplies(['ok']), 'hello', {
      outDir,
      events: true,
      modelResponses: true,
    });

    expect(existsSync(path.join(process.cwd(), 'events_turn_1.json'))).toBe(
      false,
    );
    expect(
      existsSync(path.join(process.cwd(), 'model_responses_turn_1.json')),
    ).toBe(false);
  });

  it('honours explicit file names', async () => {
    await runAndCapture(agentWithReplies(['ok']), 'hello', {
      outDir,
      events: 'my_events.json',
      modelResponses: 'my_model_responses.json',
    });

    const written = readdirSync(outDir);
    expect(written.sort()).toEqual([
      'my_events.json',
      'my_model_responses.json',
    ]);
  });

  it('writes one file per turn and clears the buffer between turns', async () => {
    await runAndCapture(
      agentWithReplies(['first', 'second']),
      ['ping', 'pong'],
      {
        outDir,
        events: true,
      },
    );

    expect(readdirSync(outDir).sort()).toEqual([
      'events_turn_1.json',
      'events_turn_2.json',
    ]);

    const turn2 = await readFile(
      path.join(outDir, 'events_turn_2.json'),
      'utf8',
    );
    expect(turn2).toContain('second');
    expect(turn2).not.toContain('first');
  });

  it('creates a missing destination directory', async () => {
    const nested = path.join(outDir, 'nested', 'deeper');

    await runAndCapture(agentWithReplies(['ok']), 'hello', {
      outDir: nested,
      events: true,
    });

    expect(readdirSync(nested)).toEqual(['events_turn_1.json']);
  });
});
