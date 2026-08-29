/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {StreamingMode} from '@google/adk';
import yaml from 'js-yaml';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {
  generatedFileNames,
  writeGeneratedYaml,
} from '../../src/conformance/generated_files.js';

describe('generatedFileNames', () => {
  it('names the non-streaming goldens', () => {
    expect(generatedFileNames(StreamingMode.NONE)).toEqual({
      sessionFile: 'generated-session.yaml',
      recordingsFile: 'generated-recordings.yaml',
    });
  });

  it('names the sse goldens', () => {
    expect(generatedFileNames(StreamingMode.SSE)).toEqual({
      sessionFile: 'generated-session-sse.yaml',
      recordingsFile: 'generated-recordings-sse.yaml',
    });
  });

  it('rejects a streaming mode that has no goldens', () => {
    expect(() => generatedFileNames(StreamingMode.BIDI)).toThrow(
      'Unsupported streaming mode: bidi',
    );
  });
});

describe('writeGeneratedYaml', () => {
  let directory: string;
  let file: string;

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-generated-'));
    file = path.join(directory, 'generated.yaml');
  });

  afterEach(async () => {
    await fs.rm(directory, {recursive: true, force: true});
  });

  async function writeAndLoad(value: unknown): Promise<unknown> {
    await writeGeneratedYaml(file, value);
    return yaml.load(await fs.readFile(file, 'utf-8'));
  }

  it('writes object keys in snake_case', async () => {
    expect(
      await writeAndLoad({
        recordings: [{userMessageIndex: 0, llmRecording: {llmResponses: []}}],
      }),
    ).toEqual({
      recordings: [{user_message_index: 0, llm_recording: {llm_responses: []}}],
    });
  });

  it('keeps the keys of session state as the agent wrote them', async () => {
    expect(await writeAndLoad({state: {myKey: 1, other_key: 2}})).toEqual({
      state: {myKey: 1, other_key: 2},
    });
  });

  it('keeps the keys of a state delta as the agent wrote them', async () => {
    expect(
      await writeAndLoad({actions: {stateDelta: {userName: 'ada'}}}),
    ).toEqual({actions: {state_delta: {userName: 'ada'}}});
  });

  it('keeps the keys of tool arguments and a tool response', async () => {
    expect(
      await writeAndLoad({
        toolCall: {args: {someArg: 1}},
        toolResponse: {response: {someField: {nestedField: 2}}},
      }),
    ).toEqual({
      tool_call: {args: {someArg: 1}},
      tool_response: {response: {someField: {nestedField: 2}}},
    });
  });

  it('keeps the keys of custom metadata and an artifact delta', async () => {
    expect(
      await writeAndLoad({
        customMetadata: {traceId: 'abc'},
        artifactDelta: {'myFile.txt': 1},
      }),
    ).toEqual({
      custom_metadata: {traceId: 'abc'},
      artifact_delta: {'myFile.txt': 1},
    });
  });

  it('keeps a null inside an opaque subtree', async () => {
    expect(await writeAndLoad({state: {chosen: null}})).toEqual({
      state: {chosen: null},
    });
  });

  it('keeps schema property names and still converts the schema keywords', async () => {
    expect(
      await writeAndLoad({
        parameters: {properties: {myParam: {anyOf: [{type: 'string'}]}}},
      }),
    ).toEqual({
      parameters: {properties: {myParam: {any_of: [{type: 'string'}]}}},
    });
  });

  it('passes through a properties value that is not an object', async () => {
    expect(await writeAndLoad({parameters: {properties: 'malformed'}})).toEqual(
      {parameters: {properties: 'malformed'}},
    );
  });

  it('converts an object that has a null prototype', async () => {
    // Session state reaches callers with a null prototype, so an object built
    // from it is a record even though its prototype is not Object.prototype.
    const nullPrototype = Object.assign(Object.create(null), {someKey: 1});

    expect(await writeAndLoad({actions: nullPrototype})).toEqual({
      actions: {some_key: 1},
    });
  });

  it('omits the live tool objects of an llm request', async () => {
    expect(
      await writeAndLoad({
        llmRequest: {model: 'gemini-3-pro', toolsDict: {roll_die: () => 4}},
      }),
    ).toEqual({llm_request: {model: 'gemini-3-pro'}});
  });

  it('omits a property whose value is undefined or null', async () => {
    expect(
      await writeAndLoad({
        agentName: 'agent-a',
        errorCode: undefined,
        errorMessage: null,
      }),
    ).toEqual({agent_name: 'agent-a'});
  });

  it('keeps the declaration order of the keys', async () => {
    await writeGeneratedYaml(file, {userMessageIndex: 0, agentName: 'a'});

    expect(await fs.readFile(file, 'utf-8')).toBe(
      'user_message_index: 0\nagent_name: a\n',
    );
  });

  it('writes a repeated object twice instead of a yaml anchor', async () => {
    const shared = {text: 'hello'};

    await writeGeneratedYaml(file, {first: shared, second: shared});

    expect(await fs.readFile(file, 'utf-8')).toBe(
      'first:\n  text: hello\nsecond:\n  text: hello\n',
    );
  });
});
