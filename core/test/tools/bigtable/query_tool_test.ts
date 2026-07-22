import {describe, it, expect, vi, beforeEach} from 'vitest';
import * as queryTool from '../../../src/tools/bigtable/query_tool.js';
import {Bigtable} from '@google-cloud/bigtable';

vi.mock('@google-cloud/bigtable');

describe('Bigtable Query Tool', () => {
    let mockClient: any;
    
    beforeEach(() => {
        vi.clearAllMocks();
        mockClient = {
            instance: vi.fn(),
        };
        (Bigtable as any).mockImplementation(() => mockClient);
    });

    it('executeSql should stream rows', async () => {
        const mockStream = (async function* () {
            yield { name: 'Alice', age: 30 };
            yield new Map([['name', 'Bob'], ['age', 40]]);
        })();
        const mockInstance = {
            createExecuteQueryStream: vi.fn().mockReturnValue(mockStream)
        };
        mockClient.instance.mockReturnValue(mockInstance);

        const res = await queryTool.executeSql('proj', 'inst', 'SELECT *', undefined, {maxQueryResultRows: 50}, {p1: 'v1'}, {p1: 's'}, {v1: 'view'});
        
        expect(res.status).toBe('SUCCESS');
        expect(res.rows).toEqual([{name: 'Alice', age: 30}, {name: 'Bob', age: 40}]);
        expect(mockInstance.createExecuteQueryStream).toHaveBeenCalledWith({
             query: 'SELECT *', params: {p1: 'v1'}, parameterTypes: {p1: 's'}, viewParameters: {v1: 'view'}
        });
    });

    it('executeSql should handle un-stringifiable values', async () => {
        const unstringifiable: any = {};
        unstringifiable.circular = unstringifiable;

        const mockStream = (async function* () {
            yield { nested: unstringifiable };
        })();
        const mockInstance = {
            createExecuteQueryStream: vi.fn().mockReturnValue(mockStream)
        };
        mockClient.instance.mockReturnValue(mockInstance);

        const res = await queryTool.executeSql('proj', 'inst', 'SELECT *');
        
        expect(res.status).toBe('SUCCESS');
        expect(res.rows[0].nested).toContain('[object Object]');
    });

    it('executeSql should truncate gracefully', async () => {
        const mockStream = (async function* () {
            yield { id: 1 };
            yield { id: 2 };
            yield { id: 3 };
        })();
        const mockInstance = {
            createExecuteQueryStream: vi.fn().mockReturnValue(mockStream)
        };
        mockClient.instance.mockReturnValue(mockInstance);

        // testing with defaults internally overriding if settings undefined
        const res = await queryTool.executeSql('proj', 'inst', 'SELECT *', undefined, {maxQueryResultRows: 2});
        
        expect(res.status).toBe('SUCCESS');
        expect(res.rows.length).toBe(2);
        expect(res.result_is_likely_truncated).toBe(true);
    });

    it('executeSql should return ERROR on exception', async () => {
        const mockInstance = {
            createExecuteQueryStream: vi.fn().mockImplementation(() => { throw new Error('fail'); })
        };
        mockClient.instance.mockReturnValue(mockInstance);

        const res = await queryTool.executeSql('proj', 'inst', 'SELECT *');
        expect(res.status).toBe('ERROR');
        expect(res.error_details).toContain('fail');
    });
});
