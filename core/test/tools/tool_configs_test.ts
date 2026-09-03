/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  InputValidationError,
  VertexAiSearchTool,
  baseToolConfigSchema,
  createToolConfig,
  toolArgsConfigSchema,
  toolConfigSchema,
} from '@google/adk';
import yaml from 'js-yaml';
import {describe, expect, it} from 'vitest';
import {z} from 'zod';

const DATA_STORE_1 =
  'projects/my-project/locations/us-central1/collections/my-collection/dataStores/my-datastore1';
const DATA_STORE_2 =
  'projects/my-project/locations/us-central1/collections/my-collection/dataStores/my-dataStore2';
const SEARCH_ENGINE_ID =
  'projects/my-project/locations/us-central1/collections/my-collection/engines/my-engine';

/** The declaration of the adk-python test, snake_case as Python writes it. */
const VERTEX_AI_SEARCH_YAML = `
name: VertexAiSearchTool
args:
  data_store_specs:
    - data_store: ${DATA_STORE_1}
      filter: filter1
    - data_store: ${DATA_STORE_2}
      filter: filter2
  filter: filter
  max_results: 10
  search_engine_id: ${SEARCH_ENGINE_ID}
`;

/** Narrows a camelCased args bag to the constructor arguments of the tool. */
const vertexAiSearchArgsSchema = z.object({
  searchEngineId: z.string(),
  filter: z.string(),
  maxResults: z.number(),
  dataStoreSpecs: z.array(z.object({dataStore: z.string()})),
});

const myToolConfigSchema = baseToolConfigSchema.extend({
  threshold: z.number(),
  label: z.string().optional(),
});

describe('baseToolConfigSchema', () => {
  it('accepts an empty object', () => {
    expect(baseToolConfigSchema.parse({})).toEqual({});
  });

  it('rejects a key the base was not extended with', () => {
    expect(baseToolConfigSchema.safeParse({a: 1}).success).toBe(false);
  });

  it('accepts the declared keys of an extension', () => {
    expect(myToolConfigSchema.parse({threshold: 1})).toEqual({threshold: 1});
    expect(myToolConfigSchema.parse({threshold: 1, label: 'hot'})).toEqual({
      threshold: 1,
      label: 'hot',
    });
  });

  it('rejects an undeclared key on an extension', () => {
    expect(
      myToolConfigSchema.safeParse({threshold: 1, thresold: 2}).success,
    ).toBe(false);
  });

  it('enforces the declared types of an extension', () => {
    expect(myToolConfigSchema.safeParse({threshold: 'no'}).success).toBe(false);
  });

  it('rejects a missing required key of an extension', () => {
    expect(myToolConfigSchema.safeParse({label: 'hot'}).success).toBe(false);
  });
});

describe('toolConfigSchema', () => {
  it('accepts a name on its own', () => {
    expect(toolConfigSchema.parse({name: 'google_search'})).toEqual({
      name: 'google_search',
    });
  });

  it('keeps the whole args bag', () => {
    expect(
      toolConfigSchema.parse({
        name: 'my_package.my_module.makeTool',
        args: {a: 1, b: 'x'},
      }),
    ).toEqual({name: 'my_package.my_module.makeTool', args: {a: 1, b: 'x'}});
  });

  it('requires a name', () => {
    expect(toolConfigSchema.safeParse({args: {a: 1}}).success).toBe(false);
  });

  it('rejects an empty name', () => {
    expect(toolConfigSchema.safeParse({name: ''}).success).toBe(false);
  });

  it('rejects an unknown top-level key', () => {
    expect(
      toolConfigSchema.safeParse({name: 'google_search', argz: {a: 1}}).success,
    ).toBe(false);
  });

  it.each([
    ['a string', 'nope'],
    ['an array', [1, 2]],
  ])('rejects %s as args', (_label, args) => {
    expect(
      toolConfigSchema.safeParse({name: 'google_search', args}).success,
    ).toBe(false);
  });
});

describe('toolConfigSchema, as a declarative tool reference', () => {
  it('accepts a module specifier name with no args', () => {
    expect(toolConfigSchema.parse({name: './my_tools.js#searchTool'})).toEqual({
      name: './my_tools.js#searchTool',
    });
  });

  it('keeps a snake_case arg key verbatim', () => {
    const parsed = toolConfigSchema.parse({
      name: './my_tools.js#createRetriever',
      args: {corpus_id: 'docs-prod'},
    });

    expect(parsed.args).toEqual({corpus_id: 'docs-prod'});
  });
});

describe('toolArgsConfigSchema', () => {
  it('camelCases the keys of the bag, at every depth', () => {
    expect(
      toolArgsConfigSchema.parse({top_k: 5, nested: {max_len: 2}}),
    ).toEqual({topK: 5, nested: {maxLen: 2}});
  });
});

describe('createToolConfig', () => {
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

  it('keeps a snake_case arg key unchanged', () => {
    const config = createToolConfig({
      name: 'VertexAiSearchTool',
      args: {max_results: 10},
    });

    expect(config.args).toEqual({max_results: 10});
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
    const declared: unknown = JSON.parse(
      '{"name": "google_search", "toString": 1}',
    );

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

describe('a YAML tool declaration, from document to tool', () => {
  const config = createToolConfig(yaml.load(VERTEX_AI_SEARCH_YAML));

  it('validates the declaration and keeps the arg keys verbatim', () => {
    expect(config.name).toBe('VertexAiSearchTool');
    expect(config.args).toEqual({
      data_store_specs: [
        {data_store: DATA_STORE_1, filter: 'filter1'},
        {data_store: DATA_STORE_2, filter: 'filter2'},
      ],
      filter: 'filter',
      max_results: 10,
      search_engine_id: SEARCH_ENGINE_ID,
    });
  });

  it('camelCases the args bag at every depth', () => {
    expect(toolArgsConfigSchema.parse(config.args)).toEqual({
      dataStoreSpecs: [
        {dataStore: DATA_STORE_1, filter: 'filter1'},
        {dataStore: DATA_STORE_2, filter: 'filter2'},
      ],
      filter: 'filter',
      maxResults: 10,
      searchEngineId: SEARCH_ENGINE_ID,
    });
  });

  it('builds the tool the declaration names', () => {
    const args = vertexAiSearchArgsSchema.parse(
      toolArgsConfigSchema.parse(config.args),
    );

    const tool = new VertexAiSearchTool(args);

    expect(tool.searchEngineId).toBe(SEARCH_ENGINE_ID);
    expect(tool.filter).toBe('filter');
    expect(tool.maxResults).toBe(10);
    expect(tool.dataStoreSpecs?.[0].dataStore).toBe(DATA_STORE_1);
    expect(tool.dataStoreSpecs?.[1].dataStore).toBe(DATA_STORE_2);
  });
});
