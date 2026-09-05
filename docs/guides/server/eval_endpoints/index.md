# The API server's eval endpoints

`AdkApiServer` serves the eval sets and eval results of the apps it hosts over
HTTP. The developer UI's eval tab is built on these endpoints, and a script
can drive the same lifecycle: create a set, record a session into it as a
case, run the set, and read the results back.

## Introduction

An eval set is a named list of eval cases, and an eval case is one recorded
conversation plus the session state it starts from. `EvalSetsManager` stores
the sets and `EvalSetResultsManager` stores the results of running them. The
server owns one of each and exposes them.

The interesting endpoint is `add-session`. Recording an eval case by hand is
tedious, so the server builds one from a session you already have: it reads
the session's events, groups them into invocations, and seeds the case's
session state with the keys the agent's instruction reads. That turns "this
conversation went well" into a regression test.

Running a set is separate, because scoring an agent needs an eval service that
this build of `@google/adk` does not install for you. Install one with
`setEvalRuntime` before calling the run endpoint; without one the endpoint
answers 400 and says so.

## Get started

Start a server with the developer UI on, so the `/dev/apps/...` paths are
served:

```ts
import {AdkApiServer} from '@google/adk-devtools';

const server = new AdkApiServer({
  agentsDir: './agents',
  serveDebugUI: true,
});

await server.start();
```

Create a set, record a session into it, and read the case back:

```console
$ curl -XPOST localhost:8000/dev/apps/my_agent/eval-sets \
    -H 'content-type: application/json' \
    -d '{"evalSet":{"evalSetId":"regressions"}}'

$ curl -XPOST localhost:8000/dev/apps/my_agent/eval-sets/regressions/add-session \
    -H 'content-type: application/json' \
    -d '{"evalId":"greeting","sessionId":"s1","userId":"u"}'

$ curl localhost:8000/dev/apps/my_agent/eval-sets/regressions/eval-cases/greeting
```

By default the sets are files under `<agentsDir>/<appName>/`, and the results
go under `<agentsDir>`. Point them at Cloud Storage with `--eval_storage_uri`,
or supply your own managers:

```console
$ adk web ./agents --eval_storage_uri gs://my-eval-bucket
```

```ts
import {InMemoryEvalSetsManager} from '@google/adk';
import {AdkApiServer} from '@google/adk-devtools';

const server = new AdkApiServer({
  agentsDir: './agents',
  serveDebugUI: true,
  evalSetsManager: new InMemoryEvalSetsManager(),
});
```

A manager you supply wins over `evalStorageUri`, as `sessionService` wins over
`sessionServiceUri`.

## Running a set

`POST /dev/apps/:appName/eval-sets/:evalSetId/run` scores the set and saves
the results. The body may name the cases to run and the metrics to score them
against; both default to everything the set and the registry offer.

```ts
import {LocalEvalRuntime, setEvalRuntime} from '@google/adk';

setEvalRuntime(new LocalEvalRuntime());
```

Without that call, the endpoint answers 400 and the body carries the reason:
the eval runtime is not installed. `GET /dev/apps/:appName/metrics-info`
describes the metrics the run can score against; adk-js seeds three where
adk-python seeds more.

## Where each path is served

The `/dev/apps/...` paths need `serveDebugUI`, because they exist for the
developer UI. adk-python serves them from a `DevServer` subclass for the same
reason.

The older `/apps/:appName/eval_sets/...` and `/apps/:appName/eval_results/...`
paths are served on every server. They are adk-js's own, they answered 501
before, and a client already calling them keeps working.

## Status codes

| Condition                                                | Status |
| -------------------------------------------------------- | ------ |
| The eval set id is not `[a-zA-Z0-9_]+`                   | 400    |
| The eval set id is already taken                         | 400    |
| `add-session` names a session that does not exist        | 400    |
| `add-session` names an eval set that does not exist      | 400    |
| `add-session` names an eval case id already in the set   | 400    |
| Listing the cases of an eval set that does not exist     | 400    |
| Reading, updating or deleting a case that does not exist | 404    |
| An update whose body names a different eval id           | 400    |
| Running an eval set that does not exist                  | 400    |
| Running with no eval runtime installed                   | 400    |
| Reading an eval result id that does not exist            | 404    |

Two of these differ from adk-python. It answers 500 for a missing session,
through a bare assertion, and it answers 500 for a missing eval set on
`add-session`, because it maps the wrong error class. Both are client
mistakes, so adk-js answers 400.
