/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {z} from 'zod';
import {parseTestSpec} from '../../src/conformance/test_spec_schema.js';

describe('parseTestSpec', () => {
  /**
   * Ported from `google/adk-python`,
   * `tests/unittests/cli/conformance/test_generated_file_utils.py` on `main`.
   * The `it` strings keep the Python test names so the two files can be
   * compared. The keys are camelCased because adk-js validates the spec after
   * `camelcaseKeys`.
   */
  describe('ported from adk-python', () => {
    it('test_load_test_case_parses_spec_and_applies_declared_defaults', () => {
      const spec = parseTestSpec({
        description: 'checks the dice agent',
        agent: 'dice_agent',
        userMessages: [
          {text: 'roll a die'},
          {text: 'roll again', stateDelta: {rolls: 1}},
        ],
      });

      expect(spec.description).toBe('checks the dice agent');
      expect(spec.agent).toBe('dice_agent');
      expect(spec.initialState).toEqual({});
      expect(spec.userMessages?.map((m) => m.text)).toEqual([
        'roll a die',
        'roll again',
      ]);
      expect(spec.userMessages?.[0].stateDelta).toBeUndefined();
      expect(spec.userMessages?.[1].stateDelta).toEqual({rolls: 1});
    });

    it('test_load_test_case_rejects_unknown_spec_field', () => {
      expect(() =>
        parseTestSpec({
          description: 'd',
          agent: 'a',
          userMesages: [{text: 'typo in the key above'}],
        }),
      ).toThrow(/Unrecognized key: "userMesages"/);
    });

    it('test_load_test_case_rejects_spec_missing_required_agent', () => {
      expect(() => parseTestSpec({description: 'no agent named'})).toThrow(
        /at agent/,
      );
    });
  });

  describe('adk-js additions', () => {
    it('defaults omitted userMessages to an empty list', () => {
      const spec = parseTestSpec({description: 'd', agent: 'a'});

      expect(spec.userMessages).toEqual([]);
    });

    it('keeps an initialState the spec declares', () => {
      const spec = parseTestSpec({
        description: 'd',
        agent: 'a',
        initialState: {seed: 7},
      });

      expect(spec.initialState).toEqual({seed: 7});
    });

    it('rejects a spec missing description', () => {
      expect(() => parseTestSpec({agent: 'a'})).toThrow(/at description/);
    });

    it('rejects an agent of the wrong type', () => {
      expect(() => parseTestSpec({description: 'd', agent: 42})).toThrow(
        /expected string, received number[\s\S]*at agent/,
      );
    });

    it('rejects an unknown key inside a user message', () => {
      expect(() =>
        parseTestSpec({
          description: 'd',
          agent: 'a',
          userMessages: [{txet: 'typo'}],
        }),
      ).toThrow(/Unrecognized key: "txet"/);
    });

    it('rejects a content that is not a mapping', () => {
      for (const content of ['nope', null, [{text: 'hi'}]]) {
        expect(() =>
          parseTestSpec({
            description: 'd',
            agent: 'a',
            userMessages: [{content}],
          }),
        ).toThrow(/at userMessages\[0\].content/);
      }
    });

    it('accepts a user message carrying both text and content', () => {
      // adk-python marks text and content as "oneof" in a comment only, and
      // declares no validator. Neither project enforces it.
      const spec = parseTestSpec({
        description: 'd',
        agent: 'a',
        userMessages: [
          {text: 'hi', content: {role: 'user', parts: [{text: 'hi'}]}},
        ],
      });

      expect(spec.userMessages?.[0]).toEqual({
        text: 'hi',
        content: {role: 'user', parts: [{text: 'hi'}]},
      });
    });

    it('throws a plain Error rather than a ZodError', () => {
      let thrown: unknown;
      try {
        parseTestSpec({description: 'd'});
      } catch (error: unknown) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(Error);
      expect(thrown).not.toBeInstanceOf(z.ZodError);
    });
  });
});
