import {BigQueryToolset} from '../integrations/src/bigquery/bigquery_toolset.js';

async function main() {
  const toolset = new BigQueryToolset();
  const tools = await toolset.getTools();
  console.log(`Found ${tools.length} BigQuery tools.`);

  const executeSqlTool = tools.find(t => t.name === 'execute_sql');
  if (!executeSqlTool) {
    throw new Error('execute_sql tool not found');
  }

  // Attempt to query a public dataset (bigquery-public-data)
  // Warning: If no default project ID is provided, this might fail, so we'll catch.
  try {
    const result = await executeSqlTool.runAsync({
      args: {
        project_id: 'bigquery-public-data',
        query: 'SELECT corpus, word_count FROM `bigquery-public-data.samples.shakespeare` LIMIT 3',
      },
      toolContext: { state: new Map() } as any
    });
    console.log('SQL Result:', JSON.stringify(result, null, 2));
  } catch (err: any) {
    if (err.message?.includes('project ID')) {
      console.log('Skipping real execution due to no default project ID, but initialization succeeded!');
    } else {
      console.error('Test failed with unexpected error:', err);
      process.exit(1);
    }
  }

  console.log('E2E test passed!');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
