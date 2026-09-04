# Plugin samples

Runnable TypeScript agents that show one ADK plugin each. Every directory
exports an `app` that the ADK CLI runs:

```bash
npm run build
npm run sample -- samples/plugins/<name>/agent.ts
```

These samples call live Google Cloud services, so CI does not execute them. It
type-checks them with the rest of `samples/`:

```bash
npm run ts:check:samples
```

## `bigquery_agent_analytics`

Writes one BigQuery row per lifecycle event of a weather agent. The plugin
creates the dataset and the table on first use, so the first run needs
permission to create both.

Install the optional peer dependency:

```bash
npm install @google-cloud/bigquery
```

Environment variables:

| Variable                 | Required | Default           | Meaning                              |
| ------------------------ | -------- | ----------------- | ------------------------------------ |
| `GOOGLE_CLOUD_PROJECT`   | yes      | —                 | Project holding the dataset          |
| `GEMINI_API_KEY`         | yes      | —                 | Key for the model the agent calls    |
| `ADK_ANALYTICS_DATASET`  | no       | `agent_analytics` | Dataset the plugin writes to         |
| `ADK_ANALYTICS_TABLE`    | no       | `agent_events`    | Table the plugin writes to           |
| `ADK_ANALYTICS_LOCATION` | no       | `US`              | BigQuery location of the new dataset |

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
rows back also needs `roles/bigquery.jobUser` to run the query.

Then run the agent, ask it for the weather in a city, and query the rows:

```sql
SELECT event_type, agent, status, timestamp
FROM `<project>.agent_analytics.agent_events`
ORDER BY timestamp;
```
