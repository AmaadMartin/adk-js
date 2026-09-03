/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  InputValidationError,
  createToolConfig,
  toolArgsConfigSchema,
  toolConfigSchema,
} from '@google/adk';
import yaml from 'js-yaml';
import {describe, expect, it} from 'vitest';

const VERTEX_AI_SEARCH_YAML = `
name: VertexAiSearchTool
args:
  dataStoreSpecs:
    - dataStore: projects/my-project/locations/us-central1/collections/my-collection/dataStores/my-datastore1
      filter: filter1
    - dataStore: projects/my-project/locations/us-central1/collections/my-collection/dataStores/my-dataStore2
      filter: filter2
  filter: filter
  maxResults: 10
  searchEngineId: projects/my-project/locations/us-central1/collections/my-collection/engines/my-engine
`;

describe('toolConfigSchema', () => {
  it('accepts a name on its own', () => {
    expect(toolConfigSchema.parse({name: 'google_search'})).toEqual({
      name: 'google_search',
    });
  });

  it('keeps the whole args bag', () => {
    expect(
      toolConfigSchema.parse({
        name: 'my_package.my_module.make_tool',
        args: {a: 1, b: 'x'},
      }),
    ).toEqual({name: 'my_package.my_module.make_tool', args: {a: 1, b: 'x'}});
  });

  it('requires a name', () => {
    expect(toolConfigSchema.safeParse({args: {a: 1}}).success).toBe(false);
  });

  it('rejects an unknown top-level key', () => {
    expect(
      toolConfigSchema.safeParse({name: 'google_search', argz: {a: 1}}).success,
    ).toBe(false);
  });
});

describe('toolArgsConfigSchema', () => {
  it('camelCases the keys of the bag, at every depth', () => {
    expect(
      toolArgsConfigSchema.parse({top_k: 5, nested: {max_len: 2}}),
    ).toEqual({
      topK: 5,
      nested: {maxLen: 2},
    });
  });
});

describe('createToolConfig', () => {
  it('round-trips a YAML tool declaration with nested args', () => {
    const config = createToolConfig(yaml.load(VERTEX_AI_SEARCH_YAML));

    expect(config.name).toBe('VertexAiSearchTool');
    expect(config.args).toEqual({
      dataStoreSpecs: [
        {
          dataStore:
            'projects/my-project/locations/us-central1/collections/my-collection/dataStores/my-datastore1',
          filter: 'filter1',
        },
        {
          dataStore:
            'projects/my-project/locations/us-central1/collections/my-collection/dataStores/my-dataStore2',
          filter: 'filter2',
        },
      ],
      filter: 'filter',
      maxResults: 10,
      searchEngineId:
        'projects/my-project/locations/us-central1/collections/my-collection/engines/my-engine',
    });
  });

  it('keeps a snake_case arg key unchanged', () => {
    const config = createToolConfig({
      name: 'VertexAiSearchTool',
      args: {max_results: 10},
    });

    expect(config.args).toEqual({max_results: 10});
  });

  it('leaves args undefined when the declaration omits them', () => {
    expect(createToolConfig({name: 'google_search'}).args).toBeUndefined();
  });

  it('leaves args undefined when the declaration sets them to null', () => {
    expect(
      createToolConfig({name: 'google_search', args: null}).args,
    ).toBeUndefined();
  });

  it('keeps an empty args bag distinct from an omitted one', () => {
    expect(createToolConfig({name: 'google_search', args: {}}).args).toEqual(
      {},
    );
  });

  it('preserves an arg key no adk-js tool declares', () => {
    const config = createToolConfig({
      name: 'my_package.my_module.myTool',
      args: {somethingNobodyDeclares: 'kept'},
    });

    expect(config.args).toEqual({somethingNobodyDeclares: 'kept'});
  });

  it('does not alias the caller args object', () => {
    const args: Record<string, unknown> = {maxResults: 10};
    const config = createToolConfig({name: 'VertexAiSearchTool', args});

    args['maxResults'] = 99;

    expect(config.args).toEqual({maxResults: 10});
  });

  it('rejects an unknown top-level key', () => {
    expect(() => createToolConfig({name: 'google_search', arg: {}})).toThrow(
      /unknown key\(s\): arg\./,
    );
  });

  it('names every unknown top-level key', () => {
    const declare = () =>
      createToolConfig({name: 'google_search', arg: {}, nmae: 'x'});

    expect(declare).toThrow(InputValidationError);
    expect(declare).toThrow('ToolConfig received unknown key(s): arg, nmae.');
  });

  it('rejects a key that only Object.prototype declares', () => {
    const declared = JSON.parse('{"name": "google_search", "toString": 1}');

    expect(() => createToolConfig(declared)).toThrow(
      /unknown key\(s\): toString\./,
    );
  });

  it('rejects a declaration without a name', () => {
    expect(() => createToolConfig({args: {}})).toThrow(/`name` is required/);
  });

  it('rejects a name that is not a string', () => {
    expect(() => createToolConfig({name: 123})).toThrow(
      /`name` must be a string/,
    );
  });

  it('accepts an empty name', () => {
    expect(createToolConfig({name: ''}).name).toBe('');
  });

  it.each([
    ['null', null],
    ['a string', 'google_search'],
    ['a number', 42],
    ['an array', []],
    ['a function', () => 'google_search'],
  ])('rejects %s as a declaration', (_label, declared) => {
    expect(() => createToolConfig(declared)).toThrow(
      /ToolConfig must be a non-null object/,
    );
  });

  it.each([
    ['a string', 'searchEngineId=e'],
    ['an array', []],
  ])('rejects %s as args', (_label, args) => {
    expect(() => createToolConfig({name: 'VertexAiSearchTool', args})).toThrow(
      /`args` must be an object/,
    );
  });
});

describe('toolConfigSchema, as a declarative tool reference', () => {
  it('accepts a name with no args', () => {
    expect(toolConfigSchema.parse({name: './my_tools.js#searchTool'})).toEqual({
      name: './my_tools.js#searchTool',
    });
  });

  it('accepts args and keeps their keys verbatim', () => {
    const parsed = toolConfigSchema.parse({
      name: './my_tools.js#createRetriever',
      args: {'corpus_id': 'docs-prod'},
    });

    expect(parsed.args).toEqual({'corpus_id': 'docs-prod'});
  });

  it('rejects a missing name', () => {
    expect(toolConfigSchema.safeParse({args: {}}).success).toBe(false);
  });

  it('rejects an empty name', () => {
    expect(toolConfigSchema.safeParse({name: ''}).success).toBe(false);
  });

  it('rejects an unknown key', () => {
    expect(
      toolConfigSchema.safeParse({name: './my_tools.js#t', arg: {}}).success,
    ).toBe(false);
  });

  it('rejects args that are not an object', () => {
    expect(
      toolConfigSchema.safeParse({name: './my_tools.js#t', args: 'nope'})
        .success,
    ).toBe(false);
    expect(
      toolConfigSchema.safeParse({name: './my_tools.js#t', args: [1, 2]})
        .success,
    ).toBe(false);
  });
});
