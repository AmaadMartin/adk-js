/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  APPROXIMATE_NEAREST_NEIGHBORS,
  EXACT_NEAREST_NEIGHBORS,
  FeatureName,
  FeatureStage,
  SpannerCapabilities,
  SpannerQueryResultMode,
  SpannerToolSettings,
  SpannerVectorStoreSettings,
  createSpannerToolSettings,
  createSpannerVectorStoreSettings,
  createVectorSearchIndexSettings,
  getFeatureConfig,
  overrideFeatureEnabled,
} from '@google/adk';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {logger} from '../../../src/utils/logger.js';

const DISABLE_ENV_VAR = 'ADK_DISABLE_SPANNER_TOOL_SETTINGS';

function commonVectorStoreSettings(
  overrides: Partial<SpannerVectorStoreSettings> = {},
): SpannerVectorStoreSettings {
  return {
    projectId: 'test-project',
    instanceId: 'test-instance',
    databaseId: 'test-database',
    tableName: 'test-table',
    contentColumn: 'test-content-column',
    embeddingColumn: 'test-embedding-column',
    vectorLength: 128,
    vertexAiEmbeddingModelName: 'test-embedding-model',
    ...overrides,
  };
}

function spyOnLoggerWarn() {
  return vi.spyOn(logger, 'warn').mockImplementation(() => {});
}

