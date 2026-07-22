export enum WriteMode {
  /*
   * Indicates that no data manipulation is allowed. Only SELECT queries are
   * permitted. This is the safest mode and default behavior.
   */
  BLOCKED = 'BLOCKED',
  /*
   * Allows write operations only within the bounds of a temporary artifact
   * generated specifically for the session, e.g. temporary BigQuery dataset.
   * This mode encapsulates changes to avoid modifying existing data.
   */
  PROTECTED = 'PROTECTED',
  /*
   * Grants full permission to perform any data manipulation operations.
   * Use this mode with caution, as it allows arbitrary changes to any dataset
   * the credentials have access to.
   */
  ALLOWED = 'ALLOWED',
}

export interface BigQueryToolConfig {
  /**
   * Represents the BigQuery location. See
   * https://cloud.google.com/bigquery/docs/locations for more information.
   * If not provided, it will use the default location.
   */
  location?: string;

  /**
   * Google Cloud project ID to use when charging operations and queries.
   * If not provided, it will be inferred from the credentials configuration.
   */
  computeProjectId?: string;

  /**
   * Dictates the permissions for queries that write or manipulate data.
   */
  writeMode?: WriteMode;

  /**
   * Application name to attach to API requests.
   */
  applicationName?: string;

  /**
   * The maximum number of rows to return in the query result.
   */
  maxQueryResultRows?: number;

  /**
   * Labels to apply to BigQuery jobs.
   */
  jobLabels?: Record<string, string>;

  /**
   * Maximum bytes billed for query jobs.
   */
  maximumBytesBilled?: number;
}
