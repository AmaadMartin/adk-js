import {BigQuery, BigQueryOptions} from '@google-cloud/bigquery';
import {BigQueryToolConfig} from './bigquery_config.js';
import {BigQueryCredentialsConfig} from './bigquery_credentials.js';

export function getBigQueryClient(
  project?: string,
  credentialsConfig?: BigQueryCredentialsConfig,
  settings?: BigQueryToolConfig,
  callerName?: string
): BigQuery {
  const options: BigQueryOptions = {
    projectId: project || credentialsConfig?.projectId,
    keyFilename: credentialsConfig?.keyFilename,
    credentials: credentialsConfig?.credentials,
  };

  if (settings?.location) {
    options.location = settings.location;
  }

  // user agent setting is not directly supported via standard BigQuery constructor options in the same way as Python, 
  // but we can augment the headers if needed by interceptor, or just rely on default setup. 
  // Let's omit user_agent manual injection for simplicity unless specifically required.
  return new BigQuery(options);
}
