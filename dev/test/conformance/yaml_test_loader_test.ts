/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {StreamingMode} from '@google/adk';
import fg from 'fast-glob';
import * as fs from 'node:fs/promises';
import {Readable} from 'node:stream';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {
  batchLoadYamlTestDefs,
  goldenFileNames,
} from '../../src/conformance/yaml_test_loader.js';

vi.mock('fast-glob', () => ({
  default: {
    stream: vi.fn(),
  },
}));

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
}));

const SPEC_YAML = `
description: Test description
agent: test-agent
initial_state:
  key: value
user_messages:
  - text: hello
`;

const SESSION_YAML = `
app_name: test-app
user_id: user-1
id: session-1
events:
  - author: user
    content:
      parts:
        - text: hello
`;

const RECORDINGS_YAML = `
recordings:
  - user_message_index: 0
    agent_name: test-agent
    llm_recording:
      llm_responses:
        - content:
            parts:
              - text: hi
`;

const SSE_RECORDINGS_YAML = `
recordings:
  - user_message_index: 0
    agent_name: test-agent
    llm_recording:
      llm_responses:
        - partial: true
          content:
            parts:
              - text: 'h'
        - content:
            parts:
              - text: hi
`;

/** A rejection shaped like the one node:fs raises for a missing file. */
function fileNotFoundError(filePath: string): Error {
  return Object.assign(
    new Error(`ENOENT: no such file or directory, open '${filePath}'`),
    {code: 'ENOENT'},
  );
}

