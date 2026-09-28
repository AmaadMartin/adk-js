/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Verbatim contents of the bigquery-ai-ml SKILL.md, frontmatter included.
 *
 * Vendored from adk-python's
 * `src/google/adk/tools/bigquery/skills/bigquery-ai-ml/`. The markdown is
 * embedded rather than read from disk so the published package carries it: the
 * build compiles only TypeScript, so a sibling `.md` never reaches `dist`.
 */
export const BIGQUERY_AI_ML_SKILL_MD = `---
name: bigquery-ai-ml
license: Apache-2.0
metadata:
  author: google-adk
  version: "1.0"
description: |
  Skill for BigQuery AI and Machine Learning queries using standard SQL
  and \`AI.*\` functions (preferred over dedicated tools).

---

# Skill: bigquery-ai-ml

This skill defines the usage and rules for BigQuery AI/ML functions,
preferring SQL-based Skills over dedicated BigQuery tools.

## 1. Skill vs Tool Preference (BigQuery AI/ML)

Agents should **prefer using the Skill (SQL via \`execute_sql()\`)** over
dedicated BigQuery tools for functionalities like Forecasting and Anomaly
Detection.

Use \`execute_sql()\` with the standard BigQuery \`AI.*\` functions for these tasks
instead of the corresponding high-level tools.

## 2. Mandatory Reference Routing

This skill file does not contain the syntax for these functions. You **MUST**
read the associated reference file before generating SQL.

**CRITICAL**: DO NOT GUESS filenames. You MUST only use the exact paths
provided below.

| Function | Description | Required Reference File to Retrieve |
| :--- | :--- | :--- |
| **AI.FORECAST** | Time-series forecasting via the pre-trained TimesFM model | \`references/bigquery_ai_forecast.md\` |
| **AI.CLASSIFY** | Categorize unstructured data into predefined labels | \`references/bigquery_ai_classify.md\` |
| **AI.DETECT_ANOMALIES** | Identify deviations in time-series data via the pre-trained TimesFM model | \`references/bigquery_ai_detect_anomalies.md\` |
| **AI.GENERATE** | General-purpose text and content generation | \`references/bigquery_ai_generate.md\` |
| **AI.GENERATE_BOOL** | Generate a boolean value (TRUE/FALSE) based on a prompt | \`references/bigquery_ai_generate_bool.md\` |
| **AI.GENERATE_DOUBLE** | Generate a floating-point number based on a prompt | \`references/bigquery_ai_generate_double.md\` |
| **AI.GENERATE_INT** | Generate an integer value based on a prompt | \`references/bigquery_ai_generate_int.md\` |
| **AI.IF** | Evaluate a natural-language boolean condition | \`references/bigquery_ai_if.md\` |
| **AI.SCORE** | Rank items by semantic relevance (use with ORDER BY) | \`references/bigquery_ai_score.md\` |
| **AI.SIMILARITY** | Compute cosine similarity between two inputs | \`references/bigquery_ai_similarity.md\` |
| **AI.SEARCH** | Semantic search on tables with autonomous embedding generation | \`references/bigquery_ai_search.md\` |
`;

/**
 * Verbatim contents of the bigquery-ai-ml `references/` directory, keyed by
 * bare filename. The keys carry no `references/` prefix, because
 * `LoadSkillResourceTool` strips that prefix before it looks a resource up.
 */
