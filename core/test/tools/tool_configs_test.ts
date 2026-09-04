/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseToolConfig,
  InputValidationError,
  ToolArgsConfig,
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

/** The declaration as an agent config document camelCases it. */
const VERTEX_AI_SEARCH_YAML = `
name: VertexAiSearchTool
args:
  dataStoreSpecs:
    - dataStore: ${DATA_STORE_1}
      filter: filter1
    - dataStore: ${DATA_STORE_2}
      filter: filter2
  filter: filter
  maxResults: 10
  searchEngineId: ${SEARCH_ENGINE_ID}
`;

/** The declaration of the adk-python test, snake_case as Python writes it. */
const VERTEX_AI_SEARCH_PYTHON_YAML = `
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

/** Maps the args of a document onto the options of the tool, as a host does. */
const vertexAiSearchArgsSchema = z
  .object({
    search_engine_id: z.string(),
    filter: z.string(),
    max_results: z.number(),
    data_store_specs: z.array(z.object({data_store: z.string()})),
  })
  .transform((args) => ({
    searchEngineId: args.search_engine_id,
    filter: args.filter,
    maxResults: args.max_results,
    dataStoreSpecs: args.data_store_specs.map((spec) => ({
      dataStore: spec.data_store,
    })),
  }));

/** The args a tool declares for itself, as a tool narrows them. */
interface SearchToolArgsConfig {
  searchEngineId: string;
}

describe('toolConfigSchema', () => {
  it('accepts a name on its own, and leaves args undefined', () => {
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

  it('keeps an empty args bag distinct from an omitted one', () => {
    expect(
      toolConfigSchema.parse({name: 'google_search', args: {}}).args,
    ).toEqual({});
  });

  it('preserves an arg key no adk-js tool declares', () => {
    const parsed = toolConfigSchema.parse({
      name: 'my_package.my_module.myTool',
      args: {somethingNobodyDeclares: 'kept'},
    });

    expect(parsed.args).toEqual({somethingNobodyDeclares: 'kept'});
  });

  it('requires a name', () => {
    expect(toolConfigSchema.safeParse({args: {a: 1}}).success).toBe(false);
  });

  it('rejects an empty name', () => {
    expect(toolConfigSchema.safeParse({name: ''}).success).toBe(false);
  });

  it('rejects a name that is not a string', () => {
    expect(toolConfigSchema.safeParse({name: 123}).success).toBe(false);
  });

  it('rejects an unknown top-level key', () => {
    expect(
      toolConfigSchema.safeParse({name: 'google_search', argz: {a: 1}}).success,
    ).toBe(false);
  });

  it('names every unknown top-level key', () => {
    const result = toolConfigSchema.safeParse({
      name: 'google_search',
      arg: {},
      nmae: 'x',
    });

    expect(result.success).toBe(false);
    const reported = JSON.stringify(result.error?.issues);
    expect(reported).toContain('arg');
    expect(reported).toContain('nmae');
  });

  it('rejects a key that only Object.prototype declares', () => {
    const declared: unknown = JSON.parse(
      '{"name": "google_search", "toString": 1}',
    );

    expect(toolConfigSchema.safeParse(declared).success).toBe(false);
  });

  it.each([
    ['null', null],
    ['a string', 'google_search'],
    ['a number', 42],
    ['an array', []],
    ['a function', () => 'google_search'],
  ])('rejects %s as a declaration', (_label, declared) => {
    expect(toolConfigSchema.safeParse(declared).success).toBe(false);
  });

  it.each([
    ['null', null],
    ['a string', 'searchEngineId=e'],
    ['an array', []],
  ])('rejects %s as args', (_label, args) => {
    expect(
      toolConfigSchema.safeParse({name: 'VertexAiSearchTool', args}).success,
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
  it('accepts a tool-specific args interface', () => {
    const searchArgs: SearchToolArgsConfig = {searchEngineId: 'engines/e'};
    // An interface is not assignable to an index-signature type, so this
    // annotation stops ToolArgsConfig from growing one.
    const args: ToolArgsConfig = searchArgs;

    const config = createToolConfig({name: 'VertexAiSearchTool', args});

    expect(config.args).toEqual({searchEngineId: 'engines/e'});
  });

  it('round-trips a YAML tool declaration with nested args', () => {
    const config = createToolConfig(yaml.load(VERTEX_AI_SEARCH_YAML));

    expect(config.name).toBe('VertexAiSearchTool');
    expect(config.args).toEqual({
      dataStoreSpecs: [
        {dataStore: DATA_STORE_1, filter: 'filter1'},
        {dataStore: DATA_STORE_2, filter: 'filter2'},
      ],
      filter: 'filter',
      maxResults: 10,
      searchEngineId: SEARCH_ENGINE_ID,
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
      /ToolConfig: Unrecognized key: "arg"/,
    );
  });

  it('names every unknown top-level key', () => {
    const declare = () =>
      createToolConfig({name: 'google_search', arg: {}, nmae: 'x'});

    expect(declare).toThrow(InputValidationError);
    expect(declare).toThrow('ToolConfig: Unrecognized keys: "arg", "nmae"');
  });

  it('rejects a key that only Object.prototype declares', () => {
    const declared = JSON.parse('{"name": "google_search", "toString": 1}');

    expect(() => createToolConfig(declared)).toThrow(
      /ToolConfig: Unrecognized key: "toString"/,
    );
  });

  it('rejects a declaration without a name', () => {
    expect(() => createToolConfig({args: {}})).toThrow(
      /name: Invalid input: expected string, received undefined/,
    );
  });

  it('rejects a name that is not a string', () => {
    expect(() => createToolConfig({name: 123})).toThrow(
      /name: Invalid input: expected string, received number/,
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
      /ToolConfig: Invalid input: expected object, received/,
    );
  });

  it.each([
    ['a string', 'searchEngineId=e'],
    ['an array', []],
  ])('rejects %s as args', (_label, args) => {
    expect(() => createToolConfig({name: 'VertexAiSearchTool', args})).toThrow(
      /args: Invalid input: expected object, received/,
    );
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

describe('baseToolConfigSchema', () => {
  const myToolConfigSchema = baseToolConfigSchema.extend({
    threshold: z.number(),
    label: z.string().optional(),
  });

  it('accepts a declaration that carries no key', () => {
    expect(baseToolConfigSchema.parse({})).toEqual({});
  });

  it('rejects a key it was not extended with', () => {
    expect(() => baseToolConfigSchema.parse({threshold: 1})).toThrow(
      /threshold/,
    );
  });

  it('accepts the declared keys of an extension', () => {
    expect(myToolConfigSchema.parse({threshold: 1})).toEqual({threshold: 1});
    expect(myToolConfigSchema.parse({threshold: 1, label: 'hot'})).toEqual({
      threshold: 1,
      label: 'hot',
    });
  });

  it('carries the strict-key rule into a custom tool config', () => {
    expect(() => myToolConfigSchema.parse({threshold: 1, thresold: 2})).toThrow(
      /thresold/,
    );
  });

  it('rejects a declared key of the wrong type', () => {
    expect(() => myToolConfigSchema.parse({threshold: 'high'})).toThrow(
      /threshold/,
    );
  });

  it('rejects a missing required key of an extension', () => {
    expect(myToolConfigSchema.safeParse({label: 'hot'}).success).toBe(false);
  });

  it('parses to a BaseToolConfig', () => {
    const config: BaseToolConfig = baseToolConfigSchema.parse({});

    expect(config).toEqual({});
  });
});

describe('a YAML tool declaration, from document to tool', () => {
  const config = toolConfigSchema.parse(
    yaml.load(VERTEX_AI_SEARCH_PYTHON_YAML),
  );

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

  it('builds the tool the declaration names', () => {
    const tool = new VertexAiSearchTool(
      vertexAiSearchArgsSchema.parse(config.args),
    );

    expect(tool.searchEngineId).toBe(SEARCH_ENGINE_ID);
    expect(tool.filter).toBe('filter');
    expect(tool.maxResults).toBe(10);
    expect(tool.dataStoreSpecs?.[0].dataStore).toBe(DATA_STORE_1);
    expect(tool.dataStoreSpecs?.[1].dataStore).toBe(DATA_STORE_2);
  });
});
