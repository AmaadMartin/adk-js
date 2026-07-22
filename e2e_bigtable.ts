import { listInstances } from './core/src/tools/bigtable/metadata_tool.js';
import { executeSql } from './core/src/tools/bigtable/query_tool.js';

async function main() {
    const projectId = 'cloud-ai-agentic-coding';
    try {
        console.log('Testing Bigtable metadata listing...');
        const instances = await listInstances(projectId);
        console.log('Instances result:', JSON.stringify(instances, null, 2));

        if (instances.status === 'SUCCESS' && instances.results && instances.results.length > 0) {
            const instanceId = instances.results[0].instance_id;
            console.log(`\nTesting SQL Execution on instance ${instanceId}...`);
            const sqlRes = await executeSql(projectId, instanceId, 'SELECT 1');
            console.log('Query result:', JSON.stringify(sqlRes, null, 2));
        }
    } catch (e: any) {
        console.error('Error during E2E test:', e.message);
    }
}

main();
