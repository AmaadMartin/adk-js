/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  EvalCase,
  EvalCaseSchema,
  EvalSet,
  EvalSetSchema,
  InMemoryEvalSetsManager,
  NotFoundError,
  addEvalCaseToEvalSet,
  deleteEvalCaseFromEvalSet,
  getEvalCaseFromEvalSet,
  getEvalSetFromAppAndId,
  updateEvalCaseInEvalSet,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

function makeEvalCase(evalId: string, creationTimestamp = 0): EvalCase {
  return EvalCaseSchema.parse({evalId, conversation: [], creationTimestamp});
}

function makeEvalSet(evalCases: EvalCase[]): EvalSet {
  return EvalSetSchema.parse({evalSetId: 'set', evalCases});
}

describe('evaluation/eval_sets_manager_utils', () => {
  describe('getEvalSetFromAppAndId', () => {
    it('returns the eval set when present', async () => {
      const manager = new InMemoryEvalSetsManager();
      await manager.createEvalSet('app', 'set');
      const evalSet = await getEvalSetFromAppAndId(manager, 'app', 'set');
      expect(evalSet.evalSetId).toBe('set');
    });

    it('throws NotFoundError when absent', async () => {
      const manager = new InMemoryEvalSetsManager();
      await expect(
        getEvalSetFromAppAndId(manager, 'app', 'missing'),
      ).rejects.toThrow(NotFoundError);
    });
  });

  describe('getEvalCaseFromEvalSet', () => {
    it('finds a matching eval case', () => {
      const evalSet = makeEvalSet([makeEvalCase('a'), makeEvalCase('b')]);
      expect(getEvalCaseFromEvalSet(evalSet, 'b')?.evalId).toBe('b');
    });

    it('returns undefined when not found', () => {
      const evalSet = makeEvalSet([makeEvalCase('a')]);
      expect(getEvalCaseFromEvalSet(evalSet, 'z')).toBeUndefined();
    });
  });

  describe('addEvalCaseToEvalSet', () => {
    it('appends a new eval case', () => {
      const evalSet = makeEvalSet([makeEvalCase('a')]);
      addEvalCaseToEvalSet(evalSet, makeEvalCase('b'));
      expect(evalSet.evalCases.map((c) => c.evalId)).toEqual(['a', 'b']);
    });

    it('throws on a duplicate eval id', () => {
      const evalSet = makeEvalSet([makeEvalCase('a')]);
      expect(() => addEvalCaseToEvalSet(evalSet, makeEvalCase('a'))).toThrow(
        'already exists',
      );
    });
  });

  describe('updateEvalCaseInEvalSet', () => {
    it('moves the updated eval case to the end', () => {
      const evalSet = makeEvalSet([
        makeEvalCase('a'),
        makeEvalCase('b'),
        makeEvalCase('c'),
      ]);
      updateEvalCaseInEvalSet(evalSet, makeEvalCase('a', 42));
      expect(evalSet.evalCases.map((c) => c.evalId)).toEqual(['b', 'c', 'a']);
      expect(evalSet.evalCases[2].creationTimestamp).toBe(42);
    });

    it('throws NotFoundError when the eval case is missing', () => {
      const evalSet = makeEvalSet([makeEvalCase('a')]);
      expect(() => updateEvalCaseInEvalSet(evalSet, makeEvalCase('z'))).toThrow(
        NotFoundError,
      );
    });
  });

  describe('deleteEvalCaseFromEvalSet', () => {
    it('removes the eval case', () => {
      const evalSet = makeEvalSet([makeEvalCase('a'), makeEvalCase('b')]);
      deleteEvalCaseFromEvalSet(evalSet, 'a');
      expect(evalSet.evalCases.map((c) => c.evalId)).toEqual(['b']);
    });

    it('throws NotFoundError when the eval case is missing', () => {
      const evalSet = makeEvalSet([makeEvalCase('a')]);
      expect(() => deleteEvalCaseFromEvalSet(evalSet, 'z')).toThrow(
        NotFoundError,
      );
    });
  });
});
