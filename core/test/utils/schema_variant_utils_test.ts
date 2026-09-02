/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Schema, Type} from '@google/genai';
import {describe, expect, it} from 'vitest';

import {
  flattenNullableAnyOf,
  sanitizeJsonSchemaForGemini,
  stripUnsupportedGeminiFormats,
} from '../../src/utils/schema_variant_utils.js';

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

describe('flattenNullableAnyOf', () => {
  it('rewrites a nullable branch pair as the branch plus nullable', () => {
    expect(
      flattenNullableAnyOf({
        anyOf: [{type: 'string', minLength: 2}, {type: 'null'}],
      }),
    ).toEqual({type: 'string', minLength: 2, nullable: true});
  });

  it('leaves a union with no null branch alone', () => {
    const schema = {anyOf: [{type: 'string'}, {type: 'integer'}]};

    expect(flattenNullableAnyOf(schema)).toEqual(schema);
  });

  it('keeps a multi-branch union and adds nullable', () => {
    expect(
      flattenNullableAnyOf({
        anyOf: [{type: 'string'}, {type: 'integer'}, {type: 'null'}],
      }),
    ).toEqual({
      anyOf: [{type: 'string'}, {type: 'integer'}],
      nullable: true,
    });
  });

  it('drops a union whose only branch is null', () => {
    expect(flattenNullableAnyOf({anyOf: [{type: 'null'}]})).toEqual({
      nullable: true,
    });
  });

  it('leaves a schema that declares no anyOf untouched', () => {
    const schema = {type: 'object', properties: {name: {type: 'string'}}};

    expect(flattenNullableAnyOf(schema)).toEqual(schema);
  });

  it('recurses into properties, items and surviving branches', () => {
    expect(
      flattenNullableAnyOf({
        type: 'object',
        properties: {
          name: {anyOf: [{type: 'string'}, {type: 'null'}]},
          tags: {
            type: 'array',
            items: {anyOf: [{type: 'string'}, {type: 'null'}]},
          },
        },
      }),
    ).toEqual({
      type: 'object',
      properties: {
        name: {type: 'string', nullable: true},
        tags: {
          type: 'array',
          items: {type: 'string', nullable: true},
        },
      },
    });
  });

  it('flattens a nullable branch nested inside a surviving union', () => {
    expect(
      flattenNullableAnyOf({
        anyOf: [{type: 'integer'}, {anyOf: [{type: 'string'}, {type: 'null'}]}],
      }),
    ).toEqual({
      anyOf: [{type: 'integer'}, {type: 'string', nullable: true}],
    });
  });

  it('copies a branch it cannot interpret through unchanged', () => {
    expect(flattenNullableAnyOf({anyOf: [true, {type: 'null'}]})).toEqual({
      anyOf: [true],
      nullable: true,
    });
    expect(flattenNullableAnyOf({anyOf: 'not-a-list'})).toEqual({
      anyOf: 'not-a-list',
    });
  });

  it('copies a property it cannot interpret through unchanged', () => {
    const schema = {
      type: 'object',
      properties: {anything: true, note: {type: 'string'}},
    };

    expect(flattenNullableAnyOf(schema)).toEqual(schema);
  });

  it('does not modify the input', () => {
    const name = {anyOf: [{type: 'string'}, {type: 'null'}]};
    const schema = {type: 'object', properties: {name}};

    flattenNullableAnyOf(schema);

    expect(name.anyOf).toHaveLength(2);
  });
});