export const BIGQUERY_AI_ML_REFERENCES: Record<string, string> = {
  'bigquery_ai_classify.md': `# BigQuery AI.Classify

\`AI.CLASSIFY\` categorizes unstructured data into a predefined set of labels.

## Syntax Reference

\`\`\`sql
AI.CLASSIFY(
  [ input => ] 'INPUT',
  [ categories => ] 'CATEGORIES'
  [, connection_id => 'CONNECTION_ID' ]
  [, endpoint => 'ENDPOINT' ]
  [, output_mode => 'OUTPUT_MODE' ]
)
\`\`\`

### Input Arguments

| Argument            | Requirement  | Type          | Description           |
| :------------------ | :----------- | :------------ | :-------------------- |
| **\`input\`**         | **Required** | String        | The text content to   |
:                     :              :               : classify.             :
| **\`categories\`**    | **Required** | Array<String> | A list of target      |
:                     :              :               : categories/labels.    :
:                     :              :               : Can be                :
:                     :              :               : \`ARRAY<STRING>\` or    :
:                     :              :               : \`ARRAY<STRUCT<STRING, :
:                     :              :               : STRING>>\` (label,     :
:                     :              :               : description).         :
| **\`connection_id\`** | Optional     | String        | The connection ID to  |
:                     :              :               : use for the LLM.      :
| **\`endpoint\`**      | Optional     | String        | The model name, e.g., |
:                     :              :               : \`'gemini-2.5-flash'\`. :
| **\`output_mode\`**   | Optional     | String        | \`'single'\` (default)  |
:                     :              :               : or \`'multi'\`.         :
:                     :              :               : Determines the output :
:                     :              :               : type.                 :

### Output Schema

The output type depends on the \`output_mode\` argument:

| Output Mode      | output_mode Value | Type            | Description         |
| :--------------- | :---------------- | :-------------- | :------------------ |
| **Single Label** | \`NULL\` (Default)  | \`STRING\`        | The single category |
:                  :                   :                 : that best fits the  :
:                  :                   :                 : input.              :
| **Single Label   | \`'single'\`        | \`ARRAY<STRING>\` | An array containing |
: (Explicit)**     :                   :                 : exactly one         :
:                  :                   :                 : category string.    :
| **Multi Label**  | \`'multi'\`         | \`ARRAY<STRING>\` | An array containing |
:                  :                   :                 : zero or more        :
:                  :                   :                 : matching            :
:                  :                   :                 : categories.         :

## Examples

### Classify text into categories

\`\`\`sql
SELECT
  content,
  AI.CLASSIFY(
    content,
    categories => ['Spam', 'Not Spam', 'Urgent'],
    connection_id => 'my-project.us.my-connection'
  ) as classification
FROM \`dataset.emails\`;
\`\`\`

### Classify text into multiple topics

\`\`\`
SELECT
  title,
  body,
  AI.CLASSIFY(
    body,
    categories => ['tech', 'sport', 'business', 'politics', 'entertainment', 'other'],
    output_mode => 'multi') AS categories
FROM
  \`bigquery-public-data.bbc_news.fulltext\`
LIMIT 100;
\`\`\`

### Classify reviews by sentiment

SELECT AI.CLASSIFY( ('Classify the review by sentiment: ', review), categories
=> [('green', 'The review is positive.'), ('yellow', 'The review is neutral.'),
('red', 'The review is negative.')]) AS ai_review_rating, reviewer_rating AS
human_provided_rating, review, FROM \`bigquery-public-data.imdb.reviews\` WHERE
title = 'The English Patient'
`,
  'bigquery_ai_detect_anomalies.md': `# BigQuery AI.Detect_Anomalies

\`AI.DETECT_ANOMALIES\` uses the pre-trained **TimesFM** model to identify
deviations in time series data without needing to train a custom model.

## Syntax Reference

This function compares a target dataset against a historical dataset to identify
anomalies.

\`\`\`sql
SELECT *
FROM AI.DETECT_ANOMALIES(
  { TABLE \`project.dataset.history_table\` | (SELECT * FROM history_query) },
  { TABLE \`project.dataset.target_table\` | (SELECT * FROM target_query) },
  data_col => 'DATA_COL',
  timestamp_col => 'TIMESTAMP_COL'
  [, model => 'MODEL']
  [, id_cols => ID_COLS]
  [, anomaly_prob_threshold => ANOMALY_PROB_THRESHOLD]
)

\`\`\`

### Input Arguments

Argument                     | Requirement  | Type          | Description
:--------------------------- | :----------- | :------------ | :----------
**\`historical_data\`**        | **Required** | Table/Query   | The source table or subquery containing historical data for training context.
**\`target_data\`**            | **Required** | Table/Query   | The source table or subquery containing data to analyze for anomalies.
**\`data_col\`**               | **Required** | String        | The numeric column to analyze.
**\`timestamp_col\`**          | **Required** | String        | The column containing dates/timestamps.
**\`id_cols\`**                | Optional     | Array<String> | Grouping columns for multiple series (e.g., \`['store_id']\`).
**\`anomaly_prob_threshold\`** | Optional     | Float64       | Threshold for anomaly detection (0 to 1). Defaults to 0.95.
**\`model\`**                  | Optional     | String        | Model version. Defaults to \`'TimesFM 2.0'\`.

### Output Schema

| Column                           | Type       | Description                  |
| :------------------------------- | :--------- | :--------------------------- |
| **\`id_cols\`**                    | (As Input) | Original identifiers for the |
:                                  :            : series.                      :
| **\`time_series_timestamp\`**      | TIMESTAMP  | Timestamp for the analyzed   |
:                                  :            : points.                      :
| **\`time_series_data\`**           | FLOAT64    | The original data value.     |
| **\`is_anomaly\`**                 | BOOL       | TRUE if the point is         |
:                                  :            : identified as an anomaly.    :
| **\`lower_bound\`**                | FLOAT64    | Lower bound of the expected  |
:                                  :            : range.                       :
| **\`upper_bound\`**                | FLOAT64    | Upper bound of the expected  |
:                                  :            : range.                       :
| **\`anomaly_probability\`**        | FLOAT64    | Probability that the point   |
:                                  :            : is an anomaly.               :
| **\`ai_detect_anomalies_status\`** | STRING     | Error messages or empty      |
:                                  :            : string on success. A minimum :
:                                  :            : of 3 data points is          :
:                                  :            : required.                    :

## Examples

### Basic Anomaly Detection

Detect anomalies in daily bike trips for a specific 2-month window based on
prior history.

\`\`\`sql
WITH bike_trips AS (
  SELECT EXTRACT(DATE FROM starttime) AS date, COUNT(*) AS num_trips
  FROM \`bigquery-public-data.new_york.citibike_trips\`
  GROUP BY date
)
SELECT *
FROM AI.DETECT_ANOMALIES(
  -- Historical context (Training data equivalent)
  (SELECT * FROM bike_trips WHERE date <= DATE('2016-06-30')),
  -- Target range (Data to inspect for anomalies)
  (SELECT * FROM bike_trips WHERE date BETWEEN '2016-07-01' AND '2016-09-01'),
  data_col => 'num_trips',
  timestamp_col => 'date'
);

\`\`\`

### Multivariate Detection (Multiple Series)

Use \`id_cols\` to detect anomalies separately for different user types (e.g.,
Subscriber vs. Customer) in the same query.

\`\`\`sql
WITH bike_trips AS (
    SELECT
      EXTRACT(DATE FROM starttime) AS date, usertype, gender,
      COUNT(*) AS num_trips
    FROM \`bigquery-public-data.new_york.citibike_trips\`
    GROUP BY date, usertype, gender
  )
SELECT *
FROM
  AI.DETECT_ANOMALIES(
    # Historical data from a query
    (SELECT * FROM bike_trips WHERE date <= DATE('2016-06-30')),
    # Target data from a query
    (SELECT * FROM bike_trips WHERE date BETWEEN '2016-07-01' AND '2016-09-01'),
    data_col => 'num_trips',
    timestamp_col => 'date',
    id_cols => ['usertype', 'gender'],
    model => "TimesFM 2.5",
    anomaly_prob_threshold => 0.8);

\`\`\`
`,
  'bigquery_ai_forecast.md': `# BigQuery AI.Forecast

\`AI.FORECAST\` leverages the pre-trained **TimesFM** foundation model to generate
forecasts without the need to train and manage custom models.

## Syntax Reference

\`\`\`sql
SELECT
  *
FROM
  AI.FORECAST(
    { TABLE \`project.dataset.table\` | (QUERY_STATEMENT) },
    data_col => 'DATA_COL',
    timestamp_col => 'TIMESTAMP_COL'
    [, model => 'MODEL']
    [, id_cols => ID_COLS]
    [, horizon => HORIZON]
    [, confidence_level => CONFIDENCE_LEVEL]
    [, output_historical_time_series => OUTPUT_HISTORICAL_TIME_SERIES]
    [, context_window => CONTEXT_WINDOW]
  )
\`\`\`

### Input Arguments

| Argument               | Requirement  | Type          | Description       |
| :--------------------- | :----------- | :------------ | :---------------- |
| **\`input_data\`**       | **Required** |               | The source table  |
:                        :              :               : or subquery       :
:                        :              :               : containing        :
:                        :              :               : historical data.  :
| **\`data_col\`**         | **Required** | String        | The numeric       |
:                        :              :               : column to         :
:                        :              :               : predict.          :
| **\`timestamp_col\`**    | **Required** | String        | The column        |
:                        :              :               : containing        :
:                        :              :               : dates/timestamps. :
| **\`id_cols\`**          | Optional     | Array<String> | Grouping columns  |
:                        :              :               : for multiple      :
:                        :              :               : series (e.g.,     :
:                        :              :               : \`['store_id']\`).  :
| **\`horizon\`**          | Optional     | Int64         | Number of future  |
:                        :              :               : points to         :
:                        :              :               : predict. Defaults :
:                        :              :               : to 10. The valid  :
:                        :              :               : input range is    :
:                        :              :               : [1, 10,000]       :
| **\`confidence_level\`** | Optional     | Float64       | Confidence        |
:                        :              :               : interval (0 to    :
:                        :              :               : 1). Defaults to   :
:                        :              :               : 0.95.             :
| **\`model\`**            | Optional     | String        | Model version.    |
:                        :              :               : Defaults to       :
:                        :              :               : \`'TimesFM 2.0'\`.  :
| **\`context_window\`**   | Optional     | Int64         | The number of     |
:                        :              :               : historical data   :
:                        :              :               : points the model  :
:                        :              :               : uses to forecast. :
:                        :              :               : The min value is  :
:                        :              :               : 64 and the max    :
:                        :              :               : value is 2048 for :
:                        :              :               : \`'TimesFM 2.0'\`.  :
:                        :              :               : If not set, the   :
:                        :              :               : model determines  :
:                        :              :               : this              :
:                        :              :               : automatically.    :

### Output Schema

The schema adjusts based on the \`output_historical_time_series\` flag.

Column                                | Type       | Included if output_historical_time_series=FALSE | Included if output_historical_time_series=TRUE | Description
:------------------------------------ | :--------- | :---------------------------------------------- | :--------------------------------------------- | :----------
**\`id_cols\`**                         | (As Input) | Yes                                             | Yes                                            | Original identifiers for the series.
**\`forecast_timestamp\`**              | TIMESTAMP  | **Yes**                                         | No                                             | Timestamp for predicted points.
**\`forecast_value\`**                  | FLOAT64    | **Yes**                                         | No                                             | The 50% quantile (median) prediction.
**\`time_series_timestamp\`**           | TIMESTAMP  | No                                              | **Yes**                                        | Uniform timestamp column for both history and forecast.
**\`time_series_data\`**                | FLOAT64    | No                                              | **Yes**                                        | Merged column: actual values for history, median for forecast.
**\`time_series_type\`**                | STRING     | No                                              | **Yes**                                        | Label: \`'history'\` or \`'forecast'\`.
**\`prediction_interval_lower_bound\`** | FLOAT64    | Yes                                             | Yes                                            | Lower bound (NULL for historical rows).
**\`prediction_interval_upper_bound\`** | FLOAT64    | Yes                                             | Yes                                            | Upper bound (NULL for historical rows).
**\`confidence_level\`**                | FLOAT64    | Yes                                             | Yes                                            | The constant confidence level used.
**\`ai_forecast_status\`**              | STRING     | Yes                                             | Yes                                            | Error messages or empty string on success. A minimum of 3 data points is required.

## Examples

### Forecasting with History

\`\`\`sql
WITH
  citibike_trips AS (
    SELECT EXTRACT(DATE FROM starttime) AS date, usertype, COUNT(*) AS num_trips
    FROM \`bigquery-public-data.new_york.citibike_trips\`
    GROUP BY date, usertype
  )
SELECT *
FROM
  AI.FORECAST(
    TABLE citibike_trips,
    data_col => 'num_trips',
    timestamp_col => 'date',
    id_cols => ['usertype'],
    horizon => 30,
    output_historical_time_series => true);
\`\`\`
`,
  'bigquery_ai_generate.md': `# BigQuery AI.Generate

\`AI.GENERATE\` is a general-purpose function text and content generation.

## Syntax Reference

\`\`\`sql
AI.GENERATE(
  [ prompt => ] 'PROMPT',
  [, endpoint => 'ENDPOINT']
  [, model_params => 'MODEL_PARAMS']
  [, output_schema => 'OUTPUT_SCHEMA']
  [, connection_id => 'CONNECTION_ID']
  [, request_type => 'REQUEST_TYPE']
)
\`\`\`

### Input Arguments

| Argument            | Requirement  | Type   | Description           |
| :------------------ | :----------- | :----- | :-------------------- |
| **\`prompt\`**        | **Required** | String | The prompt text or    |
:                     :              :        : instruction for the   :
:                     :              :        : model.                :
| **\`connection_id\`** | Optional     | String | The connection ID.    |
:                     :              :        : Optional if           :
:                     :              :        : configured via other  :
:                     :              :        : means or testing.     :
| **\`endpoint\`**      | Optional     | String | The model name, e.g., |
:                     :              :        : \`'gemini-2.5-flash'\`. :
| **\`output_schema\`** | Optional     | String | Schema definition for |
:                     :              :        : structured output,    :
:                     :              :        : e.g., \`'answer BOOL,  :
:                     :              :        : reason STRING'\`.      :
| **\`request_type\`**  | Optional     | String | \`'DEDICATED'\` or      |
:                     :              :        : \`'SHARED'\`.           :
| **\`model_params\`**  | Optional     | JSON   | JSON object for model |
:                     :              :        : parameters (e.g.,     :
:                     :              :        : \`temperature\`,        :
:                     :              :        : \`max_output_tokens\`). :

### Output Schema

Returns a \`STRUCT\` with the following fields:

| Column Name         | Type                 | Description                    |
| :------------------ | :------------------- | :----------------------------- |
| **\`result\`**        | \`STRING\` (or Custom) | The generated content. If      |
:                     :                      : \`output_schema\` is used, this  :
:                     :                      : field is replaced by the       :
:                     :                      : schema's fields.               :
| **\`status\`**        | \`STRING\`             | API response status (empty on  |
:                     :                      : success).                      :
| **\`full_response\`** | \`JSON\`               | The complete raw JSON response |
:                     :                      : from the model (including      :
:                     :                      : safety ratings, usage          :
:                     :                      : metadata).                     :

## Examples

### Basic Text Generation

\`\`\`sql
SELECT
  AI.GENERATE(
    'Summarize this article: ' || article_content,
    connection_id => 'my-project.us.my-connection',
    endpoint => 'gemini-2.5-flash'
  ) as summary
FROM \`dataset.articles\`
LIMIT 5;
\`\`\`

### Structured Output Generation

\`\`\`sql
SELECT
  AI.GENERATE(
    'Extract the date and amount from this invoice: ' || invoice_text,
    output_schema => 'date DATE, amount FLOAT64'
  ) as extracted_data
FROM \`dataset.invoices\`;
\`\`\`

### Process images in a Cloud Storage bucket

\`\`\`
CREATE SCHEMA IF NOT EXISTS bqml_tutorial;

CREATE OR REPLACE EXTERNAL TABLE bqml_tutorial.product_images
  WITH CONNECTION DEFAULT OPTIONS (
    object_metadata = 'SIMPLE',
    uris = ['gs://cloud-samples-data/bigquery/tutorials/cymbal-pets/images/*.png']);

SELECT
  uri,
  STRING(OBJ.GET_ACCESS_URL(ref,'r').access_urls.read_url) AS signed_url,
  AI.GENERATE(
    ("What is this: ", OBJ.GET_ACCESS_URL(ref, 'r')),
    output_schema =>
      "image_description STRING, entities_in_the_image ARRAY<STRING>").*
FROM bqml_tutorial.product_images
WHERE uri LIKE "%aquarium%";
\`\`\`

### Using Grounding

\`\`\`
SELECT
  name,
  AI.GENERATE(
    ('Please check the weather of ', name, ' for today.'),
    model_params => JSON '{"tools": [{"googleSearch": {}}]}'
  )
FROM UNNEST(['Seattle', 'NYC', 'Austin']) AS name;
\`\`\`
`,
  'bigquery_ai_generate_bool.md': `# BigQuery AI.Generate_Bool

\`AI.GENERATE_BOOL\` generates a boolean value (\`TRUE\` or \`FALSE\`) based on the
prompt.

## Syntax Reference

\`\`\`sql
AI.GENERATE_BOOL(
  [ prompt => ] 'PROMPT'
  [, connection_id => 'CONNECTION_ID' ]
  [, endpoint => 'ENDPOINT' ]
  [, model_params => 'MODEL_PARAMS']
  [, request_type => 'REQUEST_TYPE']
)
\`\`\`

### Input Arguments

| Argument            | Requirement  | Type   | Description            |
| :------------------ | :----------- | :----- | :--------------------- |
| **\`prompt\`**        | **Required** | String | The prompt text or     |
:                     :              :        : instruction.           :
| **\`connection_id\`** | Optional     | String | The connection ID to   |
:                     :              :        : use for the LLM.       :
| **\`endpoint\`**      | Optional     | String | The model endpoint     |
:                     :              :        : (e.g.                  :
:                     :              :        : \`'gemini-2.5-flash'\`). :
| **\`model_params\`**  | Optional     | JSON   | JSON object for model  |
:                     :              :        : parameters (e.g.,      :
:                     :              :        : \`temperature\`,         :
:                     :              :        : \`max_output_tokens\`).  :
| **\`request_type\`**  | Optional     | String | \`'DEDICATED'\` or       |
:                     :              :        : \`'SHARED'\`.            :

### Output Schema

Column Name         | Type     | Description
:------------------ | :------- | :--------------------------------------
**\`result\`**        | \`BOOL\`   | The generated boolean value.
**\`status\`**        | \`STRING\` | API response status (empty on success).
**\`full_response\`** | \`JSON\`   | The complete raw JSON response.

## Examples

\`\`\`sql
SELECT AI.GENERATE_BOOL(
  'Is this a valid email address? ' || email_address
) as is_valid
FROM \`dataset.users\`;
\`\`\`
`,
  'bigquery_ai_generate_double.md': `# BigQuery AI.Generate_Double

\`AI.GENERATE_DOUBLE\` generates a floating-point number based on the prompt.

## Syntax Reference

\`\`\`sql
AI.GENERATE_DOUBLE(
  [ prompt => ] 'PROMPT'
  [, connection_id => 'CONNECTION_ID' ]
  [, model_params => 'MODEL_PARAMS']
  [, endpoint => 'ENDPOINT' ]
  [, request_type => 'REQUEST_TYPE']
)
\`\`\`

### Input Arguments

| Argument            | Requirement  | Type   | Description            |
| :------------------ | :----------- | :----- | :--------------------- |
| **\`prompt\`**        | **Required** | String | The prompt text or     |
:                     :              :        : instruction.           :
| **\`connection_id\`** | Optional     | String | The connection ID to   |
:                     :              :        : use for the LLM.       :
| **\`endpoint\`**      | Optional     | String | The model endpoint     |
:                     :              :        : (e.g.                  :
:                     :              :        : \`'gemini-2.5-flash'\`). :
| **\`model_params\`**  | Optional     | JSON   | JSON object for model  |
:                     :              :        : parameters (e.g.,      :
:                     :              :        : \`temperature\`,         :
:                     :              :        : \`max_output_tokens\`).  :
| **\`request_type\`**  | Optional     | String | \`'DEDICATED'\` or       |
:                     :              :        : \`'SHARED'\`.            :

### Output Schema

Column Name         | Type      | Description
:------------------ | :-------- | :--------------------------------------
**\`result\`**        | \`FLOAT64\` | The generated floating-point value.
**\`status\`**        | \`STRING\`  | API response status (empty on success).
**\`full_response\`** | \`JSON\`    | The complete raw JSON response.

## Examples

\`\`\`sql
SELECT AI.GENERATE_DOUBLE(
  'What is the total price mentioned in this text? ' || text_content
) as total_price
FROM \`dataset.receipts\`;
\`\`\`
`,
  'bigquery_ai_generate_int.md': `# BigQuery AI.Generate_Int

\`AI.GENERATE_INT\` generates an integer value based on the prompt.

## Syntax Reference

\`\`\`sql
AI.GENERATE_INT(
  [ prompt => ] 'PROMPT'
  [, connection_id => 'CONNECTION_ID' ]
  [, endpoint => 'ENDPOINT' ]
  [, request_type => 'REQUEST_TYPE']
  [, model_params => 'MODEL_PARAMS']
)
\`\`\`

### Input Arguments

| Argument            | Requirement  | Type   | Description            |
| :------------------ | :----------- | :----- | :--------------------- |
| **\`prompt\`**        | **Required** | String | The prompt text or     |
:                     :              :        : instruction.           :
| **\`connection_id\`** | Optional     | String | The connection ID to   |
:                     :              :        : use for the LLM.       :
| **\`endpoint\`**      | Optional     | String | The model endpoint     |
:                     :              :        : (e.g.                  :
:                     :              :        : \`'gemini-2.5-flash'\`). :
| **\`model_params\`**  | Optional     | JSON   | JSON object for model  |
:                     :              :        : parameters (e.g.,      :
:                     :              :        : \`temperature\`,         :
:                     :              :        : \`max_output_tokens\`).  :
| **\`request_type\`**  | Optional     | String | \`'DEDICATED'\` or       |
:                     :              :        : \`'SHARED'\`.            :

### Output Schema

Column Name         | Type     | Description
:------------------ | :------- | :--------------------------------------
**\`result\`**        | \`INT64\`  | The generated integer value.
**\`status\`**        | \`STRING\` | API response status (empty on success).
**\`full_response\`** | \`JSON\`   | The complete raw JSON response.

## Examples

\`\`\`sql
SELECT AI.GENERATE_INT(
  'How many items are in this list? ' || list_content
) as item_count
FROM \`dataset.inventory\`;
\`\`\`
`,
  'bigquery_ai_if.md': `# BigQuery AI.If

\`AI.IF\` is a semantic boolean function used to evaluate a condition described in
natural language.

The function can be used to filter and join data based on conditions described
in natural language or multimodal input. The following are common use cases:

-   Sentiment analysis: Find customer reviews with negative sentiment.
-   Topic analysis: Identify news articles related to a specific subject.
-   Image analysis: Select images that contain a specific item.
-   Security: Identify suspicious emails.

## Syntax Reference

\`\`\`sql
AI.IF(
  [ prompt => ] 'PROMPT'
  [, connection_id => 'CONNECTION_ID' ]
  [, endpoint => 'ENDPOINT' ]
)
\`\`\`

### Input Arguments

| Argument            | Requirement  | Type          | Description            |
| :------------------ | :----------- | :------------ | :--------------------- |
| **\`prompt\`**        | **Required** | String/Struct | The prompt text or a   |
:                     :              :               : struct/tuple of        :
:                     :              :               : \`(data, instruction)\`. :
| **\`connection_id\`** | Optional     | String        | The connection ID to   |
:                     :              :               : use for the LLM.       :
| **\`endpoint\`**      | Optional     | String        | The model endpoint     |
:                     :              :               : (e.g.                  :
:                     :              :               : \`'gemini-2.5-flash'\`). :

### Output Schema

| Column Name         | Type   | Description                               |
| :------------------ | :----- | :---------------------------------------- |
| **(Scalar Result)** | \`BOOL\` | \`TRUE\` if the condition is met, \`FALSE\`   |
:                     :        : otherwise. Returns \`NULL\` on error/safety :
:                     :        : filter.                                   :

## Examples

### Filter rows based on semantic meaning

\`\`\`sql
SELECT *
FROM \`dataset.table\`
WHERE AI.IF(
  (content_column, 'Is this review positive?')
);
\`\`\`
`,
  'bigquery_ai_score.md': `# BigQuery AI.Score

The \`AI.SCORE\` function is commonly used with the ORDER BY clause and works well
when you want to rank items. The following are common use cases:

-   Retail: Find the top 5 most negative customer reviews about a product.
-   Hiring: Find the top 10 resumes that appear most qualified for a job post.
-   Customer success: Find the top 20 best customer support interactions.

## Syntax Reference

\`\`\`sql
AI.SCORE(
  [ prompt => ] 'PROMPT'
  [, connection_id => 'CONNECTION_ID' ]
  [, endpoint => 'ENDPOINT' ]
)
\`\`\`

### Input Arguments

| Argument            | Requirement  | Type          | Description            |
| :------------------ | :----------- | :------------ | :--------------------- |
| **\`prompt\`**        | **Required** | String/Struct | The prompt text or a   |
:                     :              :               : struct/tuple of        :
:                     :              :               : \`(data, instruction)\`. :
| **\`connection_id\`** | Optional     | String        | The connection ID to   |
:                     :              :               : use for the LLM.       :
| **\`endpoint\`**      | Optional     | String        | The model endpoint     |
:                     :              :               : (e.g.                  :
:                     :              :               : \`'gemini-2.5-flash'\`). :

### Output Schema

| Column Name         | Type      | Description                                |
| :------------------ | :-------- | :----------------------------------------- |
| **(Scalar Result)** | \`FLOAT64\` | A numerical score representing the degree  |
:                     :           : to which the data matches the instruction. :

## Examples

### Rank rows by semantic relevance

\`\`\`sql
SELECT *
FROM \`dataset.table\`
ORDER BY AI.SCORE(
  (content_column, 'relevance to sports'),
  connection_id => 'my-project.us.my-connection'
) DESC
LIMIT 10;
\`\`\`
`,
  'bigquery_ai_search.md': `# BigQuery AI.Search

\`AI.SEARCH\` is a table-valued function for semantic search on tables that have
autonomous embedding generation enabled. If your table has a vector index on the
embedding column, then AI.SEARCH uses it to optimize the search.

You can use AI.SEARCH to help with the following tasks:

-   Semantic search: search entities ranked by semantic similarity.
-   Recommendation: return entities with attributes similar to a given entity.
-   Classification: return the class of entities whose attributes are similar to
    the given entity.
-   Clustering: cluster entities whose attributes are similar to a given entity.
-   Outlier detection: return entities whose attributes are least related to the
    given entity.

## Syntax Reference

\`\`\`sql
AI.SEARCH(
  { TABLE base_table | base_table_query },
  column_to_search,
  query_value
  [, top_k => top_k_value ]
  [, distance_type => distance_type_value ]
  [, options => options_value]
)
\`\`\`

### Input Arguments

Argument               | Requirement  | Type           | Description
:--------------------- | :----------- | :------------- | :----------
**\`base_table\`**       | **Required** | Table/Subquery | The table to search for nearest neighbor embeddings. The table must have autonomous embedding generation enabled.
**\`column_to_search\`** | **Required** | STRING         | A STRING literal that contains the name of the string column to search
**\`query_value\`**      | **Required** | STRING         | A string literal that represents the search query.
**\`top_k\`**            | Optional     | INT64          | A named argument with an INT64 value, specifies the number of nearest neighbors to return. The default is 10.
**\`distance_type\`**    | Optional     | STRING         | A named argument with a STRING value. distance_type_value specifies the type of metric to use to compute the distance between two vectors. Supported distance types are EUCLIDEAN, COSINE, and DOT_PRODUCT. The default is EUCLIDEAN.
**\`options\`**          | Optional     | STRING         | A named argument with a JSON-formatted STRING value that specifies the following search options: \`fraction_lists_to_search\` or \`use_brute_force\`

### Output Schema

Column Name    | Type    | Description
:------------- | :------ | :----------------------------------------------------
**\`base\`**     | STRUCT  | A struct containing all columns from the input table.
**\`distance\`** | FLOAT64 | The distance score between the query and the result.

## Examples

\`\`\`sql
# Create a table of products and descriptions with a generated embedding column.
CREATE TABLE mydataset.products (
  name STRING,
  description STRING,
  description_embedding STRUCT<result ARRAY<FLOAT64>, status STRING>
    GENERATED ALWAYS AS (AI.EMBED(
      description,
      connection_id => 'us.example_connection',
      endpoint => 'text-embedding-005'
    ))
    STORED OPTIONS( asynchronous = TRUE )
);

# Insert product descriptions into the table.
# The description_embedding column is automatically updated.
INSERT INTO mydataset.products (name, description) VALUES
  ("Lounger chair", "A comfortable chair for relaxing in."),
  ("Super slingers", "An exciting board game for the whole family."),
  ("Encyclopedia set", "A collection of informational books.");

SELECT
  base.name,
  base.description,
  distance
FROM AI.SEARCH(TABLE mydataset.products, 'description', "A really fun toy");
\`\`\`
`,
  'bigquery_ai_similarity.md': `# BigQuery AI.Similarity

\`AI.SIMILARITY\` computes the cosine similarity between two inputs

## Syntax Reference

\`\`\`sql
AI.SIMILARITY(
  content1 => 'CONTENT1',
  content2 => 'CONTENT2'
  endpoint => 'ENDPOINT'
  [, model_params => 'MODEL_PARAMS']
  [, connection_id => 'CONNECTION_ID']
)
\`\`\`

### Input Arguments

| Argument            | Requirement  | Type   | Description                   |
| :------------------ | :----------- | :----- | :---------------------------- |
| **\`content1\`**      | **Required** | String | The first text content.       |
| **\`content2\`**      | **Required** | String | The second text content to    |
:                     :              :        : compare against.              :
| **\`connection_id\`** | Optional     | String | The connection ID to use for  |
:                     :              :        : the LLM.                      :
| **\`endpoint\`**      | Optional     | String | The model endpoint (e.g.      |
:                     :              :        : \`'multimodalembedding@001'\`). :
| **\`model_params\`**  | Optional     | JSON   | JSON object for model         |
:                     :              :        : parameters (e.g.,             :
:                     :              :        : \`temperature\`,                :
:                     :              :        : \`max_output_tokens\`).         :

### Output Schema

| Column Name         | Type      | Description                         |
| :------------------ | :-------- | :---------------------------------- |
| **(Scalar Result)** | \`FLOAT64\` | A similarity score (e.g., cosine    |
:                     :           : similarity). Returns null if error. :

## Examples

\`\`\`sql
SELECT AI.SIMILARITY(
  content1 => 'The cat sat on the mat',
  content2 => 'A feline is resting on the rug',
  endpoint => 'text-embedding-005'
) as similarity_score;
\`\`\`
`,
};
