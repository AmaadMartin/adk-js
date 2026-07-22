export interface BigQueryCredentialsConfig {
  /**
   * The Google Cloud project ID.
   */
  projectId?: string;

  /**
   * Path to a service account key file.
   */
  keyFilename?: string;

  /**
   * Client credentials.
   */
  credentials?: {
    client_email?: string;
    private_key?: string;
  };
}
