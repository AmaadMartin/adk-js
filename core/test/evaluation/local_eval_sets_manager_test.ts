/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  EVAL_SET_FILE_EXTENSION,
  EvalCase,
  EvalCaseSchema,
  EvalSetSchema,
  IntermediateData,
  LegacyEvalCase,
  LocalEvalSetsManager,
  NotFoundError,
  convertEvalSetToSchema,
  loadEvalSetFromFile,
} from '@google/adk';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import * as envAwareUtils from '../../src/utils/env_aware_utils.js';

vi.mock('../../src/utils/env_aware_utils.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/utils/env_aware_utils.js')>();
  return {
    ...actual,
    nowSeconds: vi.fn(() => actual.nowSeconds()),
    randomUUID: vi.fn(() => actual.randomUUID()),
  };
});

const MOCK_TIME = 12345678;
const MOCK_UUID = '15061953';
const APP_NAME = 'test_app';
const EVAL_SET_ID = 'test_eval_set';
const EVAL_CASE_ID = 'test_eval_case';
const INVALID_SEGMENTS = ['', '.', '..', 'foo/bar', 'foo\\bar'];

function makeEvalCase(evalId: string, creationTimestamp = 0): EvalCase {
  return EvalCaseSchema.parse({evalId, conversation: [], creationTimestamp});
}

