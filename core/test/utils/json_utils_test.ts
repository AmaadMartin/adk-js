/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {stripJsonCodeFence} from '../../src/utils/json_utils.js';

const PAYLOAD = '{"a":1}';
const FENCE = '```';

describe('stripJsonCodeFence', () => {
  it('strips a json-tagged code fence', () => {
    expect(stripJsonCodeFence('```json\n{"a":1}\n```')).toBe(PAYLOAD);
  });

  it('strips an uppercase JSON tag', () => {
    expect(stripJsonCodeFence('```JSON\n{"a":1}\n```')).toBe(PAYLOAD);
  });

  it('strips a fence carrying any other language tag', () => {
    expect(stripJsonCodeFence('```python\n{"a":1}\n```')).toBe(PAYLOAD);
  });

  it('strips a bare fence with no tag', () => {
    expect(stripJsonCodeFence('```\n{"a":1}\n```')).toBe(PAYLOAD);
  });

  it('strips a fence surrounded by whitespace', () => {
    expect(stripJsonCodeFence('  \n```json\n{"a":1}\n```  \n')).toBe(PAYLOAD);
  });

  it('strips a fence wrapping an array payload', () => {
    expect(stripJsonCodeFence('```json\n[{"n":1}]\n```')).toBe('[{"n":1}]');
  });

  it('returns unfenced json unchanged', () => {
    expect(stripJsonCodeFence(PAYLOAD)).toBe(PAYLOAD);
  });

  it('preserves backticks that appear inside a value', () => {
    const text = '{"name": "```", "value": 42}';
    expect(stripJsonCodeFence(text)).toBe(text);
  });

  it('returns an unterminated fence unchanged', () => {
    const text = '```json\n{"a":1}';
    expect(stripJsonCodeFence(text)).toBe(text);
  });

  it('returns the original untrimmed text when there is no fence', () => {
    const text = '  \n{"a":1}  \n';
    expect(stripJsonCodeFence(text)).toBe(text);
  });

  it('returns an empty string unchanged', () => {
    expect(stripJsonCodeFence('')).toBe('');
  });

  it('returns an empty string for an empty fence', () => {
    expect(stripJsonCodeFence('```\n```')).toBe('');
  });

  it('returns a fence closed by only three backticks', () => {
    expect(stripJsonCodeFence('``````')).toBe('');
  });

  it('returns a lone fence delimiter unchanged', () => {
    expect(stripJsonCodeFence(FENCE)).toBe(FENCE);
  });

  // Both inputs below defeated a regex implementation of this helper, which
  // backtracked catastrophically and blocked the thread for tens of seconds.
  // Matching must stay linear: model text reaches this helper unfiltered, and
  // it runs on the single Node thread. Each input is sized so a regression
  // blows the default test timeout, which is what fails these two; the
  // linear implementation returns in well under a millisecond.
  describe('runs in linear time on an unclosed fence', () => {
    const cases: Record<string, string> = {
      'a long whitespace run': `${FENCE}json\n${' '.repeat(4_000)}x`,
      'a long word-character run': `${FENCE}${'a'.repeat(300_000)}`,
    };

    for (const [name, text] of Object.entries(cases)) {
      it(name, () => {
        expect(stripJsonCodeFence(text)).toBe(text);
      });
    }
  });
});
