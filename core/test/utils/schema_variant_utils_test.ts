/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Schema, Type} from '@google/genai';
import {describe, expect, it} from 'vitest';

import {stripUnsupportedGeminiFormats} from '../../src/utils/schema_variant_utils.js';

describe('stripUnsupportedGeminiFormats', () => {
  it('keeps int32 and int64 on an integer', () => {
    expect(
      stripUnsupportedGeminiFormats({type: Type.INTEGER, format: 'int32'}),
    ).toEqual({type: Type.INTEGER, format: 'int32'});
    expect(
      stripUnsupportedGeminiFormats({type: Type.INTEGER, format: 'int64'}),
    ).toEqual({type: Type.INTEGER, format: 'int64'});
  });

  it('keeps int64 on a number but drops float', () => {
    expect(
      stripUnsupportedGeminiFormats({type: Type.NUMBER, format: 'int64'}),
    ).toEqual({type: Type.NUMBER, format: 'int64'});
    expect(
      stripUnsupportedGeminiFormats({type: Type.NUMBER, format: 'float'}),
    ).toEqual({type: Type.NUMBER});
  });

  it('keeps date-time and enum on a string but drops email', () => {
    expect(
      stripUnsupportedGeminiFormats({type: Type.STRING, format: 'date-time'}),
    ).toEqual({type: Type.STRING, format: 'date-time'});
    expect(
      stripUnsupportedGeminiFormats({type: Type.STRING, format: 'enum'}),
    ).toEqual({type: Type.STRING, format: 'enum'});
    expect(
      stripUnsupportedGeminiFormats({type: Type.STRING, format: 'email'}),
    ).toEqual({type: Type.STRING});
  });

  it('drops a format on a type that supports none', () => {
    expect(
      stripUnsupportedGeminiFormats({type: Type.BOOLEAN, format: 'int32'}),
    ).toEqual({type: Type.BOOLEAN});
    expect(stripUnsupportedGeminiFormats({format: 'int32'})).toEqual({});
  });

  it('leaves a schema that declares no format untouched', () => {
    const schema: Schema = {
      type: Type.STRING,
      description: 'a name',
      pattern: '^[a-z]+$',
    };
    expect(stripUnsupportedGeminiFormats(schema)).toEqual(schema);
  });

  it('recurses into properties, items and anyOf', () => {
    const schema: Schema = {
      type: Type.OBJECT,
      properties: {
        email: {type: Type.STRING, format: 'email'},
        created: {type: Type.STRING, format: 'date-time'},
        urls: {type: Type.ARRAY, items: {type: Type.STRING, format: 'uri'}},
        id: {
          anyOf: [
            {type: Type.STRING, format: 'uuid'},
            {type: Type.INTEGER, format: 'int64'},
          ],
        },
      },
    };

    expect(stripUnsupportedGeminiFormats(schema)).toEqual({
      type: Type.OBJECT,
      properties: {
        email: {type: Type.STRING},
        created: {type: Type.STRING, format: 'date-time'},
        urls: {type: Type.ARRAY, items: {type: Type.STRING}},
        id: {
          anyOf: [{type: Type.STRING}, {type: Type.INTEGER, format: 'int64'}],
        },
      },
    });
  });

  it('does not modify the input', () => {
    const items: Schema = {type: Type.STRING, format: 'uri'};
    const schema: Schema = {
      type: Type.OBJECT,
      properties: {urls: {type: Type.ARRAY, items}},
    };

    stripUnsupportedGeminiFormats(schema);

    expect(items.format).toBe('uri');
  });
});
