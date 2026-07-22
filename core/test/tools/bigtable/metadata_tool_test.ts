import {describe, it, expect, vi, beforeEach} from 'vitest';
import * as metadataTool from '../../../src/tools/bigtable/metadata_tool.js';
import {Bigtable} from '@google-cloud/bigtable';

vi.mock('@google-cloud/bigtable');

describe('Bigtable Metadata Tool', () => {
    let mockClient: any;
    
    beforeEach(() => {
        vi.clearAllMocks();
        mockClient = {
            getInstances: vi.fn(),
            instance: vi.fn(),
        };
        (Bigtable as any).mockImplementation(() => mockClient);
    });

    it('listInstances should return instances successfully', async () => {
        mockClient.getInstances.mockResolvedValue([
            [{ id: 'inst1', metadata: { displayName: 'Inst 1', state: 'READY', type: 'PRODUCTION', labels: { env: 'prod' } } }]
        ]);
        const res = await metadataTool.listInstances('proj-1');
        expect(res.status).toBe('SUCCESS');
        expect(res.results).toEqual([{
            project_id: 'proj-1',
            instance_id: 'inst1',
            display_name: 'Inst 1',
            state: 'READY',
            type: 'PRODUCTION',
            labels: { env: 'prod' }
        }]);
    });

    it('listInstances should return ERROR on exception', async () => {
        mockClient.getInstances.mockRejectedValue(new Error('fail'));
        const res = await metadataTool.listInstances('proj-1');
        expect(res.status).toBe('ERROR');
        expect(res.error_details).toContain('fail');
    });

    it('getInstanceInfo should return successfully', async () => {
        const mockInstance = {
            id: 'inst1',
            getMetadata: vi.fn().mockResolvedValue([{ displayName: 'Inst 1', state: 'READY', type: 'PRODUCTION', labels: { env: 'prod' } }])
        };
        mockClient.instance.mockReturnValue(mockInstance);
        const res = await metadataTool.getInstanceInfo('proj-1', 'inst1');
        expect(res.status).toBe('SUCCESS');
    });

    it('getInstanceInfo should return ERROR on exception', async () => {
        mockClient.instance.mockImplementation(() => { throw new Error('fail'); });
        const res = await metadataTool.getInstanceInfo('proj-1', 'inst1');
        expect(res.status).toBe('ERROR');
        expect(res.error_details).toContain('fail');
    });

    it('listTables should return successfully', async () => {
        const mockInstance = {
            getTables: vi.fn().mockResolvedValue([
                [{ id: 'table1', name: 'proj/inst1/table/table1' }]
            ])
        };
        mockClient.instance.mockReturnValue(mockInstance);
        const res = await metadataTool.listTables('proj-1', 'inst1');
        expect(res.status).toBe('SUCCESS');
    });

    it('listTables should return ERROR on exception', async () => {
        mockClient.instance.mockImplementation(() => { throw new Error('fail'); });
        const res = await metadataTool.listTables('proj-1', 'inst1');
        expect(res.status).toBe('ERROR');
    });

    it('getTableInfo should return successfully', async () => {
        const mockTable = {
            id: 'table1',
            getMetadata: vi.fn().mockResolvedValue([{
                columnFamilies: { fam1: {}, fam2: {} }
            }])
        };
        const mockInstance = {
            table: vi.fn().mockReturnValue(mockTable)
        };
        mockClient.instance.mockReturnValue(mockInstance);
        const res = await metadataTool.getTableInfo('proj-1', 'inst1', 'table1');
        expect(res.status).toBe('SUCCESS');
        expect(res.results.column_families).toEqual(['fam1', 'fam2']);
    });
    
    it('getTableInfo should return successfully with empty column families', async () => {
        const mockTable = {
            id: 'table1',
            getMetadata: vi.fn().mockResolvedValue([{
                columnFamilies: undefined
            }])
        };
        const mockInstance = {
            table: vi.fn().mockReturnValue(mockTable)
        };
        mockClient.instance.mockReturnValue(mockInstance);
        const res = await metadataTool.getTableInfo('proj-1', 'inst1', 'table1');
        expect(res.status).toBe('SUCCESS');
        expect(res.results.column_families).toEqual([]);
    });

    it('getTableInfo should return ERROR on exception', async () => {
        const mockInstance = {
            table: vi.fn().mockImplementation(() => { throw new Error('fail'); })
        };
        mockClient.instance.mockReturnValue(mockInstance);
        const res = await metadataTool.getTableInfo('proj-1', 'inst1', 'table1');
        expect(res.status).toBe('ERROR');
    });

    it('listClusters should return successfully', async () => {
        const mockInstance = {
            getClusters: vi.fn().mockResolvedValue([[
                { id: 'clust1', name: 'clus', metadata: { state: 'READY', serveNodes: 3, defaultStorageType: 'SSD', location: 'us-east1' } }
            ]])
        };
        mockClient.instance.mockReturnValue(mockInstance);
        const res = await metadataTool.listClusters('proj-1', 'inst1');
        expect(res.status).toBe('SUCCESS');
    });

    it('listClusters should return ERROR on exception', async () => {
         mockClient.instance.mockImplementation(() => { throw new Error('fail'); });
         const res = await metadataTool.listClusters('proj-1', 'inst1');
         expect(res.status).toBe('ERROR');
    });

    it('getClusterInfo should return successfully', async () => {
        const mockCluster = {
            id: 'clust1',
            getMetadata: vi.fn().mockResolvedValue([{
                 state: 'READY',
                 serveNodes: 3,
                 defaultStorageType: 'SSD',
                 location: 'loc',
                 clusterConfig: { clusterAutoscalingConfig: { autoscalingLimits: { minServeNodes: 1, maxServeNodes: 5 }, autoscalingTargets: { cpuUtilizationPercent: 50 } } }
            }])
        };
        const mockInstance = {
            cluster: vi.fn().mockReturnValue(mockCluster)
        };
        mockClient.instance.mockReturnValue(mockInstance);
        const res = await metadataTool.getClusterInfo('proj-1', 'inst1', 'clust1');
        expect(res.status).toBe('SUCCESS');
        expect(res.results.min_serve_nodes).toBe(1);
    });

    it('getClusterInfo should return ERROR on exception', async () => {
        mockClient.instance.mockImplementation(() => { throw new Error('fail'); });
        const res = await metadataTool.getClusterInfo('proj-1', 'inst1', 'clust1');
        expect(res.status).toBe('ERROR');
    });
});
