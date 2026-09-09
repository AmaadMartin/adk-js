/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ported from adk-python `tests/unittests/tools/test_gemini_schema_utils.py`
 * at commit 5a67a946 (google/adk-python).
 *
 * Each `it()` keeps the Python test name so a reviewer can grep the original.
 * adk-js emits a genai `Schema`, so every expectation uses the `Type` enum
 * where the Python original compares lowercase JSON Schema type names.
 */

import {Type} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {toGeminiSchema} from '../../src/utils/gemini_schema_util.js';

describe('toGeminiSchema format sanitization parity', () => {
  it('test_sanitize_integer_formats', () => {
    const schema = toGeminiSchema({
      type: 'object',
      properties: {
        int32_field: {type: 'integer', format: 'int32'},
        int64_field: {type: 'integer', format: 'int64'},
        invalid_int_format: {type: 'integer', format: 'unsigned'},
      },
    });

    expect(schema).toEqual({
      type: Type.OBJECT,
      properties: {
        int32_field: {type: Type.INTEGER, format: 'int32'},
        int64_field: {type: Type.INTEGER, format: 'int64'},
        invalid_int_format: {type: Type.INTEGER},
      },
    });
  });

  it('test_sanitize_string_formats', () => {
    const schema = toGeminiSchema({
      type: 'object',
      properties: {
        datetime_field: {type: 'string', format: 'date-time'},
        enum_field: {type: 'string', format: 'enum', enum: ['a', 'b']},
        date_field: {type: 'string', format: 'date'},
        email_field: {type: 'string', format: 'email'},
        byte_field: {type: 'string', format: 'byte'},
      },
    });

    expect(schema).toEqual({
      type: Type.OBJECT,
      properties: {
        datetime_field: {type: Type.STRING, format: 'date-time'},
        enum_field: {type: Type.STRING, format: 'enum', enum: ['a', 'b']},
        date_field: {type: Type.STRING},
        email_field: {type: Type.STRING},
        byte_field: {type: Type.STRING},
      },
    });
  });

  it('test_sanitize_number_formats', () => {
    const schema = toGeminiSchema({
      type: 'object',
      properties: {
        float_field: {type: 'number', format: 'float'},
        double_field: {type: 'number', format: 'double'},
        int32_number: {type: 'number', format: 'int32'},
      },
    });

    expect(schema).toEqual({
      type: Type.OBJECT,
      properties: {
        float_field: {type: Type.NUMBER},
        double_field: {type: Type.NUMBER},
        int32_number: {type: Type.NUMBER, format: 'int32'},
      },
    });
  });

  it('test_sanitize_nested_formats', () => {
    const schema = toGeminiSchema({
      type: 'object',
      properties: {
        nested: {
          type: 'object',
          properties: {
            date_str: {type: 'string', format: 'date'},
            int_field: {type: 'integer', format: 'int64'},
          },
        },
        array_field: {type: 'array', items: {type: 'string', format: 'uri'}},
      },
    });

    expect(schema).toEqual({
      type: Type.OBJECT,
      properties: {
        nested: {
          type: Type.OBJECT,
          properties: {
            date_str: {type: Type.STRING},
            int_field: {type: Type.INTEGER, format: 'int64'},
          },
        },
        array_field: {type: Type.ARRAY, items: {type: Type.STRING}},
      },
    });
  });

  it('test_sanitize_anyof_formats', () => {
    const schema = toGeminiSchema({
      anyOf: [
        {type: 'string', format: 'email'},
        {type: 'integer', format: 'int32'},
        {type: 'string', format: 'date-time'},
      ],
    });

    expect(schema).toEqual({
      anyOf: [
        {type: Type.STRING},
        {type: Type.INTEGER, format: 'int32'},
        {type: Type.STRING, format: 'date-time'},
      ],
    });
  });

  it('test_preserve_valid_formats_without_type', () => {
    const schema = toGeminiSchema({
      format: 'date-time',
      properties: {field1: {format: 'int32'}},
    });

    expect(schema).toEqual({
      type: Type.OBJECT,
      properties: {field1: {type: Type.TYPE_UNSPECIFIED}},
    });
  });

  it('test_to_gemini_schema_property_ordering', () => {
    const schema = toGeminiSchema({
      type: 'object',
      properties: {
        name: {type: 'string'},
        age: {type: 'integer'},
      },
      propertyOrdering: ['name', 'age'],
    });

    expect(schema).toEqual({
      type: Type.OBJECT,
      properties: {
        name: {type: Type.STRING},
        age: {type: Type.INTEGER},
      },
      propertyOrdering: ['name', 'age'],
    });
  });

  it('test_to_gemini_schema_none', () => {
    expect(toGeminiSchema(undefined)).toBeUndefined();
  });

  it('test_to_gemini_schema_remove_unrecognized_fields', () => {
    const schema = toGeminiSchema({
      type: 'string',
      description: 'A single date string.',
      format: 'date',
    });

    expect(schema).toEqual({
      type: Type.STRING,
      description: 'A single date string.',
    });
  });
});

describe('toGeminiSchema divergences from adk-python', () => {
  it('keeps a format on a nullable union, which adk-python drops', () => {
    // adk-python tests `format` against the raw `type`, which is a list here,
    // so it drops the format. adk-js unwraps the union first, so the allowlist
    // sees the plain type `string`.
    const schema = toGeminiSchema({
      type: ['string', 'null'],
      format: 'date-time',
    });

    expect(schema).toEqual({
      type: Type.STRING,
      format: 'date-time',
      nullable: true,
    });
  });

  it('test_to_gemini_schema_empty_dict', () => {
    // adk-python yields `type: None`; adk-js has no absent type and yields
    // `TYPE_UNSPECIFIED`.
    expect(toGeminiSchema({})).toEqual({type: Type.TYPE_UNSPECIFIED});
  });

  it('test_to_gemini_schema_general_list', () => {
    // The input is malformed: `type: 'array'` carrying `properties`.
    // adk-python emits the properties anyway; adk-js emits `properties` only
    // for an object node, so they are dropped.
    const schema = toGeminiSchema({
      type: 'array',
      properties: {name: {type: 'string'}},
    });

    expect(schema).toEqual({type: Type.ARRAY});
  });

  it('test_to_gemini_schema_nested_dict', () => {
    // adk-python omits `properties` for a bare object node; adk-js emits an
    // empty map.
    expect(toGeminiSchema({type: 'object'})).toEqual({
      type: Type.OBJECT,
      properties: {},
    });
  });
});
