/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import camelcaseKeys from 'camelcase-keys';
import yaml from 'js-yaml';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {
  toCamelKeys,
  toSnakeKeys,
  writeYamlFile,
} from '../../src/conformance/yaml_writer.js';
import {Recordings} from '../../src/integration/test_types.js';

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-yaml-writer-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, {recursive: true, force: true});
  }
});

describe('toSnakeKeys', () => {
  it('renames a camelCase key at every depth', () => {
    const value = {
      userMessageIndex: 0,
      llmRecording: {llmRequest: {previousInteractionId: 'i-1'}},
      recordings: [{agentName: 'dice_agent'}],
    };

    expect(toSnakeKeys(value)).toEqual({
      user_message_index: 0,
      llm_recording: {llm_request: {previous_interaction_id: 'i-1'}},
      recordings: [{agent_name: 'dice_agent'}],
    });
  });

  it('drops a property whose value is undefined', () => {
    expect(toSnakeKeys({agentName: 'a', errorCode: undefined})).toEqual({
      agent_name: 'a',
    });
  });

  it('drops the live tool objects an llm request carries', () => {
    const value = {
      llmRequest: {
        model: 'fake-model',
        toolsDict: {rollDie: {name: 'rollDie'}},
      },
    };

    expect(toSnakeKeys(value)).toEqual({llm_request: {model: 'fake-model'}});
  });

  it('keeps the keys the agent or the test author chose', () => {
    const value = {
      initialState: {userName: 'ada'},
      stateDelta: {userName: 'grace'},
      artifactDelta: {'Report.PDF': 2},
      customMetadata: {traceId: 't-1'},
      toolCall: {args: {maxResults: 2}},
      toolResponse: {response: {firstHit: 'x'}},
    };

    expect(toSnakeKeys(value)).toEqual({
      initial_state: {userName: 'ada'},
      state_delta: {userName: 'grace'},
      artifact_delta: {'Report.PDF': 2},
      custom_metadata: {traceId: 't-1'},
      tool_call: {args: {maxResults: 2}},
      tool_response: {response: {firstHit: 'x'}},
    });
  });

  it('returns an array, a primitive and null unchanged in shape', () => {
    expect(toSnakeKeys([1, 'twoWords', null])).toEqual([1, 'twoWords', null]);
    expect(toSnakeKeys('userName')).toBe('userName');
    expect(toSnakeKeys(7)).toBe(7);
    expect(toSnakeKeys(null)).toBeNull();
    expect(toSnakeKeys({errorCode: null})).toEqual({error_code: null});
  });
});

describe('toCamelKeys', () => {
  it('renames a snake_case key at every depth', () => {
    const value = {
      user_message_index: 0,
      llm_recording: {llm_request: {previous_interaction_id: 'i-1'}},
      recordings: [{agent_name: 'dice_agent'}],
    };

    expect(toCamelKeys(value)).toEqual({
      userMessageIndex: 0,
      llmRecording: {llmRequest: {previousInteractionId: 'i-1'}},
      recordings: [{agentName: 'dice_agent'}],
    });
  });

  it('keeps the keys the agent or the test author chose', () => {
    const value = {
      initial_state: {user_name: 'ada'},
      state_delta: {user_name: 'grace'},
      artifact_delta: {'Report.PDF': 2},
      custom_metadata: {trace_id: 't-1'},
      tool_call: {args: {num_sides: 6}},
      tool_response: {response: {die_result: 4}},
    };

    expect(toCamelKeys(value)).toEqual({
      initialState: {user_name: 'ada'},
      stateDelta: {user_name: 'grace'},
      artifactDelta: {'Report.PDF': 2},
      customMetadata: {trace_id: 't-1'},
      toolCall: {args: {num_sides: 6}},
      toolResponse: {response: {die_result: 4}},
    });
  });

  it('returns an array, a primitive and null unchanged in shape', () => {
    expect(toCamelKeys([1, 'two_words', null])).toEqual([1, 'two_words', null]);
    expect(toCamelKeys('user_name')).toBe('user_name');
    expect(toCamelKeys(null)).toBeNull();
    expect(toCamelKeys({error_code: null})).toEqual({errorCode: null});
  });

  it('undoes toSnakeKeys, opaque values included', () => {
    const value = {
      userMessageIndex: 0,
      toolRecording: {
        toolCall: {args: {num_sides: 6}},
        toolResponse: {response: {die_result: 4}},
      },
      stateDelta: {user_name: 'ada'},
    };

    expect(toCamelKeys(toSnakeKeys(value))).toEqual(value);
  });
});

