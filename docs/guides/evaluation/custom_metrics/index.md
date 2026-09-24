# Custom metrics

`CustomMetricEvaluator` scores an eval case with a function you wrote and named
from your eval config. Reach for it when no metric ADK ships measures the thing
you care about.

## Introduction

Every ADK metric implements `Evaluator`: it reads a list of `Invocation` and
returns an `EvaluationResult`. Writing that class is straightforward, but it
puts your metric inside the SDK's object graph. A custom metric is usually one
function, and you want to name it from the eval config that uses it.

`CustomMetricEvaluator` is the join between the two. You give it a metric and
the name of a scoring function. It resolves that function, hands it the
invocations, and returns what the function produced. It does not post-process
the verdict: your function owns `overallScore`, `overallEvalStatus` and
`perInvocationResults`.

The name is a fully-qualified name, the same form the rest of adk-js uses to
name code from a configuration document: `<module specifier>#<export>`. A name
with no `#` names the module's `default` export. The specifier can be a package
name, an absolute path, or a path relative to the file the name came from.

Resolution is deferred. The module is imported on the first
`evaluateInvocations` call rather than in the constructor, because `import()` is
asynchronous. The promise is kept, so a second call reuses the first import. A
name that cannot resolve is therefore reported at the first evaluation.

## Get started

Write the scoring function as a normal export.

```ts
// brand_voice.ts
import {
  EvalStatus,
  type EvalMetric,
  type EvaluationResult,
  type Invocation,
} from '@google/adk';

export function scoreBrandVoice(
  evalMetric: EvalMetric,
  actualInvocations: Invocation[],
): EvaluationResult {
  const threshold = evalMetric.criterion?.threshold ?? 0.5;
  const perInvocationResults = actualInvocations.map((actualInvocation) => ({
    actualInvocation,
    score: 1,
    evalStatus: EvalStatus.PASSED,
  }));
  return {
    overallScore: 1,
    overallEvalStatus: 1 >= threshold ? EvalStatus.PASSED : EvalStatus.FAILED,
    perInvocationResults,
  };
}
```

Then name it when you build the evaluator.

```ts
import {CustomMetricEvaluator, type EvalMetric} from '@google/adk';
import {fileURLToPath} from 'node:url';

const evalMetric: EvalMetric = {
  metricName: 'brand_voice',
  criterion: {threshold: 0.8},
};

const evaluator = new CustomMetricEvaluator(
  evalMetric,
  './brand_voice.js#scoreBrandVoice',
  fileURLToPath(import.meta.url),
);

const result = await evaluator.evaluateInvocations(actualInvocations);
```

The third argument is the absolute path of the file the name came from. A
relative specifier resolves against its directory, so it cannot resolve without
one. Pass the path of your eval config when the name comes from a config file.
A package name or an absolute path ignores it.

## What your function receives

The first argument is a deep copy of the metric, not the metric itself. Writing
to it cannot reach the caller's object. The copy has its metric-level
`threshold` cleared, because that field is deprecated in favour of `criterion`;
`criterion.threshold` is left in place.

The remaining arguments are passed straight through from `evaluateInvocations`:
the actual invocations, the golden invocations when the eval case recorded any,
and the conversation scenario when a simulated user drove the conversation.
Declare only the parameters you read.

Your function may return an `EvaluationResult` or a promise of one. Both work;
`evaluateInvocations` awaits the result either way.

## Failure modes

Every failure is an `InputValidationError`, thrown from the first
`evaluateInvocations` call.

| What went wrong                                     | Message                                               |
| --------------------------------------------------- | ----------------------------------------------------- |
| The module will not import, or exports no such name | `Could not import custom metric function from <path>` |
| The export is not a function                        | `Custom metric <path> does not refer to a callable.`  |

The first case attaches the underlying failure as the error's `cause`, so you
can report the real import error rather than only the summary.

A path specifier fails this way in the published package. `core/build.js`
targets `node10.4`, so esbuild lowers `import()` to `require()`, and `require()`
rejects the `file:` URL the resolver builds. Name your scoring function with a
package specifier until that target moves. A path specifier does work when you
run against the TypeScript sources.

## What the name may point at

Importing a module runs its top-level code. The name comes from your own eval
config, so it is trusted as far as that file is. Two specifiers are refused
rather than imported: a Node built-in such as `node:child_process`, and any
specifier carrying a URL scheme such as `data:`. The second stops a config file
from shipping code instead of naming it. This narrows what a config can reach.
It is not a sandbox.
