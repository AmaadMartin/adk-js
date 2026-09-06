/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ported from adk-python `main`,
 * `tests/unittests/tools/environment/test_edit_file_tool.py`. Test names are
 * kept verbatim so the two suites can be compared by name.
 */

import {EditFileTool, LocalEnvironment} from '@google/adk';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {makeContext} from './environment_test_utils.js';

describe('TestEditFileTool', () => {
  let tmpDir: string;
  let env: LocalEnvironment;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk_edit_file_test_'));
    env = new LocalEnvironment({workingDir: tmpDir});
    await env.initialize();
  });

  afterEach(async () => {
    await env.close();
    await fs.rm(tmpDir, {recursive: true, force: true});
  });

  async function readBack(filePath: string): Promise<string> {
    return new TextDecoder().decode(await env.readFile(filePath));
  }

  it('test_edit_file_handles_line_breaks_linux_file_windows_search', async () => {
    const tool = new EditFileTool(env);
    await env.writeFile('test.txt', 'line1\nline2\nline3');

    const result = (await tool.runAsync({
      args: {
        path: 'test.txt',
        old_string: 'line1\r\nline2',
        new_string: 'line1_replaced\nline2_replaced',
      },
      toolContext: makeContext(),
    })) as {status: string};

    expect(result.status).toBe('ok');
    expect(await readBack('test.txt')).toBe(
      'line1_replaced\nline2_replaced\nline3',
    );
  });

  it('test_edit_file_handles_line_breaks_windows_file_linux_search', async () => {
    const tool = new EditFileTool(env);
    await env.writeFile('test.txt', 'line1\r\nline2\r\nline3');

    const result = (await tool.runAsync({
      args: {
        path: 'test.txt',
        old_string: 'line1\nline2',
        new_string: 'line1_replaced\r\nline2_replaced',
      },
      toolContext: makeContext(),
    })) as {status: string};

    expect(result.status).toBe('ok');
    expect(await readBack('test.txt')).toBe(
      'line1_replaced\r\nline2_replaced\r\nline3',
    );
  });

  it('test_edit_file_fails_on_multiple_matches', async () => {
    const tool = new EditFileTool(env);
    await env.writeFile('test.txt', 'line1\nline2\nline1\nline2');

    const result = (await tool.runAsync({
      args: {
        path: 'test.txt',
        old_string: 'line1\nline2',
        new_string: 'replaced',
      },
      toolContext: makeContext(),
    })) as {status: string; error: string};

    expect(result.status).toBe('error');
    expect(result.error).toContain('appears 2 times');
  });

  it('test_edit_file_exact_match_works', async () => {
    const tool = new EditFileTool(env);
    await env.writeFile('test.txt', 'line1\nline2\nline3');

    const result = (await tool.runAsync({
      args: {
        path: 'test.txt',
        old_string: 'line1\nline2',
        new_string: 'replaced',
      },
      toolContext: makeContext(),
    })) as {status: string};

    expect(result.status).toBe('ok');
    expect(await readBack('test.txt')).toBe('replaced\nline3');
  });

  it('test_edit_file_handles_special_regex_chars', async () => {
    const tool = new EditFileTool(env);
    await env.writeFile('test.txt', 'line1.content\nline2');

    const result = (await tool.runAsync({
      args: {
        path: 'test.txt',
        old_string: 'line1.content',
        new_string: 'replaced',
      },
      toolContext: makeContext(),
    })) as {status: string};

    expect(result.status).toBe('ok');
    expect(await readBack('test.txt')).toBe('replaced\nline2');
  });
});