describe('writeYamlFile', () => {
  it('creates the directories the file needs', async () => {
    const file = path.join(
      await makeTempDir(),
      'category',
      'case',
      'generated-recordings.yaml',
    );

    await writeYamlFile(file, {recordings: []});

    await expect(fs.readFile(file, 'utf-8')).resolves.toContain('recordings');
  });

  it('writes snake_case that reads back as the original object', async () => {
    const file = path.join(await makeTempDir(), 'generated-recordings.yaml');
    const value = {recordings: [{userMessageIndex: 0, agentName: 'a'}]};

    await writeYamlFile(file, value);

    const raw = await fs.readFile(file, 'utf-8');
    expect(raw).toContain('user_message_index: 0');
    expect(camelcaseKeys(yaml.load(raw) as object, {deep: true})).toEqual(
      value,
    );
  });

  it('writes a long string on one line', async () => {
    const file = path.join(await makeTempDir(), 'long.yaml');
    const text = 'rolled a 4. '.repeat(40);

    await writeYamlFile(file, {longText: text});

    const raw = await fs.readFile(file, 'utf-8');
    expect(raw.trimEnd().split('\n')).toHaveLength(1);
  });
});

/**
 * Ported from adk-python
 * `tests/unittests/cli/plugins/test_recordings_schema.py`.
 *
 * The recorder writes the fixture and the replayer reads it back, so anything
 * the round trip loses is silently lost from a replay run.
 */
describe('recordings round trip', () => {
  it('test_recordings_round_trip_through_yaml_preserves_recordings', async () => {
    const recordings: Recordings = {
      recordings: [
        {
          userMessageIndex: 0,
          agentName: 'dice_agent',
          toolRecording: {
            toolCall: {id: 'fc-1', name: 'roll_die', args: {sides: 6}},
            toolResponse: {id: 'fc-1', name: 'roll_die', response: {result: 4}},
          },
        },
        {
          userMessageIndex: 1,
          agentName: 'dice_agent',
          llmRecording: {
            llmRequest: {
              model: 'fake-model',
              contents: [{role: 'user', parts: [{text: 'roll a die'}]}],
              liveConnectConfig: {},
              toolsDict: {},
            },
            llmResponses: [
              {content: {role: 'model', parts: [{text: 'rolled a 4'}]}},
            ],
          },
        },
      ],
    };
    const file = path.join(await makeTempDir(), 'generated-recordings.yaml');

    await writeYamlFile(file, recordings);
    const reloaded = camelcaseKeys(
      yaml.load(await fs.readFile(file, 'utf-8')) as object,
      {deep: true},
    ) as Recordings;

    // `toolsDict` is the one field the writer drops, so compare against the
    // fixture without it rather than against the fixture itself.
    expect(reloaded.recordings[1].llmRecording?.llmRequest).not.toHaveProperty(
      'toolsDict',
    );
    const toolRecording = reloaded.recordings[0].toolRecording;
    expect(toolRecording?.toolCall?.name).toBe('roll_die');
    expect(toolRecording?.toolCall?.args).toEqual({sides: 6});
    expect(toolRecording?.toolResponse?.response).toEqual({result: 4});
    const llmRecording = reloaded.recordings[1].llmRecording;
    expect(llmRecording?.llmRequest?.model).toBe('fake-model');
    expect(llmRecording?.llmResponses?.[0].content?.parts?.[0].text).toBe(
      'rolled a 4',
    );
  });
});
