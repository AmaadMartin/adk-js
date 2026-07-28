/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  EvalCase,
  EvalCaseSchema,
  InMemoryEvalSetsManager,
  NotFoundError,
} from '@google/adk';
import {beforeEach, describe, expect, it} from 'vitest';

const APP_NAME = 'test_app';
const EVAL_SET_ID = 'test_eval_set';
const EVAL_CASE_ID = 'test_eval_case';

function makeEvalCase(evalId: string, creationTimestamp?: number): EvalCase {
  return EvalCaseSchema.parse({
    evalId,
    conversation: [],
    ...(creationTimestamp !== undefined ? {creationTimestamp} : {}),
  });
}

describe('evaluation/in_memory_eval_sets_manager', () => {
  let manager: InMemoryEvalSetsManager;

  beforeEach(() => {
    manager = new InMemoryEvalSetsManager();
  });

  it('creates an eval set', async () => {
    const evalSet = await manager.createEvalSet(APP_NAME, EVAL_SET_ID);
    expect(evalSet.evalSetId).toBe(EVAL_SET_ID);
    expect(evalSet.evalCases).toEqual([]);
  });

  it('rejects creating an eval set that already exists', async () => {
    await manager.createEvalSet(APP_NAME, EVAL_SET_ID);
    await expect(manager.createEvalSet(APP_NAME, EVAL_SET_ID)).rejects.toThrow(
      'already exists',
    );
  });

  it('gets an eval set', async () => {
    await manager.createEvalSet(APP_NAME, EVAL_SET_ID);
    const evalSet = await manager.getEvalSet(APP_NAME, EVAL_SET_ID);
    expect(evalSet?.evalSetId).toBe(EVAL_SET_ID);
  });

  it('returns undefined for a missing eval set', async () => {
    expect(
      await manager.getEvalSet(APP_NAME, 'nonexistent_set'),
    ).toBeUndefined();
  });

  it('returns undefined when getting an eval set for the wrong app', async () => {
    await manager.createEvalSet(APP_NAME, EVAL_SET_ID);
    expect(await manager.getEvalSet('wrong_app', EVAL_SET_ID)).toBeUndefined();
  });

  it('lists eval sets in insertion order', async () => {
    await manager.createEvalSet(APP_NAME, 'set1');
    await manager.createEvalSet(APP_NAME, 'set2');
    expect(await manager.listEvalSets(APP_NAME)).toEqual(['set1', 'set2']);
  });

  it('lists no eval sets for an unknown app', async () => {
    await manager.createEvalSet(APP_NAME, 'set1');
    expect(await manager.listEvalSets('wrong_app')).toEqual([]);
  });

  it('adds an eval case', async () => {
    await manager.createEvalSet(APP_NAME, EVAL_SET_ID);
    await manager.addEvalCase(
      APP_NAME,
      EVAL_SET_ID,
      makeEvalCase(EVAL_CASE_ID),
    );

    const retrieved = await manager.getEvalCase(
      APP_NAME,
      EVAL_SET_ID,
      EVAL_CASE_ID,
    );
    expect(retrieved?.evalId).toBe(EVAL_CASE_ID);

    const evalSet = await manager.getEvalSet(APP_NAME, EVAL_SET_ID);
    expect(evalSet?.evalCases).toHaveLength(1);
    expect(evalSet?.evalCases[0].evalId).toBe(EVAL_CASE_ID);
  });

  it('rejects adding an eval case to a missing eval set', async () => {
    await expect(
      manager.addEvalCase(APP_NAME, EVAL_SET_ID, makeEvalCase(EVAL_CASE_ID)),
    ).rejects.toThrow(NotFoundError);
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
    const retrieved = await manager.getEvalCase(
      APP_NAME,
      EVAL_SET_ID,
      EVAL_CASE_ID,
    );
    expect(retrieved?.evalId).toBe(EVAL_CASE_ID);
  });

  it('returns undefined for a missing eval case', async () => {
    await manager.createEvalSet(APP_NAME, EVAL_SET_ID);
    expect(
      await manager.getEvalCase(APP_NAME, EVAL_SET_ID, 'nonexistent_case'),
    ).toBeUndefined();
  });

  it('returns undefined when getting an eval case from an unknown app', async () => {
    expect(
      await manager.getEvalCase(APP_NAME, 'nonexistent_set', EVAL_CASE_ID),
    ).toBeUndefined();
  });

  it('returns undefined when the app exists but the eval set does not', async () => {
    await manager.createEvalSet(APP_NAME, 'other_set');
    expect(
      await manager.getEvalCase(APP_NAME, 'nonexistent_set', EVAL_CASE_ID),
    ).toBeUndefined();
  });

  it('updates an eval case in place', async () => {
    await manager.createEvalSet(APP_NAME, EVAL_SET_ID);
    await manager.addEvalCase(
      APP_NAME,
      EVAL_SET_ID,
      makeEvalCase(EVAL_CASE_ID),
    );

    const updated = makeEvalCase(EVAL_CASE_ID, 999);
    await manager.updateEvalCase(APP_NAME, EVAL_SET_ID, updated);

    const retrieved = await manager.getEvalCase(
      APP_NAME,
      EVAL_SET_ID,
      EVAL_CASE_ID,
    );
    expect(retrieved?.creationTimestamp).toBe(999);

    const evalSet = await manager.getEvalSet(APP_NAME, EVAL_SET_ID);
    expect(evalSet?.evalCases).toHaveLength(1);
    expect(evalSet?.evalCases[0].creationTimestamp).toBe(999);
  });

  it('rejects updating a missing eval case', async () => {
    await manager.createEvalSet(APP_NAME, EVAL_SET_ID);
    await expect(
      manager.updateEvalCase(APP_NAME, EVAL_SET_ID, makeEvalCase(EVAL_CASE_ID)),
    ).rejects.toThrow(NotFoundError);
  });

  it('rejects updating an eval case in a missing set', async () => {
    await expect(
      manager.updateEvalCase(APP_NAME, EVAL_SET_ID, makeEvalCase(EVAL_CASE_ID)),
    ).rejects.toThrow(NotFoundError);
  });

  it('deletes an eval case', async () => {
    await manager.createEvalSet(APP_NAME, EVAL_SET_ID);
    await manager.addEvalCase(
      APP_NAME,
      EVAL_SET_ID,
      makeEvalCase(EVAL_CASE_ID),
    );

    await manager.deleteEvalCase(APP_NAME, EVAL_SET_ID, EVAL_CASE_ID);

    expect(
      await manager.getEvalCase(APP_NAME, EVAL_SET_ID, EVAL_CASE_ID),
    ).toBeUndefined();
    const evalSet = await manager.getEvalSet(APP_NAME, EVAL_SET_ID);
    expect(evalSet?.evalCases).toHaveLength(0);
  });

  it('rejects deleting a missing eval case', async () => {
    await manager.createEvalSet(APP_NAME, EVAL_SET_ID);
    await expect(
      manager.deleteEvalCase(APP_NAME, EVAL_SET_ID, EVAL_CASE_ID),
    ).rejects.toThrow(NotFoundError);
  });

  it('rejects deleting an eval case from a missing set', async () => {
    await expect(
      manager.deleteEvalCase(APP_NAME, EVAL_SET_ID, EVAL_CASE_ID),
    ).rejects.toThrow(NotFoundError);
  });
});
