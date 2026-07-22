import {describe, it, expect, vi} from 'vitest';
import {BigtableToolset} from '../../../src/tools/bigtable/bigtable_toolset.js';
import * as queryTool from '../../../src/tools/bigtable/query_tool.js';

vi.mock('../../../src/tools/bigtable/query_tool.js');

describe('BigtableToolset', () => {
    it('returns standard tools', async () => {
        const toolset = new BigtableToolset();
        const tools = await toolset.getTools();
        expect(tools.length).toBe(7);
        expect(tools.map(t => t.name)).toContain('execute_sql');
    });

    it('returns parameterized tool if viewParameterNames provided', async () => {
        const toolset = new BigtableToolset({ viewParameterNames: ['user_id'] });
        const tools = await toolset.getTools();
        expect(tools.length).toBe(8);
        expect(tools.map(t => t.name)).toContain('execute_sql_parameterized');
    });

    it('parameterized tool securely resolves parameters', async () => {
        const toolset = new BigtableToolset({ viewParameterNames: ['user_id', 'state_id'] });
        const tools = await toolset.getTools();
        const parameterized = tools.find(t => t.name === 'execute_sql_parameterized') as any;
        
        vi.mocked(queryTool.executeSql).mockResolvedValue({status: 'SUCCESS', rows: []});
        
        const mockToolContext: any = {
           user_id: 'alice123',
           state: { state_id: 'CA' }
        };

        const args = { projectId: 'p', instanceId: 'i', query: 'Q', _viewParameters: { extra: 1 } };
        
        await parameterized!.execute(args, mockToolContext);
        
        expect(queryTool.executeSql).toHaveBeenCalledWith(
           'p', 'i', 'Q', undefined, undefined, undefined, undefined, { extra: 1, user_id: 'alice123', state_id: 'CA' }
        );
    });

    it('parameterized tool handles missing parameters', async () => {
        const toolset = new BigtableToolset({ viewParameterNames: ['user_id'] });
        const tools = await toolset.getTools();
        const parameterized = tools.find(t => t.name === 'execute_sql_parameterized') as any;
        
        vi.mocked(queryTool.executeSql).mockResolvedValue({status: 'SUCCESS', rows: []});
        
        const args = { projectId: 'p', instanceId: 'i', query: 'Q' };
        
        await parameterized!.execute(args, undefined);
        
        expect(queryTool.executeSql).toHaveBeenCalledWith(
           'p', 'i', 'Q', undefined, undefined, undefined, undefined, undefined
        );
    });
    
    it('applies filters', async () => {
        const toolset = new BigtableToolset({ toolFilter: ['execute_sql'] });
        const tools = await toolset.getTools();
        expect(tools.length).toBe(1);
    });

    it('execute_sql tool securely invokes queryTool.executeSql', async () => {
        const toolset = new BigtableToolset();
        const tools = await toolset.getTools();
        const tool = tools.find(t => t.name === 'execute_sql') as any;
        
        vi.mocked(queryTool.executeSql).mockResolvedValue({status: 'SUCCESS', rows: []});
        
        await tool.execute({projectId: 'p', instanceId: 'i', query: 'Q'});
        expect(queryTool.executeSql).toHaveBeenCalled();
    });

    it('closes gracefully', async () => {
        const toolset = new BigtableToolset();
        await expect(toolset.close()).resolves.not.toThrow();
    });
});
