# getBigQuerySkill

Loads the `bigquery-ai-ml` skill that ships inside `@google/adk`. The skill
teaches a model to answer analytics questions with BigQuery `AI.*` SQL
functions. Reach for it when your agent writes BigQuery SQL and you do not want
to author the instructions yourself.

## Introduction

A skill is a folder of markdown that extends what a model knows: a `SKILL.md`
with the instructions, plus optional `references/`, `assets/` and `scripts/`.
`SkillToolset` exposes such folders to an agent through four tools, so the model
reads a skill on demand instead of carrying it in every prompt.

`getBigQuerySkill` removes the authoring step for one common case. BigQuery has
eleven `AI.*` functions, each with its own syntax, and a model that guesses at
them writes SQL that does not run. The packaged skill states one rule — prefer
`AI.*` SQL over dedicated tools — and gives a routing table that maps each
function to the reference file the model must read first. The references stay
out of the prompt until the model asks for one.

The skill describes SQL; it does not run SQL. It expects an `execute_sql` tool
that you supply, so pair it with whatever BigQuery client your agent already
uses.

## Get started

Load the skill and hand it to a `SkillToolset`:

```ts
import {getBigQuerySkill, LlmAgent, SkillToolset} from '@google/adk';

const agent = new LlmAgent({
  name: 'bq_analyst',
  model: 'gemini-2.5-flash',
  instruction: 'Answer data questions with BigQuery SQL.',
  tools: [new SkillToolset([await getBigQuerySkill()])],
});
```

The agent now has `list_skills`, `load_skill`, `load_skill_resource` and
`run_skill_script`. Asked to forecast a time series, the model calls
`load_skill` for `bigquery-ai-ml`, reads the routing table, then calls
`load_skill_resource` for `references/bigquery_ai_forecast.md` before it writes
`AI.FORECAST`.

Add your own tools alongside it, since the skill's SQL needs somewhere to run:

```ts
import {getBigQuerySkill, LlmAgent, SkillToolset} from '@google/adk';
import {executeSql} from './my_bigquery_client.js';

const agent = new LlmAgent({
  name: 'bq_analyst',
  model: 'gemini-2.5-flash',
  tools: [new SkillToolset([await getBigQuerySkill()]), executeSql],
});
```

## What the skill contains

`SKILL.md` holds the routing table. One reference file documents each function:

| Function              | Reference file                               |
| --------------------- | -------------------------------------------- |
| `AI.CLASSIFY`         | `references/bigquery_ai_classify.md`         |
| `AI.DETECT_ANOMALIES` | `references/bigquery_ai_detect_anomalies.md` |
| `AI.FORECAST`         | `references/bigquery_ai_forecast.md`         |
| `AI.GENERATE`         | `references/bigquery_ai_generate.md`         |
| `AI.GENERATE_BOOL`    | `references/bigquery_ai_generate_bool.md`    |
| `AI.GENERATE_DOUBLE`  | `references/bigquery_ai_generate_double.md`  |
| `AI.GENERATE_INT`     | `references/bigquery_ai_generate_int.md`     |
| `AI.IF`               | `references/bigquery_ai_if.md`               |
| `AI.SCORE`            | `references/bigquery_ai_score.md`            |
| `AI.SEARCH`           | `references/bigquery_ai_search.md`           |
| `AI.SIMILARITY`       | `references/bigquery_ai_similarity.md`       |

Read them yourself through the returned object:

```ts
import {getBigQuerySkill} from '@google/adk';

const skill = await getBigQuerySkill();

const name = skill.frontmatter.name; // 'bigquery-ai-ml'
const routingTable = skill.instructions; // the SKILL.md body
const forecast = skill.resources?.references?.['bigquery_ai_forecast.md'];
```

## Where the files come from

The markdown ships inside the installed package, next to the compiled module,
and `getBigQuerySkill` reads it from disk on every call. Two consequences
follow.

The function needs a filesystem, so it works under Node and fails in a browser.
Importing `@google/adk` in a browser build stays safe: the path resolves per
call, not at import time.

The function also needs the package layout that `npm run build` produces. A
bundler that inlines `@google/adk` into one file moves the module away from its
markdown, and the call then fails to find `SKILL.md`. Keep the package external
if your agent uses this skill.

## Differences from adk-python

`getBigQuerySkill` returns a `Promise<Skill>`, while adk-python's
`get_bigquery_skill` returns a `Skill` directly. adk-js loads skills
asynchronously. The skill markdown is identical in both SDKs.

`SkillToolset` is experimental in adk-js, so it logs a warning on construction
and its API may change.
