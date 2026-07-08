/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fsPromises from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {EvalCase, EvalSet} from '../../src/server/evaluation_types.js';
import {
  LocalEvalSetsManager,
  NotFoundError,
} from '../../src/server/local_eval_sets_manager.js';

describe('LocalEvalSetsManager', () => {
  let tempDir: string;
  let manager: LocalEvalSetsManager;
  const appName = 'testApp';

  beforeEach(async () => {
    tempDir = await fsPromises.mkdtemp(
      path.join(os.tmpdir(), 'adk-eval-test-'),
    );
    manager = new LocalEvalSetsManager(tempDir);
  });

  afterEach(async () => {
    await fsPromises.rm(tempDir, {recursive: true, force: true});
  });

  describe('createEvalSet', () => {
    it('should create a new eval set file', async () => {
      const evalSetId = 'test_set';
      const evalSet = await manager.createEvalSet(appName, evalSetId);

      expect(evalSet.evalSetId).toBe(evalSetId);
      expect(evalSet.name).toBe(evalSetId);
      expect(evalSet.evalCases).toEqual([]);
      expect(evalSet.creationTimestamp).toBeGreaterThan(0);

      const filePath = path.join(tempDir, appName, `${evalSetId}.evalset.json`);
      const fileContent = await fsPromises.readFile(filePath, 'utf-8');
      const savedEvalSet = JSON.parse(fileContent) as EvalSet;

      expect(savedEvalSet.evalSetId).toBe(evalSetId);
      expect(savedEvalSet.evalCases).toEqual([]);
    });

    it('should error if eval set already exists', async () => {
      const evalSetId = 'test_set';
      await manager.createEvalSet(appName, evalSetId);

      await expect(manager.createEvalSet(appName, evalSetId)).rejects.toThrow(
        `EvalSet ${evalSetId} already exists for app ${appName}.`,
      );
    });

    it('should error if evalSetId is invalid', async () => {
      await expect(
        manager.createEvalSet(appName, 'invalid-id'),
      ).rejects.toThrow('Invalid Eval Set ID');
    });
  });

  describe('getEvalSet', () => {
    it('should return undefined if eval set does not exist', async () => {
      const evalSet = await manager.getEvalSet(appName, 'non_existent');
      expect(evalSet).toBeUndefined();
    });

    it('should return the eval set if it exists', async () => {
      const evalSetId = 'test_set';
      await manager.createEvalSet(appName, evalSetId);

      const evalSet = await manager.getEvalSet(appName, evalSetId);
      expect(evalSet).toBeDefined();
      expect(evalSet!.evalSetId).toBe(evalSetId);
    });

    it('should load old format and convert it', async () => {
      const evalSetId = 'old_set';
      const oldFormatData = [
        {
          name: 'case1',
          data: [
            {
              query: 'Hello',
              reference: 'Hi',
              expected_tool_use: [{tool_name: 't1', tool_input: {x: 1}}],
              expected_intermediate_agent_responses: [
                {author: 'sub1', text: 'thinking'},
              ],
            },
          ],
          initial_session: {
            app_name: appName,
            user_id: 'user123',
            state: {foo: 'bar'},
          },
        },
      ];

      const appDir = path.join(tempDir, appName);
      await fsPromises.mkdir(appDir, {recursive: true});
      await fsPromises.writeFile(
        path.join(appDir, `${evalSetId}.evalset.json`),
        JSON.stringify(oldFormatData, null, 2),
        'utf-8',
      );

      const evalSet = await manager.getEvalSet(appName, evalSetId);
      expect(evalSet).toBeDefined();
      expect(evalSet!.evalSetId).toBe(evalSetId);
      expect(evalSet!.evalCases.length).toBe(1);

      const evalCase = evalSet!.evalCases[0];
      expect(evalCase.evalId).toBe('case1');
      expect(evalCase.sessionInput).toBeDefined();
      expect(evalCase.sessionInput!.appName).toBe(appName);
      expect(evalCase.sessionInput!.userId).toBe('user123');
      expect(evalCase.sessionInput!.state).toEqual({foo: 'bar'});

      expect(evalCase.conversation).toBeDefined();
      expect(evalCase.conversation!.length).toBe(1);
      const inv = evalCase.conversation![0];
      expect(inv.userContent).toEqual({role: 'user', parts: [{text: 'Hello'}]});
      expect(inv.finalResponse).toEqual({role: 'model', parts: [{text: 'Hi'}]});
      expect(inv.intermediateData).toBeDefined();
      expect(inv.intermediateData.tool_uses).toEqual([
        {name: 't1', args: {x: 1}},
      ]);
      expect(inv.intermediateData.intermediate_responses).toEqual([
        ['sub1', [{text: 'thinking'}]],
      ]);
    });
  });

  describe('listEvalSets', () => {
    it('should error if app directory does not exist', async () => {
      await expect(manager.listEvalSets(appName)).rejects.toThrow(
        NotFoundError,
      );
    });

    it('should return empty list if no eval sets', async () => {
      await fsPromises.mkdir(path.join(tempDir, appName), {recursive: true});
      const list = await manager.listEvalSets(appName);
      expect(list).toEqual([]);
    });

    it('should list eval sets sorted', async () => {
      await manager.createEvalSet(appName, 'set_b');
      await manager.createEvalSet(appName, 'set_a');

      const list = await manager.listEvalSets(appName);
      expect(list).toEqual(['set_a', 'set_b']);
    });
  });

  describe('Case management', () => {
    const evalSetId = 'test_set';
    let evalCase: EvalCase;

    beforeEach(async () => {
      await manager.createEvalSet(appName, evalSetId);
      evalCase = {
        evalId: 'case_1',
        conversation: [],
        creationTimestamp: Date.now() / 1000,
      };
    });

    it('should add a case', async () => {
      await manager.addEvalCase(appName, evalSetId, evalCase);

      const evalSet = await manager.getEvalSet(appName, evalSetId);
      expect(evalSet!.evalCases.length).toBe(1);
      expect(evalSet!.evalCases[0].evalId).toBe('case_1');
    });

    it('should error when adding duplicate case', async () => {
      await manager.addEvalCase(appName, evalSetId, evalCase);
      await expect(
        manager.addEvalCase(appName, evalSetId, evalCase),
      ).rejects.toThrow(
        `Eval id "${evalCase.evalId}" already exists in "${evalSetId}" eval set.`,
      );
    });

    it('should get a case', async () => {
      await manager.addEvalCase(appName, evalSetId, evalCase);
      const retrieved = await manager.getEvalCase(appName, evalSetId, 'case_1');
      expect(retrieved).toBeDefined();
      expect(retrieved!.evalId).toBe('case_1');

      const notFound = await manager.getEvalCase(
        appName,
        evalSetId,
        'non_existent',
      );
      expect(notFound).toBeUndefined();
    });

    it('should update a case', async () => {
      await manager.addEvalCase(appName, evalSetId, evalCase);

      const updatedCase: EvalCase = {
        ...evalCase,
        conversation: [
          {
            invocationId: '1',
            userContent: {role: 'user', parts: [{text: 'updated'}]},
            creationTimestamp: Date.now() / 1000,
          },
        ],
      };

      await manager.updateEvalCase(appName, evalSetId, updatedCase);

      const retrieved = await manager.getEvalCase(appName, evalSetId, 'case_1');
      expect(retrieved!.conversation!.length).toBe(1);
      expect(retrieved!.conversation![0].userContent.parts[0].text).toBe(
        'updated',
      );
    });

    it('should error when updating non-existent case', async () => {
      await expect(
        manager.updateEvalCase(appName, evalSetId, evalCase),
      ).rejects.toThrow(NotFoundError);
    });

    it('should delete a case', async () => {
      await manager.addEvalCase(appName, evalSetId, evalCase);
      await manager.deleteEvalCase(appName, evalSetId, 'case_1');

      const evalSet = await manager.getEvalSet(appName, evalSetId);
      expect(evalSet!.evalCases.length).toBe(0);
    });

    it('should error when deleting non-existent case', async () => {
      await expect(
        manager.deleteEvalCase(appName, evalSetId, 'case_1'),
      ).rejects.toThrow(NotFoundError);
    });
  });

  describe('Path validation', () => {
    it('should reject invalid path segments', async () => {
      await expect(
        manager.getEvalSet(appName, 'path/traversal'),
      ).rejects.toThrow(
        'evalSetId "path/traversal" must not contain path separators.',
      );
      await expect(manager.getEvalSet('..', 'set')).rejects.toThrow(
        'appName ".." must not contain traversal segments.',
      );
      await expect(manager.getEvalSet('', 'set')).rejects.toThrow(
        'appName must not be empty.',
      );
    });
  });
});
