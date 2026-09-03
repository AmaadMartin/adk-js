/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Drives a real `Runner` over recordings read from disk, the way a conformance
 * replay runs. `DummyLlm` throws if it is reached, so a passing run also proves
 * no model was called.
 */

import {
  Event,
  FunctionTool,
  InMemorySessionService,
  LlmAgent,
  Runner,
} from '@google/adk';
import yaml from 'js-yaml';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {z} from 'zod';
import {loadRecordings} from '../../src/conformance/recordings_loader.js';
import {DummyLlm} from '../../src/integration/dummy_llm.js';
import {ReplayPlugin} from '../../src/integration/replay_plugin.js';

const APP_NAME = 'conformance';
const AGENT_NAME = 'dice_agent';
const USER_ID = 'test-user';

/** The recorded exchange: the model rolls a die, then reports the result. */
function recordingsDocument(recordedSides: number): string {
  return yaml.dump(
    {
      recordings: [
        {
          user_message_index: 0,
          agent_name: AGENT_NAME,
          llm_recording: {
            llm_response: {
              content: {
                role: 'model',
                parts: [
                  {
                    function_call: {
                      id: 'fc-1',
                      name: 'roll_die',
                      args: {sides: recordedSides},
                    },
                  },
                ],
              },
            },
          },
        },
        {
          user_message_index: 0,
          agent_name: AGENT_NAME,
          tool_recording: {
            tool_call: {id: 'fc-1', name: 'roll_die', args: {sides: 6}},
            tool_response: {
              id: 'fc-1',
              name: 'roll_die',
              response: {result: 4},
            },
          },
        },
        {
          user_message_index: 0,
          agent_name: AGENT_NAME,
          llm_recording: {
            llm_response: {
              content: {role: 'model', parts: [{text: 'You rolled a 4.'}]},
            },
          },
        },
      ],
    },
    {sortKeys: false},
  );
}

describe('ReplayPlugin over a Runner', () => {
  let caseDir: string;
  let liveRolls: number[];
  let agent: LlmAgent;

  beforeEach(async () => {
    caseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-replay-run-'));
    liveRolls = [];
    agent = new LlmAgent({
      name: AGENT_NAME,
      model: new DummyLlm(),
      tools: [
        new FunctionTool({
          name: 'roll_die',
          description: 'Rolls a die.',
          parameters: z.object({sides: z.number()}),
          execute: ({sides}) => {
            liveRolls.push(sides);
            return {result: 1};
          },
        }),
      ],
    });
  });

  afterEach(async () => {
    await fs.rm(caseDir, {recursive: true, force: true});
  });

  async function run(recordedSides: number): Promise<Event[]> {
    await fs.writeFile(
      path.join(caseDir, 'generated-recordings.yaml'),
      recordingsDocument(recordedSides),
      'utf-8',
    );
    const {recordings} = await loadRecordings(caseDir, 'none');

    const sessionService = new InMemorySessionService();
    const session = await sessionService.createSession({
      appName: APP_NAME,
      userId: USER_ID,
    });
    const runner = new Runner({
      appName: APP_NAME,
      agent,
      sessionService,
      plugins: [new ReplayPlugin(recordings, {userMessageIndex: 0})],
    });

    const events: Event[] = [];
    for await (const event of runner.runAsync({
      userId: USER_ID,
      sessionId: session.id,
      newMessage: {role: 'user', parts: [{text: 'roll a die'}]},
    })) {
      events.push(event);
    }
    return events;
  }

  it('should answer from the recording and still run the tool', async () => {
    const events = await run(6);

    const functionResponse = events
      .flatMap((event) => event.content?.parts ?? [])
      .find((part) => part.functionResponse)?.functionResponse;
    expect(functionResponse?.response).toEqual({result: 4});
    // The recorded response wins, but the real tool still ran.
    expect(liveRolls).toEqual([6]);
    expect(events.at(-1)?.content?.parts?.[0].text).toBe('You rolled a 4.');
  });

  it('should fail the run when a recorded argument no longer matches', async () => {
    const events = await run(20);

    // The runner reports a plugin failure as an error event rather than
    // throwing, so the drift surfaces there.
    const errors = events.flatMap((event) => event.errorMessage ?? []);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('ReplayVerificationError: Tool args mismatch');
    expect(errors[0]).toContain('recorded: {"sides":6}');
    expect(liveRolls).toEqual([]);
  });
});
