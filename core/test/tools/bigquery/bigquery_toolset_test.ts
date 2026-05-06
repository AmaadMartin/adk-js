/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import {describe, expect, it, vi} from 'vitest';
import {Context} from '../../../src/agents/context.js';
import {InvocationContext} from '../../../src/agents/invocation_context.js';
import {BigQueryToolset} from '../../../src/tools/bigquery/bigquery_toolset.js';

const mockListDatasetIds = vi.fn();
const mockGetDatasetInfo = vi.fn();
const mockListTableIds = vi.fn();
const mockGetTableInfo = vi.fn();
const mockGetJobInfo = vi.fn();
const mockExecuteSql = vi.fn();
const mockForecast = vi.fn();
const mockAnalyzeContribution = vi.fn();
const mockDetectAnomalies = vi.fn();
const mockAskDataInsights = vi.fn();
const mockSearchCatalog = vi.fn();

vi.mock('../../../src/tools/bigquery/metadata_tools.js', () => ({
  listDatasetIds: (...args: any[]) => mockListDatasetIds(...args),
  getDatasetInfo: (...args: any[]) => mockGetDatasetInfo(...args),
  listTableIds: (...args: any[]) => mockListTableIds(...args),
  getTableInfo: (...args: any[]) => mockGetTableInfo(...args),
  getJobInfo: (...args: any[]) => mockGetJobInfo(...args),
}));

vi.mock('../../../src/tools/bigquery/query_tools.js', () => ({
  executeSql: (...args: any[]) => mockExecuteSql(...args),
  forecast: (...args: any[]) => mockForecast(...args),
  analyzeContribution: (...args: any[]) => mockAnalyzeContribution(...args),
  detectAnomalies: (...args: any[]) => mockDetectAnomalies(...args),
}));

vi.mock('../../../src/tools/bigquery/data_insights_tool.js', () => ({
  askDataInsights: (...args: any[]) => mockAskDataInsights(...args),
}));

vi.mock('../../../src/tools/bigquery/search_tool.js', () => ({
  searchCatalog: (...args: any[]) => mockSearchCatalog(...args),
}));

