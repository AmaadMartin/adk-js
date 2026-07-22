import {BigQueryToolConfig, WriteMode} from './bigquery_config.js';
import {BigQueryCredentialsConfig} from './bigquery_credentials.js';
import {getBigQueryClient} from './client.js';
import {Context} from '@google/adk';

const BIGQUERY_SESSION_INFO_KEY = 'bigquery_session_info';

export async function executeSql(
  projectId: string,
  query: string,
  credentialsConfig?: BigQueryCredentialsConfig,
  settings?: BigQueryToolConfig,
  toolContext?: Context,
  dryRun: boolean = false
): Promise<any> {
  try {
    if (settings?.computeProjectId && projectId !== settings.computeProjectId) {
      return {
        status: 'ERROR',
        error_details: `Cannot execute query in the project ${projectId}, as the tool is restricted to execute queries only in the project ${settings.computeProjectId}.`,
      };
    }

    const bqClient = getBigQueryClient(projectId, credentialsConfig, settings, 'execute_sql');

    const jobLabels: Record<string, string> = {...(settings?.jobLabels || {})};
    jobLabels['adk-bigquery-tool'] = 'execute_sql';
    if (settings?.applicationName) {
      jobLabels['adk-bigquery-application-name'] = settings.applicationName;
    }

    let bqSessionId: string | undefined;
    let bqSessionDatasetId: string | undefined;

    if ((settings?.writeMode ?? WriteMode.BLOCKED) === WriteMode.BLOCKED) {
      const [{metadata: dryRunJob}] = await bqClient.createQueryJob({
        query,
        dryRun: true,
        labels: jobLabels,
      });
      if (dryRunJob.statistics?.query?.statementType !== 'SELECT') {
        return {
          status: 'ERROR',
          error_details: 'Read-only mode only supports SELECT statements.',
        };
      }
    } else if (settings.writeMode === WriteMode.PROTECTED) {
      const sessionInfo = toolContext?.state?.get(BIGQUERY_SESSION_INFO_KEY) as [string, string] | undefined;
      if (sessionInfo && Array.isArray(sessionInfo)) {
        [bqSessionId, bqSessionDatasetId] = sessionInfo;
      } else {
        const [{metadata: sessionCreatorJob}] = await bqClient.createQueryJob({
          query: 'SELECT 1',
          dryRun: true,
          createSession: true,
          labels: jobLabels,
        });
        bqSessionId = sessionCreatorJob.statistics?.sessionInfo?.sessionId;
        bqSessionDatasetId = sessionCreatorJob.configuration?.query?.destinationTable?.datasetId;

        if (toolContext?.state && bqSessionId && bqSessionDatasetId) {
          toolContext.state.set(BIGQUERY_SESSION_INFO_KEY, [bqSessionId, bqSessionDatasetId]);
        }
      }

      const connectionProperties = bqSessionId ? [{key: 'session_id', value: bqSessionId}] : [];

      const [{metadata: dryRunJob}] = await bqClient.createQueryJob({
        query,
        dryRun: true,
        connectionProperties,
        labels: jobLabels,
      });

      const destDatasetId = dryRunJob.configuration?.query?.destinationTable?.datasetId;
      if (dryRunJob.statistics?.query?.statementType !== 'SELECT' && destDatasetId !== bqSessionDatasetId) {
        return {
          status: 'ERROR',
          error_details: 'Protected write mode only supports SELECT statements, or write operations in the anonymous dataset of a BigQuery session.',
        };
      }
    }

    const connectionProperties = bqSessionId ? [{key: 'session_id', value: bqSessionId}] : [];

    if (dryRun) {
      const [{metadata: dryRunJob}] = await bqClient.createQueryJob({
        query,
        dryRun: true,
        connectionProperties,
        labels: jobLabels,
      });
      return {status: 'SUCCESS', dry_run_info: dryRunJob};
    }

    const queryOptions: any = {
      query,
      connectionProperties,
      labels: jobLabels,
    };
    if (settings?.maximumBytesBilled) {
      queryOptions.maximumBytesBilled = settings.maximumBytesBilled;
    }

    const [rows] = await bqClient.query(queryOptions);

    // BQ Client in Node.js processes rows differently, mapping them to objects immediately.
    // Ensure all values are correctly serialized to strings if unsupported by target JSON standard
    const processedRows = rows.map((row: any) => {
      const out: any = {};
      for (const [k, v] of Object.entries(row)) {
        if (v && typeof v === 'object' && 'value' in v) { // some native types (like BigQuery Date/Time) wrap their values
           out[k] = (v as any).value;
        } else {
           out[k] = v;
        }
      }
      return out;
    });

    const result: any = {status: 'SUCCESS', rows: processedRows};
    
    // Note: Node BigQuery client maxResults handling natively can be complex; we can just rely on standard limit if needed.
    // If settings.maxQueryResultRows is set, we can slice it for simplicity, since BQ node client might fetch all pages implicitly without manual stream limits.
    if (settings?.maxQueryResultRows && rows.length >= settings.maxQueryResultRows) {
      result.rows = processedRows.slice(0, settings.maxQueryResultRows);
      result.result_is_likely_truncated = true;
    }

    return result;
  } catch (error) {
    return {
      status: 'ERROR',
      error_details: error instanceof Error ? error.message : String(error),
    };
  }
}
