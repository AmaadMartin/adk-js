/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {StreamingMode} from '@google/adk';
import yaml from 'js-yaml';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {runConformanceRecord} from '../../src/conformance/cli_record.js';
import {
  AGENT_YAML,
  ConformanceWorkspace,
  scriptedResponses,
  SINGLE_TURN_SPEC,
  textResponse,
  TOOL_AGENT_YAML,
} from './conformance_workspace.js';

const CASE_NAME = 'core/case_001';

function readYaml(file: string): Promise<Record<string, unknown>> {
  return fs
    .readFile(file, 'utf-8')
    .then((raw) => yaml.load(raw) as Record<string, unknown>);
}

describe('runConformanceRecord', () => {
  let workspace: ConformanceWorkspace;

  async function setUp(
    spec = SINGLE_TURN_SPEC,
    agentYaml = AGENT_YAML,
  ): Promise<string> {
    await workspace.writeAgent(agentYaml);
    return workspace.writeTestCase(CASE_NAME, spec);
  }

  function record(streamingMode = StreamingMode.NONE): Promise<void> {
    return runConformanceRecord({
      testPaths: [workspace.testsDir],
      streamingMode,
      agentsDir: workspace.agentsDir,
    });
  }

  beforeEach(async () => {
    scriptedResponses.length = 0;
    workspace = await ConformanceWorkspace.create();
  });

  afterEach(async () => {
    await workspace.remove();
  });

  it('writes both generated files, one recording per model call', async () => {
    const caseDir = await setUp();
    scriptedResponses.push(textResponse('hi there'));

    await record();

    expect(
      await readYaml(path.join(caseDir, 'generated-recordings.yaml')),
    ).toEqual({
      recordings: [
        expect.objectContaining({
          user_message_index: 0,
          agent_name: 'my_agent',
          llm_recording: expect.objectContaining({
            llm_responses: [
              {content: {role: 'model', parts: [{text: 'hi there'}]}},
            ],
          }),
        }),
      ],
    });
    expect(
      await readYaml(path.join(caseDir, 'generated-session.yaml')),
    ).toMatchObject({app_name: 'test-runner', id: 'test-session'});
  });

  it('records one entry per user message, in call order', async () => {
    const caseDir = await setUp(`description: Two turns
agent: my_agent
user_messages:
  - text: first
  - text: second
`);
    scriptedResponses.push(textResponse('one'), textResponse('two'));

    await record();

    const recordings = (await readYaml(
      path.join(caseDir, 'generated-recordings.yaml'),
    )) as {recordings: Array<{user_message_index: number}>};
    expect(recordings.recordings.map((r) => r.user_message_index)).toEqual([
      0, 1,
    ]);
  });

  it('records nothing for a spec that sends no user message', async () => {
    const caseDir = await setUp(`description: Sends nothing
agent: my_agent
`);

    await record();

    expect(
      await readYaml(path.join(caseDir, 'generated-recordings.yaml')),
    ).toEqual({recordings: []});
  });

  it('applies the initial state as the first message state delta', async () => {
    const caseDir = await setUp(`description: Starts from a state
agent: my_agent
initial_state:
  userName: ada
user_messages:
  - text: hello
`);
    scriptedResponses.push(textResponse('hi ada'));

    await record();

    expect(
      await fs.readFile(path.join(caseDir, 'generated-session.yaml'), 'utf-8'),
    ).toContain('userName: ada');
  });

  it('leaves no stale fixture behind when a re-record fails', async () => {
    const caseDir = await setUp();
    scriptedResponses.push(textResponse('recorded once'));
    await record();

    await fs.writeFile(
      path.join(caseDir, 'spec.yaml'),
      `description: Names an unknown agent
agent: missing_agent
user_messages:
  - text: hello
`,
    );
    await expect(record()).rejects.toThrow(
      'Agent missing_agent not found in registry',
    );

    await expect(
      fs.stat(path.join(caseDir, 'generated-recordings.yaml')),
    ).rejects.toThrow();
    await expect(
      fs.stat(path.join(caseDir, 'generated-session.yaml')),
    ).rejects.toThrow();
  });

  it('writes the sse pair and leaves the non-streaming pair alone', async () => {
    const caseDir = await setUp();
    const nonStreamingFile = path.join(caseDir, 'generated-recordings.yaml');
    await fs.writeFile(nonStreamingFile, 'recordings: []\n');
    scriptedResponses.push(textResponse('streamed'));

    await record(StreamingMode.SSE);

    expect(await fs.readFile(nonStreamingFile, 'utf-8')).toBe(
      'recordings: []\n',
    );
    await expect(
      readYaml(path.join(caseDir, 'generated-recordings-sse.yaml')),
    ).resolves.toMatchObject({recordings: expect.any(Array)});
    await expect(
      fs.stat(path.join(caseDir, 'generated-session-sse.yaml')),
    ).resolves.toBeDefined();
  });

  it('gives a function response the id of the pending call it answers', async () => {
    const caseDir = await setUp(
      `description: Answers a long running tool
agent: my_agent
user_messages:
  - text: please approve
  - content:
      parts:
        - function_response:
            name: ask_for_approval
            response:
              status: approved
`,
      TOOL_AGENT_YAML,
    );
    scriptedResponses.push(
      {
        content: {
          role: 'model',
          parts: [
            {
              functionCall: {
                id: 'call-42',
                name: 'ask_for_approval',
                args: {purpose: 'travel', amount: 100},
              },
            },
          ],
        },
      },
      textResponse('approved, thanks'),
    );

    await record();

    const session = await fs.readFile(
      path.join(caseDir, 'generated-session.yaml'),
      'utf-8',
    );
    expect(session).toContain('id: call-42');
    expect(session).toContain('status: approved');

    const recordings = (await readYaml(
      path.join(caseDir, 'generated-recordings.yaml'),
    )) as {
      recordings: Array<{tool_recording?: {tool_call?: {name?: string}}}>;
    };
    expect(
      recordings.recordings.map((r) => r.tool_recording?.tool_call?.name),
    ).toContain('ask_for_approval');
  });

  it('fails a case whose function response answers no pending call', async () => {
    await setUp(
      `description: Answers nothing
agent: my_agent
user_messages:
  - content:
      parts:
        - function_response:
            name: ask_for_approval
            response:
              status: approved
`,
      TOOL_AGENT_YAML,
    );

    await expect(record()).rejects.toThrow(
      'Function response for ask_for_approval does not match any pending function call.',
    );
  });

  it('fails a case whose agent is not in the registry', async () => {
    await setUp(`description: Names an unknown agent
agent: missing_agent
user_messages:
  - text: hello
`);

    await expect(record()).rejects.toThrow(
      'Agent missing_agent not found in registry',
    );
  });

  it('rejects a streaming mode that has no fixture set', async () => {
    await setUp();

    await expect(record(StreamingMode.BIDI)).rejects.toThrow(
      'Unsupported streaming mode: bidi',
    );
  });
});
