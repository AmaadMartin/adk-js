/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AlreadyExistsError,
  EvalCase,
  InMemoryEvalSetsManager,
  NotFoundError,
} from '@google/adk';
import {beforeEach, describe, expect, it} from 'vitest';

const APP_NAME = 'home_automation';
const EVAL_SET_ID = 'smoke';

function makeEvalCase(evalId: string): EvalCase {
  return {evalId, conversation: [], creationTimestamp: 0};
}

let manager: InMemoryEvalSetsManager;

beforeEach(() => {
  manager = new InMemoryEvalSetsManager();
});

describe('InMemoryEvalSetsManager', () => {
  it('creates an eval set and reads it back', async () => {
    const created = await manager.createEvalSet(APP_NAME, EVAL_SET_ID);

    expect(created.evalSetId).toBe(EVAL_SET_ID);
    expect(created.evalCases).toEqual([]);
    expect(await manager.getEvalSet(APP_NAME, EVAL_SET_ID)).toBe(created);
    expect(await manager.listEvalSets(APP_NAME)).toEqual([EVAL_SET_ID]);
  });

  it('reports no eval sets for an app it has never seen', async () => {
    expect(await manager.listEvalSets('unknown')).toEqual([]);
    expect(await manager.getEvalSet('unknown', EVAL_SET_ID)).toBeUndefined();
    expect(
      await manager.getEvalCase('unknown', EVAL_SET_ID, 'case'),
    ).toBeUndefined();
  });

  it('rejects a second eval set with the same id', async () => {
    await manager.createEvalSet(APP_NAME, EVAL_SET_ID);

    await expect(
      manager.createEvalSet(APP_NAME, EVAL_SET_ID),
    ).rejects.toThrowError(AlreadyExistsError);
  });

  it('adds eval cases and reads them back by id', async () => {
    await manager.createEvalSet(APP_NAME, EVAL_SET_ID);
    const evalCase = makeEvalCase('turn_off');

    await manager.addEvalCase(APP_NAME, EVAL_SET_ID, evalCase);

    expect(await manager.getEvalCase(APP_NAME, EVAL_SET_ID, 'turn_off')).toBe(
      evalCase,
    );
    const evalSet = await manager.getEvalSet(APP_NAME, EVAL_SET_ID);
    expect(evalSet?.evalCases).toEqual([evalCase]);
  });

  it('reports an unknown eval case id', async () => {
    await manager.createEvalSet(APP_NAME, EVAL_SET_ID);

    expect(
      await manager.getEvalCase(APP_NAME, EVAL_SET_ID, 'missing'),
    ).toBeUndefined();
  });

  it('rejects a second eval case with the same id', async () => {
    await manager.createEvalSet(APP_NAME, EVAL_SET_ID);
    await manager.addEvalCase(APP_NAME, EVAL_SET_ID, makeEvalCase('turn_off'));

    await expect(
      manager.addEvalCase(APP_NAME, EVAL_SET_ID, makeEvalCase('turn_off')),
    ).rejects.toThrowError(AlreadyExistsError);
  });

  it('replaces an eval case', async () => {
    await manager.createEvalSet(APP_NAME, EVAL_SET_ID);
    await manager.addEvalCase(APP_NAME, EVAL_SET_ID, makeEvalCase('turn_off'));
    const updated = {...makeEvalCase('turn_off'), creationTimestamp: 9};

    await manager.updateEvalCase(APP_NAME, EVAL_SET_ID, updated);

    expect(await manager.getEvalCase(APP_NAME, EVAL_SET_ID, 'turn_off')).toBe(
      updated,
    );
  });

  it('deletes an eval case', async () => {
    await manager.createEvalSet(APP_NAME, EVAL_SET_ID);
    await manager.addEvalCase(APP_NAME, EVAL_SET_ID, makeEvalCase('turn_off'));

    await manager.deleteEvalCase(APP_NAME, EVAL_SET_ID, 'turn_off');

    const evalSet = await manager.getEvalSet(APP_NAME, EVAL_SET_ID);
    expect(evalSet?.evalCases).toEqual([]);
  });

  it.each([
    [
      'adding to',
      (m: InMemoryEvalSetsManager) =>
        m.addEvalCase(APP_NAME, EVAL_SET_ID, makeEvalCase('c')),
    ],
    [
      'updating in',
      (m: InMemoryEvalSetsManager) =>
        m.updateEvalCase(APP_NAME, EVAL_SET_ID, makeEvalCase('c')),
    ],
    [
      'deleting from',
      (m: InMemoryEvalSetsManager) =>
        m.deleteEvalCase(APP_NAME, EVAL_SET_ID, 'c'),
    ],
  ])('rejects %s an eval set that does not exist', async (_name, act) => {
    await expect(act(manager)).rejects.toThrowError(NotFoundError);
  });

  it.each([
    [
      'updating',
      (m: InMemoryEvalSetsManager) =>
        m.updateEvalCase(APP_NAME, EVAL_SET_ID, makeEvalCase('missing')),
    ],
    [
      'deleting',
      (m: InMemoryEvalSetsManager) =>
        m.deleteEvalCase(APP_NAME, EVAL_SET_ID, 'missing'),
    ],
  ])('rejects %s an eval case that does not exist', async (_name, act) => {
    await manager.createEvalSet(APP_NAME, EVAL_SET_ID);

    await expect(act(manager)).rejects.toThrowError(NotFoundError);
  });

  it('keeps the eval sets of two apps apart', async () => {
    await manager.createEvalSet(APP_NAME, EVAL_SET_ID);
    await manager.createEvalSet('other_app', EVAL_SET_ID);
    await manager.addEvalCase(APP_NAME, EVAL_SET_ID, makeEvalCase('turn_off'));

    const other = await manager.getEvalSet('other_app', EVAL_SET_ID);
    expect(other?.evalCases).toEqual([]);
  });
});