describe('batchLoadYamlTestDefs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Silence console.log during tests
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  it('should load and parse test definitions recursively', async () => {
    const rootDir = '/root/tests';
    const mockFiles = ['/root/tests/category/test1/spec.yaml'];

    vi.mocked(fg.stream).mockReturnValue(Readable.from(mockFiles));

    vi.mocked(fs.readFile).mockImplementation(async (target) => {
      const filePath = String(target);
      if (filePath.endsWith('spec.yaml')) return SPEC_YAML;
      if (filePath.endsWith('generated-session.yaml')) return SESSION_YAML;
      if (filePath.endsWith('generated-recordings.yaml'))
        return RECORDINGS_YAML;
      throw new Error(`File not found: ${filePath}`);
    });

    const tests = await batchLoadYamlTestDefs(rootDir, StreamingMode.NONE);

    expect(fg.stream).toHaveBeenCalledWith('**/spec.{yaml,yml}', {
      cwd: rootDir,
      absolute: true,
    });

    expect(tests.size).toBe(1);
    const test = tests.get('category/test1');
    expect(test).toBeDefined();
    expect(test?.name).toBe('category/test1');

    // Check spec parsing and camelCase conversion
    expect(test?.spec).toMatchObject({
      description: 'Test description',
      agent: 'test-agent',
      initialState: {key: 'value'},
      userMessages: [{text: 'hello'}],
    });

    // Check session parsing and camelCase conversion
    expect(test?.session).toMatchObject({
      appName: 'test-app',
      userId: 'user-1',
      id: 'session-1',
    });

    // Check recordings parsing and camelCase conversion
    expect(test?.recordings.recordings[0]).toMatchObject({
      userMessageIndex: 0,
      agentName: 'test-agent',
    });
  });

  it('should handle multiple tests in different directories', async () => {
    const rootDir = '/root/tests';
    const mockFiles = ['/root/tests/t1/spec.yaml', '/root/tests/t2/spec.yaml'];

    vi.mocked(fg.stream).mockReturnValue(Readable.from(mockFiles));
    vi.mocked(fs.readFile).mockResolvedValue('{}');

    const tests = await batchLoadYamlTestDefs(rootDir, StreamingMode.NONE);
    expect(tests.size).toBe(2);
    expect(tests.has('t1')).toBe(true);
    expect(tests.has('t2')).toBe(true);
  });

  it('should load and parse test definitions with Windows-style paths', async () => {
    const rootDir = 'C:\\root\\tests';
    const mockFiles = ['C:\\root\\tests\\category\\test1\\spec.yaml'];

    vi.mocked(fg.stream).mockReturnValue(Readable.from(mockFiles));

    vi.mocked(fs.readFile).mockImplementation(async (target) => {
      const filePath = String(target);
      if (filePath.includes('spec.yaml')) return SPEC_YAML;
      if (filePath.includes('generated-session.yaml')) return SESSION_YAML;
      if (filePath.includes('generated-recordings.yaml'))
        return RECORDINGS_YAML;
      throw new Error(`File not found: ${filePath}`);
    });

    const tests = await batchLoadYamlTestDefs(rootDir, StreamingMode.NONE);

    expect(fg.stream).toHaveBeenCalledWith('**/spec.{yaml,yml}', {
      cwd: rootDir,
      absolute: true,
    });

    expect(tests.size).toBe(1);
    const expectedKey = 'category/test1';
    const test = tests.get(expectedKey);
    expect(test).toBeDefined();
    expect(test?.name).toBe(expectedKey);
    expect(test?.spec.agent).toBe('test-agent');
  });

  it('should throw an error if a required file is missing', async () => {
    const rootDir = '/root/tests';
    vi.mocked(fg.stream).mockReturnValue(
      Readable.from(['/root/tests/t1/spec.yaml']),
    );
    vi.mocked(fs.readFile).mockRejectedValue(new Error('File not found'));

    await expect(
      batchLoadYamlTestDefs(rootDir, StreamingMode.NONE),
    ).rejects.toThrow('File not found');
  });

  it('should throw an error if a golden is not a YAML mapping', async () => {
    const rootDir = '/root/tests';
    vi.mocked(fg.stream).mockReturnValue(
      Readable.from(['/root/tests/t1/spec.yaml']),
    );
    vi.mocked(fs.readFile).mockImplementation(async (target) => {
      const filePath = String(target);
      if (filePath.endsWith('spec.yaml')) return SPEC_YAML;
      return 'just a string';
    });

    await expect(
      batchLoadYamlTestDefs(rootDir, StreamingMode.NONE),
    ).rejects.toThrow(
      '/root/tests/t1/generated-session.yaml must be a YAML mapping',
    );
  });

  it('should load the -sse goldens in SSE mode', async () => {
    const rootDir = '/root/tests';
    vi.mocked(fg.stream).mockReturnValue(
      Readable.from(['/root/tests/category/test1/spec.yaml']),
    );

    const readPaths: string[] = [];
    vi.mocked(fs.readFile).mockImplementation(async (target) => {
      const filePath = String(target);
      readPaths.push(filePath);
      if (filePath.endsWith('spec.yaml')) return SPEC_YAML;
      if (filePath.endsWith('generated-session-sse.yaml')) return SESSION_YAML;
      if (filePath.endsWith('generated-recordings-sse.yaml'))
        return SSE_RECORDINGS_YAML;
      throw fileNotFoundError(filePath);
    });

    const tests = await batchLoadYamlTestDefs(rootDir, StreamingMode.SSE);

    expect(readPaths).toEqual([
      '/root/tests/category/test1/spec.yaml',
      '/root/tests/category/test1/generated-session-sse.yaml',
      '/root/tests/category/test1/generated-recordings-sse.yaml',
    ]);
    expect(
      tests.get('category/test1')?.recordings.recordings[0].llmRecording
        ?.llmResponses,
    ).toEqual([
      {partial: true, content: {parts: [{text: 'h'}]}},
      {content: {parts: [{text: 'hi'}]}},
    ]);
  });

  it('should propagate a golden read failure that is not ENOENT', async () => {
    const rootDir = '/root/tests';
    vi.mocked(fg.stream).mockReturnValue(
      Readable.from(['/root/tests/t1/spec.yaml']),
    );

    vi.mocked(fs.readFile).mockImplementation(async (target) => {
      const filePath = String(target);
      if (filePath.endsWith('spec.yaml')) return SPEC_YAML;
      throw Object.assign(new Error('permission denied'), {code: 'EACCES'});
    });

    await expect(
      batchLoadYamlTestDefs(rootDir, StreamingMode.NONE),
    ).rejects.toThrow('permission denied');
  });

  it('should skip a test whose goldens for the selected mode are missing', async () => {
    const rootDir = '/root/tests';
    vi.mocked(fg.stream).mockReturnValue(
      Readable.from(['/root/tests/t1/spec.yaml', '/root/tests/t2/spec.yaml']),
    );

    vi.mocked(fs.readFile).mockImplementation(async (target) => {
      const filePath = String(target);
      if (filePath.endsWith('spec.yaml')) return SPEC_YAML;
      if (filePath.startsWith('/root/tests/t1/')) {
        throw fileNotFoundError(filePath);
      }
      if (filePath.endsWith('generated-session-sse.yaml')) return SESSION_YAML;
      return SSE_RECORDINGS_YAML;
    });

    const tests = await batchLoadYamlTestDefs(rootDir, StreamingMode.SSE);

    expect([...tests.keys()]).toEqual(['t2']);
  });
});

describe('goldenFileNames', () => {
  it('should name the -sse goldens for SSE', () => {
    expect(goldenFileNames(StreamingMode.SSE)).toEqual({
      recordings: 'generated-recordings-sse.yaml',
      session: 'generated-session-sse.yaml',
    });
  });

  it('should name the plain goldens for NONE', () => {
    expect(goldenFileNames(StreamingMode.NONE)).toEqual({
      recordings: 'generated-recordings.yaml',
      session: 'generated-session.yaml',
    });
  });

  it('should reject a mode that has no goldens', () => {
    expect(() => goldenFileNames(StreamingMode.BIDI)).toThrow(
      'Unsupported streaming mode: bidi',
    );
  });
});
