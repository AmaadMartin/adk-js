import {describe, it, expect, vi, beforeEach} from 'vitest';
import {BigQueryToolset} from '../../src/bigquery/bigquery_toolset.js';
import {WriteMode} from '../../src/bigquery/bigquery_config.js';
import {getBigQueryClient} from '../../src/bigquery/client.js';
import * as metadataTools from '../../src/bigquery/metadata_tools.js';
import * as queryTools from '../../src/bigquery/query_tools.js';
import {BigQuery} from '@google-cloud/bigquery';

// Mock the BigQuery client module
vi.mock('@google-cloud/bigquery', () => ({
  BigQuery: vi.fn(),
}));

describe('BigQuery client', () => {
  it('should instantiate BigQuery correctly', () => {
    getBigQueryClient('my-proj', {keyFilename: 'key.json'}, {location: 'US'}, 'caller');
    expect(BigQuery).toHaveBeenCalledWith({
      projectId: 'my-proj',
      keyFilename: 'key.json',
      credentials: undefined,
      location: 'US',
    });
  });
  it('should infer project id', () => {
    getBigQueryClient(undefined, {projectId: 'p2'});
    expect(BigQuery).toHaveBeenCalledWith({
      projectId: 'p2',
      keyFilename: undefined,
      credentials: undefined,
    });
  });
});

describe('Metadata tools', () => {
  const mockBqClient = {
    dataset: vi.fn(),
    job: vi.fn(),
    getDatasets: vi.fn(),
  };

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(BigQuery).mockImplementation(() => mockBqClient as any);
  });

  it('listDatasetIds', async () => {
    mockBqClient.getDatasets.mockResolvedValue([[{id: 'd1'}, {}, {id: 'd2'}], {}]);
    const res = await metadataTools.listDatasetIds('proj');
    expect(res).toEqual({status: 'SUCCESS', datasets: ['d1', 'd2']});
    
    mockBqClient.getDatasets.mockRejectedValue(new Error('error msg'));
    const errRes = await metadataTools.listDatasetIds('proj');
    expect(errRes).toEqual({status: 'ERROR', error_details: 'error msg'});

    mockBqClient.getDatasets.mockRejectedValue('string error');
    const errRes2 = await metadataTools.listDatasetIds('proj');
    expect(errRes2).toEqual({status: 'ERROR', error_details: 'string error'});
  });

  it('getDatasetInfo', async () => {
    const mockGet = vi.fn().mockResolvedValue([{metadata: {id: 'd1'}}]);
    mockBqClient.dataset.mockReturnValue({get: mockGet} as any);
    const res = await metadataTools.getDatasetInfo('proj', 'd1');
    expect(res).toEqual({id: 'd1'});

    mockGet.mockRejectedValue(new Error('err'));
    const errRes = await metadataTools.getDatasetInfo('proj', 'd1');
    expect(errRes).toEqual({status: 'ERROR', error_details: 'err'});

    mockGet.mockRejectedValue('str err');
    const errRes2 = await metadataTools.getDatasetInfo('proj', 'd1');
    expect(errRes2).toEqual({status: 'ERROR', error_details: 'str err'});
  });

  it('listTableIds', async () => {
    const mockGetTables = vi.fn().mockResolvedValue([[{id: 't1'}, {}]]);
    mockBqClient.dataset.mockReturnValue({getTables: mockGetTables} as any);
    const res = await metadataTools.listTableIds('proj', 'd1');
    expect(res).toEqual({status: 'SUCCESS', tables: ['t1']});

    mockGetTables.mockRejectedValue(new Error('err'));
    const errRes = await metadataTools.listTableIds('proj', 'd1');
    expect(errRes).toEqual({status: 'ERROR', error_details: 'err'});

    mockGetTables.mockRejectedValue('str err');
    const errRes2 = await metadataTools.listTableIds('proj', 'd1');
    expect(errRes2).toEqual({status: 'ERROR', error_details: 'str err'});
  });

  it('getTableInfo', async () => {
    const mockGet = vi.fn().mockResolvedValue([{metadata: {id: 't1'}}]);
    const mockTable = vi.fn().mockReturnValue({get: mockGet} as any);
    mockBqClient.dataset.mockReturnValue({table: mockTable} as any);
    
    const res = await metadataTools.getTableInfo('proj', 'd1', 't1');
    expect(res).toEqual({id: 't1'});

    mockGet.mockRejectedValue(new Error('err'));
    const errRes = await metadataTools.getTableInfo('proj', 'd1', 't1');
    expect(errRes).toEqual({status: 'ERROR', error_details: 'err'});

    mockGet.mockRejectedValue('str err');
    const errRes2 = await metadataTools.getTableInfo('proj', 'd1', 't1');
    expect(errRes2).toEqual({status: 'ERROR', error_details: 'str err'});
  });

  it('getJobInfo', async () => {
    const mockGet = vi.fn().mockResolvedValue([{metadata: {id: 'j1'}}]);
    mockBqClient.job.mockReturnValue({get: mockGet} as any);
    
    const res = await metadataTools.getJobInfo('proj', 'j1');
    expect(res).toEqual({id: 'j1'});

    mockGet.mockRejectedValue(new Error('err'));
    const errRes = await metadataTools.getJobInfo('proj', 'j1');
    expect(errRes).toEqual({status: 'ERROR', error_details: 'err'});

    mockGet.mockRejectedValue('str err');
    const errRes2 = await metadataTools.getJobInfo('proj', 'j1');
    expect(errRes2).toEqual({status: 'ERROR', error_details: 'str err'});
  });
});

