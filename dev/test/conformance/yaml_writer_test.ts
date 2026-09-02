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
import {toSnakeKeys, writeYamlFile} from '../../src/conformance/yaml_writer.js';

const RECORDINGS_FIXTURE = {
  recordings: [
    {
      user_message_index: 0,
      agent_name: 'test-agent',
      llm_recording: {
        llm_request: {model: 'gemini-2.0-flash'},
        llm_response: {content: {parts: [{text: 'hi'}], role: 'model'}},
      },
    },
  ],
};

describe('toSnakeKeys', () => {
  it('is the inverse of a deep camelcase-keys read', () => {
    const camelCased = camelcaseKeys(RECORDINGS_FIXTURE, {deep: true});

    expect(toSnakeKeys(camelCased)).toEqual(RECORDINGS_FIXTURE);
  });

  it('keeps the keys of a state delta, an initial state and tool args', () => {
    const value = {
      initialState: {userName: 'ada'},
      stateDelta: {userName: 'grace'},
      toolRecording: {
        toolCall: {name: 'lookup', args: {maxResults: 2}},
        toolResponse: {name: 'lookup', response: {firstHit: 'x'}},
      },
    };

    expect(toSnakeKeys(value)).toEqual({
      initial_state: {userName: 'ada'},
      state_delta: {userName: 'grace'},
      tool_recording: {
        tool_call: {name: 'lookup', args: {maxResults: 2}},
        tool_response: {name: 'lookup', response: {firstHit: 'x'}},
      },
    });
  });

  it('keeps the keys of an artifact delta and custom metadata', () => {
    const value = {artifactDelta: {'Report.PDF': 2}, customMetadata: {aB: 1}};

    expect(toSnakeKeys(value)).toEqual({
      artifact_delta: {'Report.PDF': 2},
      custom_metadata: {aB: 1},
    });
  });

  it('passes arrays, null and primitives through unchanged', () => {
    expect(toSnakeKeys(null)).toBeNull();
    expect(toSnakeKeys('userName')).toBe('userName');
    expect(toSnakeKeys([1, null, {userName: 'ada'}])).toEqual([
      1,
      null,
      {user_name: 'ada'},
    ]);
    expect(toSnakeKeys({errorCode: null})).toEqual({error_code: null});
  });

  it('drops a property whose value is undefined', () => {
    expect(toSnakeKeys({errorCode: undefined, agentName: 'a'})).toEqual({
      agent_name: 'a',
    });
  });

  it('drops the live tool objects of an llm request', () => {
    const value = {
      llmRequest: {model: 'stub', toolsDict: {lookup: {execute: () => 1}}},
    };

    expect(toSnakeKeys(value)).toEqual({llm_request: {model: 'stub'}});
  });
});

describe('writeYamlFile', () => {
  const created: string[] = [];

  afterEach(async () => {
    for (const dir of created.splice(0)) {
      await fs.rm(dir, {recursive: true, force: true});
    }
  });

  it('writes a snake_case document that reads back camelCased', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-yaml-writer-'));
    created.push(dir);
    const file = path.join(dir, 'generated-recordings.yaml');

    await writeYamlFile(file, camelcaseKeys(RECORDINGS_FIXTURE, {deep: true}));

    const raw = await fs.readFile(file, 'utf-8');
    expect(raw).toContain('user_message_index: 0');
    expect(camelcaseKeys(yaml.load(raw) as object, {deep: true})).toEqual(
      camelcaseKeys(RECORDINGS_FIXTURE, {deep: true}),
    );
  });
});
