/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {
  LocalEvalSetResultsManager,
  NotFoundError,
} from '../../src/server/local_eval_set_results_manager.js';
import {getTempDir, removeFolder} from '../../src/utils/file_utils.js';

describe('LocalEvalSetResultsManager', () => {
  let tmpDir: string;
  let manager: LocalEvalSetResultsManager;

  beforeEach(async () => {
    tmpDir = getTempDir('local_eval_test');
    await fs.mkdir(tmpDir, {recursive: true});
    manager = new LocalEvalSetResultsManager(tmpDir);
  });

  afterEach(async () => {
    await removeFolder(tmpDir);
  });

  describe('listEvalSetResults', () => {
    it('should return empty list if history directory does not exist', async () => {
      const results = await manager.listEvalSetResults('non-existent-app');
      expect(results).toEqual([]);
    });

    it('should return list of result IDs matching pattern', async () => {
      const appName = 'test-app';
      const historyDir = path.join(tmpDir, appName, '.adk', 'eval_history');
      await fs.mkdir(historyDir, {recursive: true});

      await fs.writeFile(
        path.join(historyDir, 'result1.evalset_result.json'),
        '{}',
      );
      await fs.writeFile(
        path.join(historyDir, 'result2.evalset_result.json'),
        '{}',
      );
      await fs.writeFile(path.join(historyDir, 'other-file.json'), '{}');

      const results = await manager.listEvalSetResults(appName);
      expect(results.sort()).toEqual(['result1', 'result2'].sort());
    });

    it('should reject invalid app names to prevent directory traversal', async () => {
      await expect(manager.listEvalSetResults('../outside')).rejects.toThrow(
        'Invalid app name',
      );
      await expect(manager.listEvalSetResults('invalid/name')).rejects.toThrow(
        'Invalid app name',
      );
      await expect(manager.listEvalSetResults('')).rejects.toThrow(
        'App name cannot be empty',
      );
    });
  });

  describe('getEvalSetResult', () => {
    it('should return parsed JSON content if file exists', async () => {
      const appName = 'test-app';
      const historyDir = path.join(tmpDir, appName, '.adk', 'eval_history');
      await fs.mkdir(historyDir, {recursive: true});

      const mockResult = {
        evalSetResultId: 'result1',
        evalSetId: 'set1',
        evalCaseResults: [],
        creationTimestamp: 1234567890,
      };

      await fs.writeFile(
        path.join(historyDir, 'result1.evalset_result.json'),
        JSON.stringify(mockResult),
      );

      const result = await manager.getEvalSetResult(appName, 'result1');
      expect(result).toEqual(mockResult);
    });

    it('should throw NotFoundError if file does not exist', async () => {
      const appName = 'test-app';
      const historyDir = path.join(tmpDir, appName, '.adk', 'eval_history');
      await fs.mkdir(historyDir, {recursive: true});

      await expect(
        manager.getEvalSetResult(appName, 'non-existent'),
      ).rejects.toThrow(NotFoundError);
    });

    it('should throw NotFoundError if history directory does not exist', async () => {
      await expect(
        manager.getEvalSetResult('non-existent-app', 'result1'),
      ).rejects.toThrow(NotFoundError);
    });

    it('should throw error if file content is invalid JSON', async () => {
      const appName = 'test-app';
      const historyDir = path.join(tmpDir, appName, '.adk', 'eval_history');
      await fs.mkdir(historyDir, {recursive: true});

      await fs.writeFile(
        path.join(historyDir, 'invalid.evalset_result.json'),
        'invalid json',
      );

      await expect(
        manager.getEvalSetResult(appName, 'invalid'),
      ).rejects.toThrow(SyntaxError);
    });

    it('should reject invalid app names or result IDs to prevent directory traversal', async () => {
      await expect(
        manager.getEvalSetResult('../outside', 'result1'),
      ).rejects.toThrow('Invalid app name');
      await expect(
        manager.getEvalSetResult('test-app', '../outside'),
      ).rejects.toThrow('Invalid eval result ID');
      await expect(
        manager.getEvalSetResult('test-app', 'invalid/id'),
      ).rejects.toThrow('Invalid eval result ID');
    });
  });
});