describe('Query tools', () => {
  let mockBqClient: any;

  beforeEach(() => {
    vi.resetAllMocks();
    mockBqClient = {
      createQueryJob: vi.fn(),
      query: vi.fn(),
    };
    vi.mocked(BigQuery).mockImplementation(() => mockBqClient as any);
  });

  it('executeSql - blocked compute project', async () => {
    const res = await queryTools.executeSql('proj1', 'sql', undefined, {computeProjectId: 'proj2'});
    expect(res.status).toBe('ERROR');
    expect(res.error_details).toContain('Cannot execute query');
  });

  it('executeSql - blocked mode checks for SELECT', async () => {
    mockBqClient.createQueryJob.mockResolvedValue([{
      metadata: {statistics: {query: {statementType: 'UPDATE'}}}
    }]);
    const res = await queryTools.executeSql('p', 'update', undefined, {writeMode: WriteMode.BLOCKED, applicationName: 'app1'});
    expect(res.status).toBe('ERROR');
    expect(res.error_details).toBe('Read-only mode only supports SELECT statements.');
  });

  it('executeSql - protected mode no context', async () => {
    mockBqClient.createQueryJob.mockResolvedValueOnce([{
      metadata: {
        statistics: {sessionInfo: {sessionId: 'sec1'}},
        configuration: {query: {destinationTable: {datasetId: 'd1'}}}
      }
    }]).mockResolvedValueOnce([{
      metadata: {
        statistics: {query: {statementType: 'UPDATE'}},
        configuration: {query: {destinationTable: {datasetId: 'd2'}}}
      }
    }]);
    const ctx: any = {state: new Map()};
    const res = await queryTools.executeSql('p', 'update t1', undefined, {writeMode: WriteMode.PROTECTED, jobLabels: {k: 'v'}}, ctx);
    expect(res.status).toBe('ERROR');
    expect(res.error_details).toContain('Protected write mode only supports SELECT statements');
  });

  it('executeSql - protected mode with context', async () => {
    mockBqClient.createQueryJob.mockResolvedValue([{
      metadata: {
        statistics: {query: {statementType: 'UPDATE'}},
        configuration: {query: {destinationTable: {datasetId: 'd1'}}}
      }
    }]);
    const ctx: any = {state: new Map([['bigquery_session_info', ['sec1', 'd1']]])};
    
    mockBqClient.query.mockResolvedValue([[{a: 1}]]);

    const res = await queryTools.executeSql('p', 'update t1', undefined, {writeMode: WriteMode.PROTECTED}, ctx);
    expect(res.status).toBe('SUCCESS');
    expect(res.rows).toEqual([{a: 1}]);
  });

  it('executeSql - protected mode no context and missing sessionInfo', async () => {
    mockBqClient.createQueryJob.mockResolvedValue([{
      metadata: {
        statistics: {},
        configuration: {query: {destinationTable: {datasetId: 'd1'}}}
      }
    }]);
    const ctx: any = {state: new Map()};
    const res = await queryTools.executeSql('p', 'update t1', undefined, {writeMode: WriteMode.PROTECTED}, ctx);
    expect(res.status).toBe('ERROR');
  });

  it('executeSql - success flow with dryRun', async () => {
    mockBqClient.createQueryJob.mockResolvedValue([{
      metadata: {statistics: {query: {statementType: 'SELECT'}}}
    }]);
    const res = await queryTools.executeSql('p', 'sel', undefined, undefined, undefined, true);
    expect(res.status).toBe('SUCCESS');
    expect(res.dry_run_info).toBeDefined();
  });

  it('executeSql - success flow full execution with mapping and maxRows', async () => {
    mockBqClient.createQueryJob.mockResolvedValue([{
      metadata: {statistics: {query: {statementType: 'SELECT'}}}
    }]);
    mockBqClient.query.mockResolvedValue([[
      {col1: {value: 'v1'}}, 
      {col1: 'v2'}
    ]]);
    const res = await queryTools.executeSql('p', 'sel', undefined, {maxQueryResultRows: 1, maximumBytesBilled: 100});
    expect(res.status).toBe('SUCCESS');
    expect(res.rows).toEqual([{col1: 'v1'}]);
    expect(res.result_is_likely_truncated).toBe(true);
  });

  it('executeSql - error catching', async () => {
    mockBqClient.query.mockRejectedValue(new Error('bq err'));
    mockBqClient.createQueryJob.mockResolvedValue([{
      metadata: {statistics: {query: {statementType: 'SELECT'}}}
    }]);
    const res = await queryTools.executeSql('p', 'sel', undefined, {writeMode: WriteMode.ALLOWED});
    expect(res.status).toBe('ERROR');
    expect(res.error_details).toBe('bq err');

    mockBqClient.query.mockRejectedValue('str err');
    const res2 = await queryTools.executeSql('p', 'sel', undefined, {writeMode: WriteMode.ALLOWED});
    expect(res2.status).toBe('ERROR');
    expect(res2.error_details).toBe('str err');
  });
});

