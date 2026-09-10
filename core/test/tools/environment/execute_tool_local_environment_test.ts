/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Drives `ExecuteTool` against a real `LocalEnvironment` running real shell
 * commands, with no doubles anywhere. The other suites script the environment,
 * so this is what proves the tool works end to end on a live host.
 */

import {ExecuteTool, LocalEnvironment} from '@google/adk';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {makeConfirmedContext, makeContext} from './environment_test_utils.js';

/**
 * Commands are built from the Node binary running the tests so that they work
 * under both `sh` and `cmd.exe`. The outer double quotes survive both shells;
 * the inner JavaScript string literals stay single-quoted.
 */
const NODE = `"${process.execPath}"`;

/** Spawning a child process is slow on Windows CI runners. */
const SPAWN_TIMEOUT_MS = 30_000;

describe('ExecuteTool against a real LocalEnvironment', () => {
  let tmpRoot: string;
  let environment: LocalEnvironment;
  let tool: ExecuteTool;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'adk_execute_tool_'));
    environment = new LocalEnvironment({workingDir: tmpRoot});
    await environment.initialize();
    tool = new ExecuteTool(environment);
  });

  afterEach(async () => {
    await environment.close();
    await fs.rm(tmpRoot, {recursive: true, force: true});
  });

  it(
    'runs a real command and returns its output',
    async () => {
      const result = await tool.runAsync({
        args: {command: `${NODE} -e "process.stdout.write('hello')"`},
        toolContext: makeConfirmedContext(),
      });

      expect(result).toEqual({status: 'ok', stdout: 'hello'});
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    'reports a real non-zero exit code alongside stderr',
    async () => {
      const result = await tool.runAsync({
        args: {
          command: `${NODE} -e "process.stderr.write('boom');process.exit(3)"`,
        },
        toolContext: makeConfirmedContext(),
      });

      expect(result).toEqual({
        status: 'error',
        stderr: 'boom',
        exit_code: 3,
      });
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    'runs the command in the environment working directory',
    async () => {
      await fs.writeFile(path.join(tmpRoot, 'marker.txt'), 'found');

      const result = await tool.runAsync({
        args: {
          command: `${NODE} -e "process.stdout.write(require('node:fs').readFileSync('marker.txt','utf8'))"`,
        },
        toolContext: makeConfirmedContext(),
      });

      expect(result).toEqual({status: 'ok', stdout: 'found'});
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    'truncates real output that exceeds the cap',
    async () => {
      const cappedTool = new ExecuteTool(environment, {maxOutputChars: 10});

      const result = await cappedTool.runAsync({
        args: {command: `${NODE} -e "process.stdout.write('x'.repeat(25))"`},
        toolContext: makeConfirmedContext(),
      });

      expect(result).toEqual({
        status: 'ok',
        stdout: `${'x'.repeat(10)}\n... (truncated, 25 total chars)`,
      });
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    'does not run the command until the client confirms it',
    async () => {
      const witness = path.join(tmpRoot, 'ran.txt');
      const command = `${NODE} -e "require('node:fs').writeFileSync('ran.txt','yes')"`;

      const pending = await tool.runAsync({
        args: {command},
        toolContext: makeContext(),
      });

      expect(pending).toEqual({
        partial:
          'This tool call needs external confirmation before completion.',
      });
      await expect(fs.access(witness)).rejects.toThrow();

      const confirmed = await tool.runAsync({
        args: {command},
        toolContext: makeConfirmedContext(),
      });

      expect(confirmed).toEqual({status: 'ok'});
      expect(await fs.readFile(witness, 'utf8')).toBe('yes');
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    'reports an uninitialized environment as an error rather than throwing',
    async () => {
      const closed = new LocalEnvironment({workingDir: tmpRoot});
      const closedTool = new ExecuteTool(closed);

      const result = await closedTool.runAsync({
        args: {command: `${NODE} -e ""`},
        toolContext: makeConfirmedContext(),
      });

      expect(result).toEqual({
        status: 'error',
        error: 'Environment is not initialized. Call initialize() first.',
      });
    },
    SPAWN_TIMEOUT_MS,
  );
});
