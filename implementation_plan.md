## Task

### User intent with respect to ADK
Enable developers to interact with Google Cloud BigQuery by introducing a native `BigQueryToolset` implementation in `adk-js`. This will allow LLMs and agent developers to query datasets, get dataset info, and perform BigQuery operations in TypeScript/JavaScript natively using Google's Node.js GCP client libraries.

### Feature Description
Implementation of the `BigQueryToolset` and its associated tools inside `adk-js/integrations/bigquery`. This replicates the feature parity of `adk-python`'s `src/google/adk/integrations/bigquery/bigquery_toolset.py` while adhering to Node.js `BaseToolset` conventions.

### Use Cases & Examples
- Asking an AI agent to lists datasets and table info within a specific GCP project.
- Asking an AI agent to execute SQL queries and retrieve results.
- End-user configures the `BigQueryToolset` with their credentials via the agent initialization.

## Context

### ADK Context
- Reference context: `adk-python` has `BigQueryToolset` located in `src/google/adk/integrations/bigquery/bigquery_toolset.py`. It implements several GoogleTools including metadata tools (get_dataset_info, list_dataset_ids, get_table_info, list_table_ids, get_job_info), querying (execute_sql, forecast, analyze_contribution, detect_anomalies), and data insights.
- General context: The tools should be built using `@google-cloud/bigquery` Node.js client.

### Language Specific Context
- Target language: TypeScript (Node.js)
- Target repo: `adk-js` 
- General context: The toolset should extend `BaseToolset` from `adk-js/core/src/tools/base_toolset.ts`.

## Definition

### Data Models
- Data models mapping BigQuery settings (e.g. `BigQueryToolConfig`, `BigQueryCredentialsConfig`).

### Inputs
- Credentials config
- Tool configs (optional filtering)
- Agent context (`ReadonlyContext`)

### Outputs
- List of `BaseTool` equivalents.
- Standard JSON serialized results from BigQuery querying responses.

### Side Effects
- Uses `@google-cloud/bigquery` to make network requests to GCP APIs.

## Constraints

### Invariants
- Methods should remain purely functional or read-heavy wrappers where appropriate.
- Follow TypeScript typing standards strictly.

### Preconditions
- GCP Project + Credentials are appropriately setup by the developer using the toolset. 

### Postconditions
- Results correctly returned. 
- Avoid resource leaks by implementing `close()` methods properly.

### Error Handling Protocols
- Surface GCP errors (e.g., PERMISSION_DENIED) back iteratively through ADK's error normalization structure for LLM understanding.

### Breaking Change Analysis
- Safe addition to the `integrations/bigquery` directory. No breaking changes to `core`.

### Testing

- #### Unit tests with >=95% New Line Coverage
  - Explicit mocking of `@google-cloud/bigquery`.
  - Validate filter logic and configurations.

- #### Integration tests
  - If feasible inside standard infrastructure, though pure structural tests should suffice.

- #### Manual e2e test
  - Initialize the agent in `adk-js/dev` and execute a SQL query on a public dataset.