describe('sanitizeJsonSchemaForGemini', () => {
  it('drops the keywords the Gemini Developer API rejects', () => {
    const sanitized = sanitizeJsonSchemaForGemini({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      additionalProperties: false,
      propertyNames: {pattern: '^[a-z]+$'},
      properties: {name: {type: 'string'}},
      required: ['name'],
    });

    expect(sanitized).toEqual({
      type: 'object',
      properties: {name: {type: 'string'}},
      required: ['name'],
    });
  });

  it('keeps int32 on an integer and drops email from a string', () => {
    expect(
      sanitizeJsonSchemaForGemini({type: 'integer', format: 'int32'}),
    ).toEqual({type: 'integer', format: 'int32'});
    expect(
      sanitizeJsonSchemaForGemini({type: 'string', format: 'email'}),
    ).toEqual({type: 'string'});
  });

  it('keeps date-time on a string', () => {
    expect(
      sanitizeJsonSchemaForGemini({type: 'string', format: 'date-time'}),
    ).toEqual({type: 'string', format: 'date-time'});
  });

  it('widens oneOf to anyOf', () => {
    expect(
      sanitizeJsonSchemaForGemini({
        oneOf: [{type: 'string'}, {type: 'integer'}],
      }),
    ).toEqual({anyOf: [{type: 'string'}, {type: 'integer'}]});
  });

  it('accumulates oneOf onto an existing anyOf', () => {
    expect(
      sanitizeJsonSchemaForGemini({
        anyOf: [{type: 'string'}],
        oneOf: [{type: 'integer'}],
      }),
    ).toEqual({anyOf: [{type: 'string'}, {type: 'integer'}]});
  });

  it('maps a boolean schema to an unconstrained object', () => {
    expect(
      sanitizeJsonSchemaForGemini({properties: {yes: true, no: false}}),
    ).toEqual({
      properties: {yes: {type: 'object'}, no: {type: 'object'}},
    });
  });

  it('rewrites a top-level null type but preserves it in an anyOf branch', () => {
    expect(sanitizeJsonSchemaForGemini({type: 'null'})).toEqual({
      type: ['object', 'null'],
    });
    expect(
      sanitizeJsonSchemaForGemini({
        anyOf: [{type: 'string'}, {type: 'null'}],
      }),
    ).toEqual({anyOf: [{type: 'string'}, {type: 'null'}]});
  });

  it('collapses a type list to its non-null member, array first', () => {
    expect(
      sanitizeJsonSchemaForGemini({
        type: ['string', 'null'],
      }),
    ).toEqual({type: ['string', 'null']});
    expect(
      sanitizeJsonSchemaForGemini({
        type: ['string', 'array'],
        items: {type: 'string'},
      }),
    ).toEqual({type: 'array', items: {type: 'string'}});
  });

  it('replaces a null-only type list with an object union', () => {
    expect(sanitizeJsonSchemaForGemini({type: ['null']})).toEqual({
      type: ['object', 'null'],
    });
  });

  it('accepts a single anyOf branch that is not a list', () => {
    expect(sanitizeJsonSchemaForGemini({anyOf: {type: 'string'}})).toEqual({
      anyOf: [{type: 'string'}],
    });
  });

  it('gives an array without items a string element schema', () => {
    expect(sanitizeJsonSchemaForGemini({type: 'array'})).toEqual({
      type: 'array',
      items: {type: 'string'},
    });
  });

  it('renders a non-string enum member on a string field and drops null', () => {
    expect(
      sanitizeJsonSchemaForGemini({type: 'string', enum: ['a', 2, null]}),
    ).toEqual({type: 'string', enum: ['a', '2']});
  });

  it('turns an empty schema into an object schema', () => {
    expect(sanitizeJsonSchemaForGemini({})).toEqual({type: 'object'});
  });

  it('recurses into properties, items and $defs', () => {
    expect(
      sanitizeJsonSchemaForGemini({
        type: 'object',
        $defs: {Tag: {type: 'string', format: 'email'}},
        properties: {
          tags: {
            type: 'array',
            items: {type: 'string', format: 'uuid', additionalProperties: {}},
          },
        },
      }),
    ).toEqual({
      type: 'object',
      $defs: {Tag: {type: 'string'}},
      properties: {
        tags: {type: 'array', items: {type: 'string'}},
      },
    });
  });

  it('copies a value it cannot read as a schema', () => {
    expect(sanitizeJsonSchemaForGemini({type: 'array', items: 'nope'})).toEqual(
      {type: 'array', items: 'nope'},
    );
  });

  it('sanitizes a tuple item list element-wise', () => {
    expect(
      sanitizeJsonSchemaForGemini({
        type: 'array',
        items: [{type: 'string', format: 'email'}],
      }),
    ).toEqual({type: 'array', items: [{type: 'string'}]});
  });

  it('drops a format when the type is a list', () => {
    expect(
      sanitizeJsonSchemaForGemini({
        type: ['string', 'null'],
        format: 'date-time',
      }),
    ).toEqual({type: ['string', 'null']});
  });

  it('does not mutate its input', () => {
    const schema = {
      type: 'object',
      additionalProperties: false,
      properties: {when: {type: 'string', format: 'email'}},
    };
    const clone = structuredClone(schema);

    sanitizeJsonSchemaForGemini(schema);

    expect(schema).toEqual(clone);
  });
});
