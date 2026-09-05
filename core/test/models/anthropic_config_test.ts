/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {AnthropicGenerateContentConfig} from '@google/adk';
import {ThinkingLevel} from '@google/genai';
import {afterEach, describe, expect, it, vi} from 'vitest';

import {
  buildEffortParam,
  buildThinkingParam,
  validateAnthropicGenerateContentConfig,
} from '../../src/models/anthropic_config.js';
import {logger} from '../../src/utils/logger.js';

describe('buildThinkingParam', () => {
  it('maps a positive budget to the manual enabled mode', () => {
    expect(
      buildThinkingParam({thinkingConfig: {thinkingBudget: 2048}}),
    ).toEqual({type: 'enabled', budget_tokens: 2048});
  });

  it('maps a zero budget to disabled', () => {
    expect(buildThinkingParam({thinkingConfig: {thinkingBudget: 0}})).toEqual({
      type: 'disabled',
    });
  });

  it('maps the genai automatic budget to adaptive', () => {
    expect(buildThinkingParam({thinkingConfig: {thinkingBudget: -1}})).toEqual({
      type: 'adaptive',
    });
  });

  it('maps any other negative budget to adaptive', () => {
    expect(
      buildThinkingParam({thinkingConfig: {thinkingBudget: -1024}}),
    ).toEqual({type: 'adaptive'});
  });

  it('omits the parameter when there is no config', () => {
    expect(buildThinkingParam()).toBeUndefined();
  });

  it('omits the parameter when the config has no thinkingConfig', () => {
    expect(buildThinkingParam({temperature: 0.5})).toBeUndefined();
  });

  it('rejects a thinkingConfig with no thinkingBudget', () => {
    expect(() => buildThinkingParam({thinkingConfig: {}})).toThrowError(
      /thinkingBudget must be set explicitly/,
    );
  });

  it('names the three accepted budget values in the rejection', () => {
    expect(() =>
      buildThinkingParam({thinkingConfig: {includeThoughts: true}}),
    ).toThrowError(/Use 0 to disable thinking, -1 for adaptive/);
  });
});

describe('buildEffortParam', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the effort set on an Anthropic config', () => {
    const config: AnthropicGenerateContentConfig = {effort: 'xhigh'};
    expect(buildEffortParam(config)).toBe('xhigh');
  });

  it('returns undefined when there is no config', () => {
    expect(buildEffortParam()).toBeUndefined();
  });

  it('returns undefined when the config sets no effort', () => {
    expect(buildEffortParam({temperature: 0.5})).toBeUndefined();
  });

  it('warns and ignores a thinkingLevel set on its own', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    expect(
      buildEffortParam({
        thinkingConfig: {thinkingBudget: -1, thinkingLevel: ThinkingLevel.LOW},
      }),
    ).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(
      /thinkingConfig.thinkingLevel is not supported for Anthropic/,
    );
  });

  it('rejects an effort combined with a thinkingLevel', () => {
    const config: AnthropicGenerateContentConfig = {
      effort: 'xhigh',
      thinkingConfig: {thinkingBudget: -1, thinkingLevel: ThinkingLevel.LOW},
    };

    expect(() => buildEffortParam(config)).toThrowError(
      /thinkingLevel is not supported in AnthropicGenerateContentConfig/,
    );
  });

  it('accepts an effort combined with a plain thinkingBudget', () => {
    const config: AnthropicGenerateContentConfig = {
      effort: 'high',
      thinkingConfig: {thinkingBudget: 2048},
    };

    expect(buildEffortParam(config)).toBe('high');
  });
});

describe('validateAnthropicGenerateContentConfig', () => {
  it('accepts an absent config', () => {
    expect(() =>
      validateAnthropicGenerateContentConfig(undefined),
    ).not.toThrow();
  });

  it('accepts a thinkingLevel when no effort is set', () => {
    expect(() =>
      validateAnthropicGenerateContentConfig({
        thinkingConfig: {thinkingLevel: ThinkingLevel.HIGH},
      }),
    ).not.toThrow();
  });

  it('points the caller at the effort field when it rejects', () => {
    expect(() =>
      validateAnthropicGenerateContentConfig({
        effort: 'max',
        thinkingConfig: {thinkingLevel: ThinkingLevel.HIGH},
      }),
    ).toThrowError(/Use the `effort` field directly/);
  });
});
