/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {GenerateContentConfig, HarmCategory, HttpOptions} from '@google/genai';
import {describe, expect, it} from 'vitest';
import * as z from 'zod';
import {
  copyHttpOptions,
  copyRequestScopedConfig,
} from '../../src/utils/genai_config_utils.js';

describe('copyHttpOptions', () => {
  it('copies headers, extraBody and retryOptions', () => {
    const source: HttpOptions = {
      timeout: 1000,
      headers: {Original: 'yes'},
      extraBody: {labels: 'original'},
      retryOptions: {attempts: 3},
    };

    const copy = copyHttpOptions(source);

    expect(copy).toEqual(source);
    expect(copy.headers).not.toBe(source.headers);
    expect(copy.extraBody).not.toBe(source.extraBody);
    expect(copy.retryOptions).not.toBe(source.retryOptions);
  });

  it('leaves the source unchanged when the copy is written to', () => {
    const source: HttpOptions = {headers: {Original: 'yes'}};

    const copy = copyHttpOptions(source);
    copy.headers = {...copy.headers, Added: 'yes'};
    copy.timeout = 5000;

    expect(source).toEqual({headers: {Original: 'yes'}});
  });

  it('does not invent absent fields', () => {
    const copy = copyHttpOptions({timeout: 1000});

    expect(copy).toEqual({timeout: 1000});
    expect('headers' in copy).toBe(false);
    expect('extraBody' in copy).toBe(false);
    expect('retryOptions' in copy).toBe(false);
  });
});

describe('copyRequestScopedConfig', () => {
  it('copies arrays without copying their elements', () => {
    const safetySetting = {category: HarmCategory.HARM_CATEGORY_HARASSMENT};
    const source: GenerateContentConfig = {safetySettings: [safetySetting]};

    const copy = copyRequestScopedConfig(source);

    expect(copy.safetySettings).not.toBe(source.safetySettings);
    expect(copy.safetySettings?.[0]).toBe(safetySetting);
  });

  it('copies plain objects', () => {
    const source: GenerateContentConfig = {labels: {owner: 'agent'}};

    const copy = copyRequestScopedConfig(source);
    copy.labels = {...copy.labels, added: 'request'};

    expect(source.labels).toEqual({owner: 'agent'});
  });

  it('leaves scalars alone', () => {
    const source: GenerateContentConfig = {temperature: 0.5, seed: 7};

    expect(copyRequestScopedConfig(source)).toEqual(source);
  });

  it('passes a class instance through by reference', () => {
    const responseSchema = z.object({answer: z.string()});
    const source: GenerateContentConfig = {responseSchema};

    const copy = copyRequestScopedConfig(source);

    expect(copy.responseSchema).toBe(responseSchema);
  });

  it('routes httpOptions through copyHttpOptions', () => {
    const source: GenerateContentConfig = {
      httpOptions: {timeout: 1000, headers: {Original: 'yes'}},
    };

    const copy = copyRequestScopedConfig(source);
    const headers = copy.httpOptions?.headers;
    if (!headers) {
      expect.fail('the copy dropped the http options headers');
    }
    headers['Added'] = 'yes';

    expect(source.httpOptions?.headers).toEqual({Original: 'yes'});
  });
});
