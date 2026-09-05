# Eval result

`EvalCaseResult` and `EvalSetResult` are what an eval run produces: the verdict
for one graded eval case, and the verdicts for a whole eval set. Reach for them
when you read a result file, or when you write a service that produces one.

## Introduction

Both SDKs write their results to the same place, one JSON document per run,
under `<agentsDir>/<appName>/.adk/eval_history/`. adk-python writes snake_case
keys and omits any field whose value is the pydantic default. So a document is
not enough on its own: a reader has to translate the key spelling and put the
missing defaults back.

`parseEvalCaseResult` and `parseEvalSetResult` do both. They accept either key
spelling, so a document written by adk-js reads as well as one written by
adk-python, and they apply the same defaults adk-python declares. Use them at
the point a result enters your code. A result you build yourself in memory does
not need them — the interfaces alone type it.

The two models nest: an `EvalSetResult` holds its `EvalCaseResults`, and
`parseEvalSetResult` validates each one, so the nested defaults are applied
too.

## Get started

```ts
import {parseEvalSetResult} from '@google/adk';

const setResult = parseEvalSetResult({
  eval_set_result_id: 'home_automation_smoke_1700000000',
  eval_set_id: 'smoke',
  creation_timestamp: 1700000000,
  eval_case_results: [
    {
      final_eval_status: 1,
      overall_eval_metric_results: [],
      eval_metric_result_per_invocation: [],
      session_id: 'inference_session',
    },
  ],
});

setResult.evalSetResultId; // 'home_automation_smoke_1700000000'
setResult.evalCaseResults[0].evalSetId; // '' — adk-python's default
setResult.evalCaseResults[0].evalId; // ''
```

## Defaults

Each default mirrors one adk-python declares in `eval_result.py`. A payload
that omits the field gets the default; a payload that omits any other required
field is rejected.

On `EvalCaseResult`:

- `evalSetId` and `evalId` default to `''`.
- `overallEvalMetricResults` defaults to `[]`.

On `EvalSetResult`:

- `evalCaseResults` defaults to `[]`.
- `creationTimestamp` defaults to `0`.

```ts
import {parseEvalCaseResult} from '@google/adk';

const caseResult = parseEvalCaseResult({
  final_eval_status: 1,
  eval_metric_result_per_invocation: [],
  session_id: 'session_1',
});

caseResult.evalSetId; // ''
caseResult.overallEvalMetricResults; // []
```

## What the validators do not touch

The metric, invocation and session payloads belong to other modules. They pass
through by reference, and they keep the key spelling they arrived in. So a
document adk-python wrote still carries `metric_name` inside each metric
result after the eval case result around it has been renamed.

An unrecognized key survives as well, because adk-python builds these two
models on a plain pydantic model rather than a strict one. adk-python drops the
key instead of keeping it; neither SDK rejects the document.

adk-python writes `null` for an optional field it did not set. Both spellings —
an explicit `null` and an absent key — read back as `undefined`.

## Failure modes

Both functions throw an `InputValidationError` naming the property at fault.
They never return a partly built result.

- A required field is absent: `finalEvalStatus`,
  `evalMetricResultPerInvocation` or `sessionId` on a case result;
  `evalSetResultId` or `evalSetId` on a set result.
- `finalEvalStatus` is not one of the `EvalStatus` integers `1`, `2` or `3`.
- A nested case result does not validate.