describe('BigQueryToolset', () => {
  it('should return all tools by default', async () => {
    const toolset = new BigQueryToolset();
    const tools = await toolset.getTools();
    expect(tools.length).toBe(11);
    const toolNames = tools.map((t) => t.name);
    expect(toolNames).toContain('list_dataset_ids');
    expect(toolNames).toContain('get_dataset_info');
    expect(toolNames).toContain('list_table_ids');
    expect(toolNames).toContain('get_table_info');
    expect(toolNames).toContain('get_job_info');
    expect(toolNames).toContain('execute_sql');
    expect(toolNames).toContain('forecast');
    expect(toolNames).toContain('analyze_contribution');
    expect(toolNames).toContain('detect_anomalies');
    expect(toolNames).toContain('ask_data_insights');
    expect(toolNames).toContain('search_catalog');
  });

  it('should filter tools based on string array', async () => {
    const toolset = new BigQueryToolset({
      toolFilter: ['execute_sql', 'list_dataset_ids'],
    });
    const tools = await toolset.getTools({} as any);
    expect(tools.length).toBe(2);
    const toolNames = tools.map((t) => t.name);
    expect(toolNames).toContain('execute_sql');
    expect(toolNames).toContain('list_dataset_ids');
    expect(toolNames).not.toContain('forecast');
  });

  it('should filter tools based on predicate', async () => {
    const toolset = new BigQueryToolset({
      toolFilter: (tool) => tool.name.startsWith('list_'),
    });
    const tools = await toolset.getTools({} as any);
    expect(tools.length).toBe(2);
    const toolNames = tools.map((t) => t.name);
    expect(toolNames).toContain('list_dataset_ids');
    expect(toolNames).toContain('list_table_ids');
    expect(toolNames).not.toContain('execute_sql');
  });

  it('should call close successfully', async () => {
    const toolset = new BigQueryToolset();
    await expect(toolset.close()).resolves.toBeUndefined();
  });

  it('should execute all tools successfully via wrappers', async () => {
    const credentialsConfig = {credentials: {token: 'token'}};
    const bigqueryToolConfig = {location: 'US'};
    const toolset = new BigQueryToolset({
      credentialsConfig,
      bigqueryToolConfig,
    });
    const tools = await toolset.getTools();
    const context = new Context({
      invocationContext: {
        session: {id: 'session-1', state: new Map()},
      } as unknown as InvocationContext,
      functionCallId: 'test-call-id',
    });

    for (const tool of tools) {
      const args = getDummyArgsForTool(tool.name);
      await tool.execute(args, context);
    }

    expect(mockListDatasetIds).toHaveBeenCalledWith(
      expect.any(Object),
      credentialsConfig,
      bigqueryToolConfig,
      context,
    );
    expect(mockGetDatasetInfo).toHaveBeenCalledWith(
      expect.any(Object),
      credentialsConfig,
      bigqueryToolConfig,
      context,
    );
    expect(mockListTableIds).toHaveBeenCalledWith(
      expect.any(Object),
      credentialsConfig,
      bigqueryToolConfig,
      context,
    );
    expect(mockGetTableInfo).toHaveBeenCalledWith(
      expect.any(Object),
      credentialsConfig,
      bigqueryToolConfig,
      context,
    );
    expect(mockGetJobInfo).toHaveBeenCalledWith(
      expect.any(Object),
      credentialsConfig,
      bigqueryToolConfig,
      context,
    );
    expect(mockExecuteSql).toHaveBeenCalledWith(
      expect.any(Object),
      credentialsConfig,
      bigqueryToolConfig,
      context,
    );
    expect(mockForecast).toHaveBeenCalledWith(
      expect.any(Object),
      credentialsConfig,
      bigqueryToolConfig,
      context,
    );
    expect(mockAnalyzeContribution).toHaveBeenCalledWith(
      expect.any(Object),
      credentialsConfig,
      bigqueryToolConfig,
      context,
    );
    expect(mockDetectAnomalies).toHaveBeenCalledWith(
      expect.any(Object),
      credentialsConfig,
      bigqueryToolConfig,
      context,
    );
    expect(mockAskDataInsights).toHaveBeenCalledWith(
      expect.any(Object),
      credentialsConfig,
      bigqueryToolConfig,
      context,
    );
    expect(mockSearchCatalog).toHaveBeenCalledWith(
      expect.any(Object),
      credentialsConfig,
      bigqueryToolConfig,
      context,
    );
  });
});

function getDummyArgsForTool(name: string): any {
  switch (name) {
    case 'list_dataset_ids':
      return {projectId: 'p'};
    case 'get_dataset_info':
      return {projectId: 'p', datasetId: 'd'};
    case 'list_table_ids':
      return {projectId: 'p', datasetId: 'd'};
    case 'get_table_info':
      return {projectId: 'p', datasetId: 'd', tableId: 't'};
    case 'get_job_info':
      return {projectId: 'p', jobId: 'j'};
    case 'execute_sql':
      return {projectId: 'p', query: 'q'};
    case 'forecast':
      return {
        projectId: 'p',
        historyData: 'h',
        timestampCol: 't',
        dataCol: 'd',
      };
    case 'analyze_contribution':
      return {
        projectId: 'p',
        inputData: 'i',
        contributionMetric: 'm',
        dimensionIdCols: ['d'],
        isTestCol: 't',
      };
    case 'detect_anomalies':
      return {
        projectId: 'p',
        historyData: 'h',
        timesSeriesTimestampCol: 't',
        timesSeriesDataCol: 'd',
      };
    case 'ask_data_insights':
      return {projectId: 'p', userQueryWithContext: 'q', tableReferences: []};
    case 'search_catalog':
      return {prompt: 'p', projectId: 'p'};
    default:
      return {};
  }
}
