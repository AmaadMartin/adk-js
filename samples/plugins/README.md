# Plugin samples

Runnable TypeScript agents that show one ADK plugin each. Every directory
exports an `app` that the ADK CLI runs:

```bash
npm run build
npm run sample -- samples/plugins/<name>/agent.ts
```

These samples call a live model and live Google Cloud services, so CI does not
execute them. It type-checks them with the rest of `samples/`:

```bash
npm run ts:check:samples
```

See [Running](../workflows/README.md#running) for how `npm run sample`
works, and how to script a run.

## `auto_tracing`

Installs [`AutoTracingPlugin`](../../docs/guides/plugins/auto_tracing/index.md)
and prints every span to the console, so you can see one span per function the
agent reaches with its arguments and result attached.

Environment variables:

| Variable         | Required | Meaning                           |
| ---------------- | -------- | --------------------------------- |
| `GEMINI_API_KEY` | yes      | Key for the model the agent calls |

Ask about Paris. The console exporter prints a `lookupCity` span and, nested
under it, a `format` span, each carrying `adk.fn.*` attributes. The names are
bare because `cityFacts` is a plain object; a method on a class prototype is
named `Owner.method`.

## `bigquery_agent_analytics`

Writes one BigQuery row per lifecycle event of a weather agent. The plugin
creates the dataset and the table on first use, so the first run needs
permission to create both.

Install the optional peer dependencies:

```bash
npm install @google-cloud/bigquery @google-cloud/bigquery-storage
```

Environment variables:

| Variable                 | Required | Default           | Meaning                              |
| ------------------------ | -------- | ----------------- | ------------------------------------ |
| `GOOGLE_CLOUD_PROJECT`   | yes      | —                 | Project holding the dataset          |
| `GEMINI_API_KEY`         | yes      | —                 | Key for the model the agent calls    |
| `ADK_ANALYTICS_DATASET`  | no       | `agent_analytics` | Dataset the plugin writes to         |
| `ADK_ANALYTICS_TABLE`    | no       | `agent_events`    | Table the plugin writes to           |
| `ADK_ANALYTICS_LOCATION` | no       | `US`              | BigQuery location of the new dataset |

Two more variables turn on the Cloud Storage offload, which sends content too
large to inline to a bucket and records a `gs://` reference in the row.

| Variable                   | Required | Meaning                                          |
| -------------------------- | -------- | ------------------------------------------------ |
| `ADK_ANALYTICS_BUCKET`     | no       | Bucket receiving the offloaded content           |
| `ADK_ANALYTICS_CONNECTION` | no       | BigQuery connection, as `location.connection_id` |

The offload needs a second optional peer dependency and an existing bucket:

```bash
npm install @google-cloud/storage
gcloud storage buckets create "gs://$ADK_ANALYTICS_BUCKET"
```

Grants, on the project in `GOOGLE_CLOUD_PROJECT`:

```bash
gcloud projects add-iam-policy-binding "$GOOGLE_CLOUD_PROJECT" \
  --member="user:$(gcloud config get-value account)" \
  --role="roles/bigquery.dataEditor"
gcloud auth application-default login
```

`roles/bigquery.dataEditor` carries `bigquery.datasets.create`,
`bigquery.tables.create`, `bigquery.tables.update` and
`bigquery.tables.updateData`, which is everything the plugin needs. Reading the
rows back also needs `roles/bigquery.jobUser` to run the query. The offload
also needs `roles/storage.objectCreator` on the bucket.

Then run the agent, ask it for the weather in a city, and query the rows:

```sql
SELECT event_type, agent, status, timestamp
FROM `<project>.agent_analytics.agent_events`
ORDER BY timestamp;
```

## `debug_logging`

Records every invocation of a city agent to a YAML file in the system
temporary directory. The plugin writes the LLM requests and responses, the tool
calls and their results, the events, and the session state. It redacts
credentials, so you can attach the file to a bug report.

Environment variables:

| Variable         | Required | Default | Meaning                           |
| ---------------- | -------- | ------- | --------------------------------- |
| `GEMINI_API_KEY` | yes      | —       | Key for the model the agent calls |

Run the agent and ask it for the population of a city. The agent prints the
path of the file. Each turn appends another `---` document, so a
multi-document YAML loader reads the whole file.