describe('Spanner tool settings', () => {
  const originalEnv = process.env;
  let warnSpy: ReturnType<typeof spyOnLoggerWarn>;

  beforeEach(() => {
    process.env = {...originalEnv};
    delete process.env[DISABLE_ENV_VAR];
    warnSpy = spyOnLoggerWarn();
  });

  afterEach(() => {
    process.env = originalEnv;
    overrideFeatureEnabled(FeatureName.SPANNER_TOOL_SETTINGS, undefined);
    vi.restoreAllMocks();
  });

  // This case must stay first: the registry warns once per process and adk-js
  // exports no reset for its warned-feature set.
  it('warns once that SPANNER_TOOL_SETTINGS is enabled', () => {
    createSpannerToolSettings();

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('SPANNER_TOOL_SETTINGS is enabled.'),
    );

    createSpannerToolSettings();

    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('registers SPANNER_TOOL_SETTINGS as experimental and on by default', () => {
    const config = getFeatureConfig(FeatureName.SPANNER_TOOL_SETTINGS);

    expect(config?.stage).toBe(FeatureStage.EXPERIMENTAL);
    expect(config?.defaultOn).toBe(true);
  });

  describe('createSpannerToolSettings', () => {
    const cases: Array<{
      name: string;
      params: SpannerToolSettings;
      expectedRows: number;
      expectedMode: SpannerQueryResultMode;
      expectedRole: string | undefined;
    }> = [
      {
        name: 'no arguments',
        params: {},
        expectedRows: 50,
        expectedMode: SpannerQueryResultMode.DEFAULT,
        expectedRole: undefined,
      },
      {
        name: 'explicit capabilities, rows and result mode',
        params: {
          capabilities: [SpannerCapabilities.DATA_READ],
          maxExecutedQueryResultRows: 100,
          queryResultMode: SpannerQueryResultMode.DICT_LIST,
        },
        expectedRows: 100,
        expectedMode: SpannerQueryResultMode.DICT_LIST,
        expectedRole: undefined,
      },
      {
        name: 'a database role',
        params: {databaseRole: 'test-role'},
        expectedRows: 50,
        expectedMode: SpannerQueryResultMode.DEFAULT,
        expectedRole: 'test-role',
      },
    ];

    it.each(cases)(
      'applies the adk-python defaults with $name',
      ({params, expectedRows, expectedMode, expectedRole}) => {
        const settings = createSpannerToolSettings(params);

        expect(settings.capabilities).toEqual([SpannerCapabilities.DATA_READ]);
        expect(settings.maxExecutedQueryResultRows).toBe(expectedRows);
        expect(settings.queryResultMode).toBe(expectedMode);
        expect(settings.databaseRole).toBe(expectedRole);
        expect(settings.vectorStoreSettings).toBeUndefined();
      },
    );

    it('applies nested vector store defaults and validation', () => {
      const settings = createSpannerToolSettings({
        vectorStoreSettings: commonVectorStoreSettings(),
      });

      expect(settings.vectorStoreSettings?.selectedColumns).toEqual([
        'test-content-column',
      ]);
      expect(settings.vectorStoreSettings?.topK).toBe(4);

      expect(() =>
        createSpannerToolSettings({
          vectorStoreSettings: commonVectorStoreSettings({vectorLength: 0}),
        }),
      ).toThrow('Invalid vector length in the Spanner vector store settings.');
    });

    it('throws when the feature is disabled programmatically', () => {
      overrideFeatureEnabled(FeatureName.SPANNER_TOOL_SETTINGS, false);

      expect(() => createSpannerToolSettings()).toThrow(
        'Feature SPANNER_TOOL_SETTINGS is not enabled.',
      );
    });

    it(`throws when ${DISABLE_ENV_VAR} disables the feature`, () => {
      process.env[DISABLE_ENV_VAR] = 'true';

      expect(() => createSpannerToolSettings()).toThrow(
        'Feature SPANNER_TOOL_SETTINGS is not enabled.',
      );
    });
  });

  describe('createSpannerVectorStoreSettings', () => {
    it('derives selectedColumns from contentColumn', () => {
      const settings = createSpannerVectorStoreSettings(
        commonVectorStoreSettings(),
      );

      expect(settings.selectedColumns).toEqual(['test-content-column']);
      expect(settings.vertexAiEmbeddingModelName).toBe('test-embedding-model');
    });

    it('preserves supplied selectedColumns', () => {
      const settings = createSpannerVectorStoreSettings(
        commonVectorStoreSettings({selectedColumns: ['a', 'b']}),
      );

      expect(settings.selectedColumns).toEqual(['a', 'b']);
    });

    it('applies the search defaults and preserves explicit values', () => {
      const defaults = createSpannerVectorStoreSettings(
        commonVectorStoreSettings(),
      );

      expect(defaults.topK).toBe(4);
      expect(defaults.distanceType).toBe('COSINE');
      expect(defaults.nearestNeighborsAlgorithm).toBe(EXACT_NEAREST_NEIGHBORS);
      expect(defaults.vectorSearchIndexSettings).toBeUndefined();
      expect(defaults.additionalColumnsToSetup).toBeUndefined();

      const explicit = createSpannerVectorStoreSettings(
        commonVectorStoreSettings({
          topK: 10,
          distanceType: 'EUCLIDEAN',
          nearestNeighborsAlgorithm: APPROXIMATE_NEAREST_NEIGHBORS,
        }),
      );

      expect(explicit.topK).toBe(10);
      expect(explicit.distanceType).toBe('EUCLIDEAN');
      expect(explicit.nearestNeighborsAlgorithm).toBe(
        APPROXIMATE_NEAREST_NEIGHBORS,
      );
    });

    it('applies the index defaults to a nested vectorSearchIndexSettings', () => {
      const settings = createSpannerVectorStoreSettings(
        commonVectorStoreSettings({
          vectorSearchIndexSettings: {indexName: 'idx'},
        }),
      );

      expect(settings.vectorSearchIndexSettings?.treeDepth).toBe(2);
      expect(settings.vectorSearchIndexSettings?.numLeaves).toBe(1000);
    });

    it('defaults isNullable on additionalColumnsToSetup and keeps false', () => {
      const settings = createSpannerVectorStoreSettings(
        commonVectorStoreSettings({
          additionalColumnsToSetup: [
            {name: 'metadata', type: 'JSON'},
            {name: 'category', type: 'STRING(MAX)', isNullable: false},
          ],
        }),
      );

      expect(settings.additionalColumnsToSetup).toEqual([
        {name: 'metadata', type: 'JSON', isNullable: true},
        {name: 'category', type: 'STRING(MAX)', isNullable: false},
      ]);
    });

    it('accepts primary keys naming content, embedding or added columns', () => {
      expect(() =>
        createSpannerVectorStoreSettings(
          commonVectorStoreSettings({
            additionalColumnsToSetup: [{name: 'metadata', type: 'JSON'}],
            primaryKeyColumns: [
              'test-content-column',
              'test-embedding-column',
              'metadata',
            ],
          }),
        ),
      ).not.toThrow();
    });

    it('throws when a primary key names no known column', () => {
      expect(() =>
        createSpannerVectorStoreSettings(
          commonVectorStoreSettings({primaryKeyColumns: ['nope']}),
        ),
      ).toThrow("Primary key column 'nope' not found in column definitions.");
    });

    it.each([0, -1, Number.NaN])(
      'throws when vectorLength is %s',
      (vectorLength) => {
        expect(() =>
          createSpannerVectorStoreSettings(
            commonVectorStoreSettings({vectorLength}),
          ),
        ).toThrow(
          'Invalid vector length in the Spanner vector store settings.',
        );
      },
    );

    it('reports the vector length before the primary key problem', () => {
      expect(() =>
        createSpannerVectorStoreSettings(
          commonVectorStoreSettings({
            vectorLength: 0,
            primaryKeyColumns: ['nope'],
          }),
        ),
      ).toThrow('Invalid vector length in the Spanner vector store settings.');
    });

    it.each([
      'projectId',
      'instanceId',
      'databaseId',
      'tableName',
      'contentColumn',
      'embeddingColumn',
      'vertexAiEmbeddingModelName',
    ] as const)('throws when %s is empty', (field) => {
      expect(() =>
        createSpannerVectorStoreSettings(
          commonVectorStoreSettings({[field]: ''}),
        ),
      ).toThrow(
        `Missing required field '${field}' in the Spanner vector store settings.`,
      );
    });
  });

  describe('createVectorSearchIndexSettings', () => {
    it('applies the tree defaults', () => {
      const settings = createVectorSearchIndexSettings({indexName: 'idx'});

      expect(settings.treeDepth).toBe(2);
      expect(settings.numLeaves).toBe(1000);
    });

    it('preserves explicit tree values', () => {
      const settings = createVectorSearchIndexSettings({
        indexName: 'idx',
        treeDepth: 3,
        numLeaves: 5000,
        numBranches: 100,
      });

      expect(settings.treeDepth).toBe(3);
      expect(settings.numLeaves).toBe(5000);
      expect(settings.numBranches).toBe(100);
    });
  });
});
