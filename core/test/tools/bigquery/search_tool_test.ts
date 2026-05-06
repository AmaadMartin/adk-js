/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import {beforeEach, describe, expect, it, vi} from 'vitest';
import {Context} from '../../../src/agents/context.js';
import {InvocationContext} from '../../../src/agents/invocation_context.js';
import * as searchTool from '../../../src/tools/bigquery/search_tool.js';

const mockSearchEntries = vi.fn();

vi.mock('@google-cloud/dataplex', () => {
  return {
    CatalogServiceClient: vi.fn().mockImplementation(() => {
      return {
        searchEntries: mockSearchEntries,
      };
    }),
  };
});

describe('Search Tool', () => {
  let context: Context;

  beforeEach(() => {
    vi.clearAllMocks();
    context = new Context({
      invocationContext: {
        session: {id: 'session-1', state: new Map()},
      } as unknown as InvocationContext,
      functionCallId: 'test-call-id',
    });
  });

  it('searchCatalog should return success with formatted results (basic)', async () => {
    const mockResponse = [
      {
        dataplexEntry: {
          name: 'entry-name',
          entryType: 'type',
          updateTime: 'time',
          entrySource: {
            displayName: 'display',
            resource: 'resource',
            description: 'desc',
            location: 'loc',
          },
        },
      },
    ];

    mockSearchEntries.mockResolvedValue([mockResponse]);

    const result = await searchTool.searchCatalog(
      {
        prompt: 'search query',
        projectId: 'project',
      },
      undefined,
      undefined,
      context,
    );

    expect(result.status).toBe('SUCCESS');
    expect(result.results).toEqual([
      {
        name: 'entry-name',
        display_name: 'display',
        entry_type: 'type',
        update_time: 'time',
        linked_resource: 'resource',
        description: 'desc',
        location: 'loc',
      },
    ]);
    expect(mockSearchEntries).toHaveBeenCalledWith(
      expect.objectContaining({
        query: expect.stringContaining('search query'),
        name: 'projects/project/locations/global',
      }),
    );
  });

  it('should fail if projectId is missing', async () => {
    const result = await searchTool.searchCatalog(
      {
        prompt: 'search query',
        projectId: '',
      },
      undefined,
      undefined,
      context,
    );
    expect(result.status).toBe('ERROR');
    expect(result.error_details).toBe('projectId must be provided.');
  });

  it('should apply datasetIdsFilter and projectIdsFilter', async () => {
    mockSearchEntries.mockResolvedValue([[]]);

    await searchTool.searchCatalog(
      {
        prompt: 'query',
        projectId: 'project',
        projectIdsFilter: ['p1', 'p2'],
        datasetIdsFilter: ['d1', 'd2'],
      },
      undefined,
      undefined,
      context,
    );

    expect(mockSearchEntries).toHaveBeenCalledWith(
      expect.objectContaining({
        query: expect.stringContaining(
          '(linked_resource:"//bigquery.googleapis.com/projects/p1/datasets/d1/*" OR linked_resource:"//bigquery.googleapis.com/projects/p1/datasets/d2/*" OR linked_resource:"//bigquery.googleapis.com/projects/p2/datasets/d1/*" OR linked_resource:"//bigquery.googleapis.com/projects/p2/datasets/d2/*")',
        ),
      }),
    );
  });

  it('should apply typesFilter with multiple types', async () => {
    mockSearchEntries.mockResolvedValue([[]]);

    await searchTool.searchCatalog(
      {
        prompt: 'query',
        projectId: 'project',
        typesFilter: ['t1', 't2'],
      },
      undefined,
      undefined,
      context,
    );

    expect(mockSearchEntries).toHaveBeenCalledWith(
      expect.objectContaining({
        query: expect.stringContaining('(type="t1" OR type="t2")'),
      }),
    );
  });

  it('should handle API errors', async () => {
    mockSearchEntries.mockRejectedValue(new Error('Dataplex Error'));

    const result = await searchTool.searchCatalog(
      {
        prompt: 'query',
        projectId: 'project',
      },
      undefined,
      undefined,
      context,
    );

    expect(result.status).toBe('ERROR');
    expect(result.error_details).toBe('Dataplex Error');
  });

  it('should handle API errors with string throw', async () => {
    mockSearchEntries.mockRejectedValue('String Error');

    const result = await searchTool.searchCatalog(
      {
        prompt: 'query',
        projectId: 'project',
      },
      undefined,
      undefined,
      context,
    );

    expect(result.status).toBe('ERROR');
    expect(result.error_details).toBe('String Error');
  });

  it('should handle empty typesFilter by not adding type clause', async () => {
    mockSearchEntries.mockResolvedValue([[]]);

    await searchTool.searchCatalog(
      {
        prompt: 'query',
        projectId: 'project',
        typesFilter: [],
      },
      undefined,
      undefined,
      context,
    );

    const callArgs = mockSearchEntries.mock.calls[0][0];
    expect(callArgs.query).not.toContain('type=');
  });

  it('should apply location from args or toolConfig', async () => {
    mockSearchEntries.mockResolvedValue([[]]);

    await searchTool.searchCatalog(
      {
        prompt: 'query',
        projectId: 'project',
        location: 'us-central1',
      },
      undefined,
      undefined,
      context,
    );
    expect(mockSearchEntries).toHaveBeenLastCalledWith(
      expect.objectContaining({
        name: 'projects/project/locations/us-central1',
      }),
    );

    await searchTool.searchCatalog(
      {
        prompt: 'query',
        projectId: 'project',
      },
      undefined,
      {location: 'europe-west1'} as any,
      context,
    );
    expect(mockSearchEntries).toHaveBeenLastCalledWith(
      expect.objectContaining({
        name: 'projects/project/locations/europe-west1',
      }),
    );
  });

  it('should handle search results with missing fields (fallbacks)', async () => {
    const mockResponse = [
      {
        dataplexEntry: {
          name: 'entry-name',
        },
      },
    ];

    mockSearchEntries.mockResolvedValue([mockResponse]);

    const result = await searchTool.searchCatalog(
      {
        prompt: 'query',
        projectId: 'project',
      },
      undefined,
      undefined,
      context,
    );

    expect(result.status).toBe('SUCCESS');
    expect(result.results).toEqual([
      {
        name: 'entry-name',
        display_name: '',
        entry_type: undefined,
        update_time: '',
        linked_resource: '',
        description: '',
        location: '',
      },
    ]);
  });

  it('should handle falsy responseResults and missing dataplexEntry', async () => {
    mockSearchEntries.mockResolvedValueOnce([]);

    let result = await searchTool.searchCatalog(
      {prompt: 'query', projectId: 'project'},
      undefined,
      undefined,
      context,
    );

    expect(result.status).toBe('SUCCESS');
    expect(result.results).toEqual([]);

    mockSearchEntries.mockResolvedValueOnce([[{}]]);

    result = await searchTool.searchCatalog(
      {prompt: 'query', projectId: 'project'},
      undefined,
      undefined,
      context,
    );

    expect(result.status).toBe('SUCCESS');
    expect(result.results).toEqual([
      {
        name: undefined,
        display_name: '',
        entry_type: undefined,
        update_time: '',
        linked_resource: '',
        description: '',
        location: '',
      },
    ]);
  });
});