describe('BigQueryToolset', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('should initialize and return tools properly', async () => {
    const toolset = new BigQueryToolset();
    const tools = await toolset.getTools();
    expect(tools).toHaveLength(6);
    await toolset.close();
  });
  
  it('should filter tools with array', async () => {
    const toolset = new BigQueryToolset(['execute_sql']);
    const tools = await toolset.getTools();
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('execute_sql');
  });
  
  it('should filter tools with predicate and readonly_context', async () => {
    const toolset = new BigQueryToolset((tool, ctx) => tool.name === 'list_dataset_ids');
    const tools = await toolset.getTools({} as any);
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('list_dataset_ids');
  });

  it('should execute get_dataset_info properly', async () => {
    const spy = vi.spyOn(metadataTools, 'getDatasetInfo').mockResolvedValue({status:'SUCCESS'} as any);
    const toolset = new BigQueryToolset(['get_dataset_info']);
    const [tool] = await toolset.getTools();
    await tool.runAsync({args: {project_id: 'p', dataset_id: 'd'}, toolContext: {} as any});
    expect(spy).toHaveBeenCalledWith('p', 'd', undefined, {});
  });

  it('should execute list_dataset_ids properly', async () => {
    const spy = vi.spyOn(metadataTools, 'listDatasetIds').mockResolvedValue({status:'SUCCESS'} as any);
    const toolset = new BigQueryToolset(['list_dataset_ids']);
    const [tool] = await toolset.getTools();
    await tool.runAsync({args: {project_id: 'p'}, toolContext: {} as any});
    expect(spy).toHaveBeenCalled();
  });
  
  it('should execute get_table_info properly', async () => {
    const spy = vi.spyOn(metadataTools, 'getTableInfo').mockResolvedValue({status:'SUCCESS'} as any);
    const toolset = new BigQueryToolset(['get_table_info']);
    const [tool] = await toolset.getTools();
    await tool.runAsync({args: {project_id: 'p', dataset_id: 'd', table_id: 't'}, toolContext: {} as any});
    expect(spy).toHaveBeenCalled();
  });

  it('should execute list_table_ids properly', async () => {
    const spy = vi.spyOn(metadataTools, 'listTableIds').mockResolvedValue({status:'SUCCESS'} as any);
    const toolset = new BigQueryToolset(['list_table_ids']);
    const [tool] = await toolset.getTools();
    await tool.runAsync({args: {project_id: 'p', dataset_id: 'd'}, toolContext: {} as any});
    expect(spy).toHaveBeenCalled();
  });
  
  it('should execute get_job_info properly', async () => {
    const spy = vi.spyOn(metadataTools, 'getJobInfo').mockResolvedValue({status:'SUCCESS'} as any);
    const toolset = new BigQueryToolset(['get_job_info']);
    const [tool] = await toolset.getTools();
    await tool.runAsync({args: {project_id: 'p', job_id: 'j'}, toolContext: {} as any});
    expect(spy).toHaveBeenCalled();
  });
  
  it('should execute execute_sql properly', async () => {
    const spy = vi.spyOn(queryTools, 'executeSql').mockResolvedValue({status:'SUCCESS'} as any);
    const toolset = new BigQueryToolset(['execute_sql']);
    const [tool] = await toolset.getTools();
    await tool.runAsync({args: {project_id: 'p', query: 'sql'}, toolContext: {} as any});
    expect(spy).toHaveBeenCalled();
  });
});