describe('evaluation/local_eval_sets_manager', () => {
  beforeEach(() => {
    vi.mocked(envAwareUtils.nowSeconds).mockReturnValue(MOCK_TIME);
    vi.mocked(envAwareUtils.randomUUID).mockReturnValue(MOCK_UUID);
  });

  afterEach(() => {
    vi.mocked(envAwareUtils.nowSeconds).mockReset();
    vi.mocked(envAwareUtils.randomUUID).mockReset();
  });

  describe('convertEvalSetToSchema', () => {
    it('converts a complete legacy eval set', () => {
      const legacy: LegacyEvalCase[] = [
        {
          name: 'roll_17_sided_dice_twice',
          data: [
            {
              query: 'What can you do?',
              expected_tool_use: [],
              expected_intermediate_agent_responses: [],
              reference: 'I can roll dice.',
            },
            {
              query: 'Roll a 17 sided dice twice for me',
              expected_tool_use: [
                {tool_name: 'roll_die', tool_input: {sides: 17}},
                {tool_name: 'roll_die', tool_input: {sides: 17}},
              ],
              expected_intermediate_agent_responses: [
                {author: 'agent1', text: 'thought1'},
              ],
              reference: 'I rolled a 17 sided die twice.',
            },
          ],
          initial_session: {
            state: {},
            app_name: 'hello_world',
            user_id: 'user',
          },
        },
      ];

      const evalSet = convertEvalSetToSchema('test_eval_set', legacy);

      expect(evalSet.evalSetId).toBe('test_eval_set');
      expect(evalSet.evalCases).toHaveLength(1);
      expect(evalSet.evalCases[0].evalId).toBe('roll_17_sided_dice_twice');
      expect(evalSet.evalCases[0].conversation).toHaveLength(2);
      expect(evalSet.evalCases[0].sessionInput?.appName).toBe('hello_world');

      const intermediateData = evalSet.evalCases[0].conversation![1]
        .intermediateData as IntermediateData;
      expect(intermediateData.toolUses).toHaveLength(2);
      expect(intermediateData.toolUses[0].name).toBe('roll_die');
      expect(intermediateData.intermediateResponses).toHaveLength(1);
    });

    it('converts a minimal legacy eval set', () => {
      const legacy: LegacyEvalCase[] = [
        {name: 'minimal_case', data: [{query: 'Hello', reference: 'World'}]},
      ];

      const evalSet = convertEvalSetToSchema('test_eval_set', legacy);

      expect(evalSet.evalCases[0].evalId).toBe('minimal_case');
      expect(evalSet.evalCases[0].conversation).toHaveLength(1);
      const invocation = evalSet.evalCases[0].conversation![0];
      expect(invocation.userContent.parts?.[0].text).toBe('Hello');
      expect(invocation.finalResponse?.parts?.[0].text).toBe('World');
    });

    it('defaults empty tool use and intermediate responses', () => {
      const legacy: LegacyEvalCase[] = [
        {
          name: 'empty_lists',
          data: [
            {
              query: 'Test',
              reference: 'Test Ref',
              expected_tool_use: [],
              expected_intermediate_agent_responses: [],
            },
          ],
        },
      ];

      const evalSet = convertEvalSetToSchema('test_eval_set', legacy);

      const intermediateData = evalSet.evalCases[0].conversation![0]
        .intermediateData as IntermediateData;
      expect(intermediateData.toolUses).toHaveLength(0);
      expect(intermediateData.intermediateResponses).toHaveLength(0);
    });

    it('defaults missing session input fields for a partial initial session', () => {
      const legacy: LegacyEvalCase[] = [
        {
          name: 'partial_state',
          data: [{query: 'q'}],
          initial_session: {state: {foo: 1}},
        },
        {
          name: 'partial_app',
          data: [{query: 'q'}],
          initial_session: {app_name: 'app'},
        },
      ];

      const evalSet = convertEvalSetToSchema('test_eval_set', legacy);

      expect(evalSet.evalCases[0].sessionInput).toEqual({
        appName: '',
        userId: '',
        state: {foo: 1},
      });
      expect(evalSet.evalCases[1].sessionInput).toEqual({
        appName: 'app',
        userId: '',
        state: {},
      });
    });

    it('leaves session input undefined for an empty initial session', () => {
      const legacy: LegacyEvalCase[] = [
        {
          name: 'empty_session',
          data: [{query: 'Test', reference: 'Test Ref'}],
          initial_session: {},
        },
      ];

      const evalSet = convertEvalSetToSchema('test_eval_set', legacy);
      expect(evalSet.evalCases[0].sessionInput).toBeUndefined();
    });

    it('throws on a structurally invalid eval case', () => {
      // adk-python relies on Pydantic to reject wrong-typed fields. adk-js has
      // no runtime type validation of primitives, so we re-scope this to a
      // structurally malformed case (missing `name`) that zod validation
      // genuinely rejects.
      const legacy = [{data: [{query: 'x'}]}] as unknown as LegacyEvalCase[];
      expect(() => convertEvalSetToSchema('test_eval_set', legacy)).toThrow();
    });
  });

  describe('loadEvalSetFromFile', () => {
    let tempDir: string;

    beforeEach(async () => {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-load-'));
    });

    afterEach(async () => {
      await fs.rm(tempDir, {recursive: true, force: true});
    });

    it('loads an adk-python-authored new-format (snake_case) file', async () => {
      const filePath = path.join(tempDir, 'new_format.json');
      await fs.writeFile(
        filePath,
        JSON.stringify({
          eval_set_id: 'new_format_eval_set',
          eval_cases: [
            {
              eval_id: 'new_format_case',
              conversation: [
                {
                  invocation_id: 'inv-1',
                  user_content: {parts: [{text: 'New Format Query'}]},
                  final_response: {parts: [{text: 'New Format Reference'}]},
                },
              ],
            },
          ],
        }),
        'utf-8',
      );

      const loaded = await loadEvalSetFromFile(filePath, 'new_format_eval_set');
      const expected = EvalSetSchema.parse({
        evalSetId: 'new_format_eval_set',
        evalCases: [
          {
            evalId: 'new_format_case',
            conversation: [
              {
                invocationId: 'inv-1',
                userContent: {parts: [{text: 'New Format Query'}]},
                finalResponse: {parts: [{text: 'New Format Reference'}]},
              },
            ],
          },
        ],
      });
      expect(loaded).toEqual(expected);
    });

    it('loads an adk-python-authored legacy (array) file', async () => {
      const filePath = path.join(tempDir, 'old_format.json');
      await fs.writeFile(
        filePath,
        JSON.stringify([
          {
            name: 'old_format_case',
            data: [
              {query: 'Old Format Query', reference: 'Old Format Reference'},
            ],
          },
        ]),
        'utf-8',
      );

      const loaded = await loadEvalSetFromFile(filePath, 'old_format_eval_set');
      const expected = EvalSetSchema.parse({
        evalSetId: 'old_format_eval_set',
        name: 'old_format_eval_set',
        creationTimestamp: MOCK_TIME,
        evalCases: [
          {
            evalId: 'old_format_case',
            creationTimestamp: MOCK_TIME,
            conversation: [
              {
                invocationId: MOCK_UUID,
                userContent: {
                  parts: [{text: 'Old Format Query'}],
                  role: 'user',
                },
                finalResponse: {
                  parts: [{text: 'Old Format Reference'}],
                  role: 'model',
                },
                intermediateData: {
                  toolUses: [],
                  toolResponses: [],
                  intermediateResponses: [],
                },
                creationTimestamp: MOCK_TIME,
              },
            ],
          },
        ],
      });
      expect(loaded).toEqual(expected);
    });

    it('rejects a nonexistent file', async () => {
      await expect(
        loadEvalSetFromFile(path.join(tempDir, 'missing.json'), 'x'),
      ).rejects.toThrow();
    });

    it('rejects invalid JSON', async () => {
      const filePath = path.join(tempDir, 'invalid.json');
      await fs.writeFile(filePath, 'invalid json', 'utf-8');
      await expect(loadEvalSetFromFile(filePath, 'x')).rejects.toThrow();
    });

    it('rejects a JSON object that is not a valid eval set', async () => {
      // adk-python routes this through the legacy converter which then fails;
      // adk-js validates the object with zod, which also throws.
      const filePath = path.join(tempDir, 'invalid_data.json');
      await fs.writeFile(filePath, '{"invalid": "data"}', 'utf-8');
      await expect(loadEvalSetFromFile(filePath, 'x')).rejects.toThrow();
    });
  });

  describe('LocalEvalSetsManager', () => {
    let tempDir: string;
    let manager: LocalEvalSetsManager;

    beforeEach(async () => {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-eval-sets-'));
      manager = new LocalEvalSetsManager(tempDir);
    });

    afterEach(async () => {
      await fs.rm(tempDir, {recursive: true, force: true});
    });

    it('gets an existing eval set', async () => {
      await manager.createEvalSet(APP_NAME, EVAL_SET_ID);
      const evalSet = await manager.getEvalSet(APP_NAME, EVAL_SET_ID);
      expect(evalSet?.evalSetId).toBe(EVAL_SET_ID);
    });

    it('returns undefined for a missing eval set', async () => {
      expect(await manager.getEvalSet(APP_NAME, EVAL_SET_ID)).toBeUndefined();
    });

    it('propagates non-ENOENT errors when reading an eval set', async () => {
      // A corrupt file yields a SyntaxError (not ENOENT) that must propagate.
      await fs.mkdir(path.join(tempDir, APP_NAME), {recursive: true});
      await fs.writeFile(
        path.join(tempDir, APP_NAME, EVAL_SET_ID + EVAL_SET_FILE_EXTENSION),
        'not json',
        'utf-8',
      );
      await expect(manager.getEvalSet(APP_NAME, EVAL_SET_ID)).rejects.toThrow();
    });

    it('propagates non-ENOENT errors when listing eval sets', async () => {
      // Make the app path a file so readdir fails with ENOTDIR (not ENOENT).
      await fs.writeFile(
        path.join(tempDir, 'app_as_file'),
        'not a directory',
        'utf-8',
      );
      await expect(
        manager.listEvalSets('app_as_file'),
      ).rejects.not.toBeInstanceOf(NotFoundError);
    });

    it.each(INVALID_SEGMENTS)(
      'rejects getting with an invalid eval set id %j',
      async (evalSetId) => {
        await expect(manager.getEvalSet(APP_NAME, evalSetId)).rejects.toThrow();
      },
    );

    it('creates an eval set and writes snake_case JSON', async () => {
      const created = await manager.createEvalSet(APP_NAME, EVAL_SET_ID);
      expect(created).toEqual({
        evalSetId: EVAL_SET_ID,
        name: EVAL_SET_ID,
        evalCases: [],
        creationTimestamp: MOCK_TIME,
      });

      const filePath = path.join(
        tempDir,
        APP_NAME,
        EVAL_SET_ID + EVAL_SET_FILE_EXTENSION,
      );
      const onDisk = JSON.parse(await fs.readFile(filePath, 'utf-8'));
      expect(onDisk).toEqual({
        eval_set_id: EVAL_SET_ID,
        name: EVAL_SET_ID,
        eval_cases: [],
        creation_timestamp: MOCK_TIME,
      });
    });

    it('rejects creating an eval set with an invalid id', async () => {
      await expect(
        manager.createEvalSet(APP_NAME, 'invalid-id'),
      ).rejects.toThrow('Invalid Eval Set ID');
    });

    it.each(INVALID_SEGMENTS)(
      'rejects creating with an invalid app name %j',
      async (appName) => {
        await expect(
          manager.createEvalSet(appName, EVAL_SET_ID),
        ).rejects.toThrow();
      },
    );

    it('rejects creating an eval set that already exists', async () => {
      await manager.createEvalSet(APP_NAME, EVAL_SET_ID);
      await expect(
        manager.createEvalSet(APP_NAME, EVAL_SET_ID),
      ).rejects.toThrow('already exists');
    });

    it('lists eval sets sorted, ignoring other files', async () => {
      await manager.createEvalSet(APP_NAME, 'eval_set_2');
      await manager.createEvalSet(APP_NAME, 'eval_set_1');
      await fs.writeFile(
        path.join(tempDir, APP_NAME, 'not_an_eval_set.txt'),
        'noise',
        'utf-8',
      );
      expect(await manager.listEvalSets(APP_NAME)).toEqual([
        'eval_set_1',
        'eval_set_2',
      ]);
    });

    it('throws NotFoundError listing an app with no eval directory', async () => {
      await expect(manager.listEvalSets('missing_app')).rejects.toThrow(
        NotFoundError,
      );
    });

    it.each(INVALID_SEGMENTS)(
      'rejects listing with an invalid app name %j',
      async (appName) => {
        await expect(manager.listEvalSets(appName)).rejects.toThrow();
      },
    );

    it('adds an eval case and persists it', async () => {
      await manager.createEvalSet(APP_NAME, EVAL_SET_ID);
      await manager.addEvalCase(
        APP_NAME,
        EVAL_SET_ID,
        makeEvalCase(EVAL_CASE_ID),
      );

      const evalSet = await manager.getEvalSet(APP_NAME, EVAL_SET_ID);
      expect(evalSet?.evalCases.map((c) => c.evalId)).toEqual([EVAL_CASE_ID]);
    });

    it('rejects adding an eval case to a missing eval set', async () => {
      await expect(
        manager.addEvalCase(APP_NAME, EVAL_SET_ID, makeEvalCase(EVAL_CASE_ID)),
      ).rejects.toThrow('Eval set `test_eval_set` not found.');
    });

    it('rejects adding a duplicate eval case', async () => {
      await manager.createEvalSet(APP_NAME, EVAL_SET_ID);
      await manager.addEvalCase(
        APP_NAME,
        EVAL_SET_ID,
        makeEvalCase(EVAL_CASE_ID),
      );
      await expect(
        manager.addEvalCase(APP_NAME, EVAL_SET_ID, makeEvalCase(EVAL_CASE_ID)),
      ).rejects.toThrow('already exists');
    });

    it('gets an eval case', async () => {
      await manager.createEvalSet(APP_NAME, EVAL_SET_ID);
      await manager.addEvalCase(
        APP_NAME,
        EVAL_SET_ID,
        makeEvalCase(EVAL_CASE_ID),
      );
      const evalCase = await manager.getEvalCase(
        APP_NAME,
        EVAL_SET_ID,
        EVAL_CASE_ID,
      );
      expect(evalCase?.evalId).toBe(EVAL_CASE_ID);
    });

    it('returns undefined getting an eval case from a missing set', async () => {
      expect(
        await manager.getEvalCase(APP_NAME, EVAL_SET_ID, EVAL_CASE_ID),
      ).toBeUndefined();
    });

    it('returns undefined getting a missing eval case', async () => {
      await manager.createEvalSet(APP_NAME, EVAL_SET_ID);
      expect(
        await manager.getEvalCase(APP_NAME, EVAL_SET_ID, EVAL_CASE_ID),
      ).toBeUndefined();
    });

    it('updates an eval case', async () => {
      await manager.createEvalSet(APP_NAME, EVAL_SET_ID);
      await manager.addEvalCase(
        APP_NAME,
        EVAL_SET_ID,
        makeEvalCase(EVAL_CASE_ID, 456),
      );
      await manager.updateEvalCase(
        APP_NAME,
        EVAL_SET_ID,
        makeEvalCase(EVAL_CASE_ID, 123),
      );

      const evalCase = await manager.getEvalCase(
        APP_NAME,
        EVAL_SET_ID,
        EVAL_CASE_ID,
      );
      expect(evalCase?.creationTimestamp).toBe(123);
    });

    it('rejects updating an eval case in a missing set', async () => {
      await expect(
        manager.updateEvalCase(
          APP_NAME,
          EVAL_SET_ID,
          makeEvalCase(EVAL_CASE_ID),
        ),
      ).rejects.toThrow('Eval set `test_eval_set` not found.');
    });

    it('rejects updating a missing eval case', async () => {
      await manager.createEvalSet(APP_NAME, EVAL_SET_ID);
      await expect(
        manager.updateEvalCase(
          APP_NAME,
          EVAL_SET_ID,
          makeEvalCase(EVAL_CASE_ID),
        ),
      ).rejects.toThrow(
        'Eval case `test_eval_case` not found in eval set `test_eval_set`.',
      );
    });

    it('deletes an eval case', async () => {
      await manager.createEvalSet(APP_NAME, EVAL_SET_ID);
      await manager.addEvalCase(
        APP_NAME,
        EVAL_SET_ID,
        makeEvalCase(EVAL_CASE_ID),
      );
      await manager.deleteEvalCase(APP_NAME, EVAL_SET_ID, EVAL_CASE_ID);

      const evalSet = await manager.getEvalSet(APP_NAME, EVAL_SET_ID);
      expect(evalSet?.evalCases).toHaveLength(0);
    });

    it('rejects deleting an eval case from a missing set', async () => {
      await expect(
        manager.deleteEvalCase(APP_NAME, EVAL_SET_ID, EVAL_CASE_ID),
      ).rejects.toThrow('Eval set `test_eval_set` not found.');
    });

    it('rejects deleting a missing eval case', async () => {
      await manager.createEvalSet(APP_NAME, EVAL_SET_ID);
      await expect(
        manager.deleteEvalCase(APP_NAME, EVAL_SET_ID, EVAL_CASE_ID),
      ).rejects.toThrow(
        'Eval case `test_eval_case` not found in eval set `test_eval_set`.',
      );
    });
  });

  describe('cross-language interop round-trip', () => {
    let tempDir: string;
    let manager: LocalEvalSetsManager;

    beforeEach(async () => {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-interop-'));
      manager = new LocalEvalSetsManager(tempDir);
    });

    afterEach(async () => {
      await fs.rm(tempDir, {recursive: true, force: true});
    });

    it('writes snake_case keys, preserves opaque objects, and reloads', async () => {
      const richCase = EvalCaseSchema.parse({
        evalId: 'rich_case',
        conversation: [
          {
            invocationId: 'inv-1',
            userContent: {
              role: 'user',
              parts: [
                {
                  functionCall: {
                    name: 'do_thing',
                    args: {inner_snake: 1, innerCamel: 2},
                  },
                },
              ],
            },
          },
        ],
        sessionInput: {
          appName: 'app',
          userId: 'user',
          state: {arbitrary_key: 'v', nestedCamel: {a: 1}},
        },
        finalSessionState: {some_key: 'x'},
      });

      await manager.createEvalSet(APP_NAME, EVAL_SET_ID);
      await manager.addEvalCase(APP_NAME, EVAL_SET_ID, richCase);

      // On-disk keys are snake_case and opaque sub-objects are verbatim.
      const filePath = path.join(
        tempDir,
        APP_NAME,
        EVAL_SET_ID + EVAL_SET_FILE_EXTENSION,
      );
      const onDisk = JSON.parse(await fs.readFile(filePath, 'utf-8'));
      expect(onDisk.eval_set_id).toBe(EVAL_SET_ID);
      const diskCase = onDisk.eval_cases[0];
      expect(diskCase.eval_id).toBe('rich_case');
      expect(diskCase.session_input.state).toEqual({
        arbitrary_key: 'v',
        nestedCamel: {a: 1},
      });
      expect(diskCase.final_session_state).toEqual({some_key: 'x'});
      expect(
        diskCase.conversation[0].user_content.parts[0].function_call.args,
      ).toEqual({inner_snake: 1, innerCamel: 2});

      // Reloading yields a camelCase model deep-equal to the original case.
      const reloaded = await manager.getEvalSet(APP_NAME, EVAL_SET_ID);
      expect(reloaded?.evalCases).toEqual([richCase]);
    });
  });
});
