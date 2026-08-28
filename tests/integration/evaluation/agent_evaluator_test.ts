/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AgentEvaluator,
  EvalFailureError,
  FunctionTool,
  LlmAgent,
} from '@google/adk';
import {FinishReason} from '@google/genai';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {fileURLToPath} from 'node:url';
import {afterEach, describe, expect, it} from 'vitest';
import {z} from 'zod';

import {
  GeminiWithMockResponses,
  RawGenerateContentResponse,
} from '../test_case_utils.js';

const FIXTURE_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'dice',
);

const REFERENCE = 'I rolled a 17 sided die and got 13.\n';

/** A real tool: the agent's roll is fixed so the eval stays deterministic. */
const rollDieTool = new FunctionTool({
  name: 'roll_die',
  description: 'Rolls a die with the given number of sides.',
  parameters: z.object({sides: z.number()}),
  execute: ({sides}) => ({sides, result: 13}),
});

function turn(text: string): RawGenerateContentResponse[] {
  return [
    {
      candidates: [
        {
          content: {
            parts: [
              {
                functionCall: {
                  name: 'roll_die',
                  args: {sides: 17},
                  id: 'adk-roll-die-1',
                },
              },
            ],
            role: 'model',
          },
          finishReason: FinishReason.STOP,
        },
      ],
    },
    {
      candidates: [
        {
          content: {parts: [{text}], role: 'model'},
          finishReason: FinishReason.STOP,
        },
      ],
    },
  ];
}

/** Builds a dice agent whose model replays `turns` recorded answers. */
function diceAgent(texts: string[]): LlmAgent {
  return new LlmAgent({
    name: 'dice_agent',
    model: new GeminiWithMockResponses(texts.flatMap(turn)),
    description: 'Rolls dice on request.',
    instruction: 'Use the roll_die tool, then report the result.',
    tools: [rollDieTool],
  });
}

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

describe('AgentEvaluator end to end', () => {
  it('passes a legacy-format eval file', async () => {
    await expect(
      AgentEvaluator.evaluate({
        agent: diceAgent([REFERENCE]),
        evalDatasetFilePathOrDir: path.join(
          FIXTURE_DIR,
          'roll_legacy.test.json',
        ),
        numRuns: 1,
      }),
    ).resolves.toBeUndefined();
  });

  // The fixture is shaped the way adk-python's model_dump_json writes one:
  // snake_case keys, and every unset optional field spelled as null.
  it('passes an eval-set file authored by adk-python', async () => {
    await expect(
      AgentEvaluator.evaluate({
        agent: diceAgent([REFERENCE]),
        evalDatasetFilePathOrDir: path.join(
          FIXTURE_DIR,
          'roll_evalset.test.json',
        ),
        numRuns: 1,
      }),
    ).resolves.toBeUndefined();
  });

  it('runs every eval file in a directory', async () => {
    await expect(
      AgentEvaluator.evaluate({
        agent: diceAgent([REFERENCE, REFERENCE]),
        evalDatasetFilePathOrDir: FIXTURE_DIR,
        numRuns: 1,
      }),
    ).resolves.toBeUndefined();
  });

  it('fails when the agent answers something else', async () => {
    await expect(
      AgentEvaluator.evaluate({
        agent: diceAgent(['The weather today is sunny.']),
        evalDatasetFilePathOrDir: path.join(
          FIXTURE_DIR,
          'roll_legacy.test.json',
        ),
        numRuns: 1,
      }),
    ).rejects.toThrow(EvalFailureError);
  });

  it('migrates a legacy file into a loadable eval set', async () => {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adk-migrate-'));
    tempDirs.push(outputDir);
    const migrated = path.join(outputDir, 'roll.test.json');
    fs.copyFileSync(
      path.join(FIXTURE_DIR, 'test_config.json'),
      path.join(outputDir, 'test_config.json'),
    );

    AgentEvaluator.migrateEvalDataToNewSchema(
      path.join(FIXTURE_DIR, 'roll_legacy.test.json'),
      migrated,
    );

    expect(fs.readFileSync(migrated, 'utf-8')).toContain('"eval_set_id"');
    await expect(
      AgentEvaluator.evaluate({
        agent: diceAgent([REFERENCE]),
        evalDatasetFilePathOrDir: migrated,
        numRuns: 1,
      }),
    ).resolves.toBeUndefined();
  });
});
