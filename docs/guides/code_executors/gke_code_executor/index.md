# GkeCodeExecutor

Runs model-generated code in a dedicated Pod on a Google Kubernetes Engine
cluster. Reach for it when the agent runs untrusted code and you already have a
cluster, and you want the code isolated from the host kernel by gVisor.

## Introduction

An agent that writes code has to run it somewhere. `UnsafeLocalCodeExecutor`
runs it in the host process, where the code sees the host filesystem, network
and credentials. `AgentEngineSandboxCodeExecutor` runs it in a managed sandbox,
which needs a Google Cloud project and gives you no control over the runtime.
`GkeCodeExecutor` sits between them: the code runs on a cluster you own, in a
Pod you can shape.

It offers two modes, and they do not give the same isolation.

Job mode is the default. Each execution creates its own Kubernetes `Job`. The
code is mounted read-only from a `ConfigMap`, and the Pod requests the `gvisor`
RuntimeClass, so the code runs against a user-space kernel rather than the
node's. The container runs as a non-root user, cannot escalate privileges, has
a read-only root filesystem, drops every Linux capability, and is bounded by
CPU and memory limits. The Pod does not receive a service-account token, so the
code cannot call the cluster it runs in. The Job is not retried on failure, and
the TTL controller deletes it and its Pod ten minutes after it finishes.

Sandbox mode routes execution through the GKE Agent Sandbox instead. The Pod
comes from a `SandboxTemplate` already installed in the cluster, so its runtime
class and security context come from that template and not from this executor.
Use it when you already run the agent-sandbox controller and want its pooling
and routing.

The class is marked experimental. Its options may change.

## Get started

`@kubernetes/client-node` is an optional peer dependency, so install it first:

```sh
npm install @kubernetes/client-node
```

Job mode needs a cluster with a gVisor node pool and the `gvisor` RuntimeClass.
It also needs a ServiceAccount whose Role grants these rules:

```yaml
rules:
  # Create the code ConfigMap and patch its ownerReferences.
  - apiGroups: ['']
    resources: ['configmaps']
    verbs: ['create', 'delete', 'get', 'patch']
  # Create the Job and watch it for completion.
  - apiGroups: ['batch']
    resources: ['jobs']
    verbs: ['get', 'list', 'watch', 'create', 'delete']
  # Read the log of the Job's Pod.
  - apiGroups: ['']
    resources: ['pods', 'pods/log']
    verbs: ['get', 'list']
```

Running in the cluster, the executor picks up those credentials on its own:

```ts
import {GkeCodeExecutor, LlmAgent} from '@google/adk';

const agent = new LlmAgent({
  name: 'data_analyst',
  model: 'gemini-2.5-flash',
  instruction: 'Analyze data using Python scripts.',
  codeExecutor: new GkeCodeExecutor({namespace: 'agents'}),
});
```

## Connecting to a cluster

Credentials are resolved on the first execution, not in the constructor, so
`new GkeCodeExecutor()` works before the package is installed and before a
cluster is reachable.

The executor tries an explicit kubeconfig path, then the in-cluster service
account, then the local default kubeconfig, and uses the first that loads.
Pass a path to work against a cluster from a workstation:

```ts
new GkeCodeExecutor({
  kubeconfigPath: '/home/me/.kube/config',
  kubeconfigContext: 'gke_my-project_us-central1_my-cluster',
});
```

## Shaping the Pod

Every operational value has a default, and each one matches adk-python.

```ts
new GkeCodeExecutor({
  namespace: 'agents', // default 'default'
  image: 'python:3.12-slim', // default 'python:3.11-slim'
  timeoutSeconds: 120, // default 300
  cpuRequested: '500m', // default '200m'
  memRequested: '512Mi', // default '256Mi'
  cpuLimit: '1000m', // default '500m'
  memLimit: '1Gi', // default '512Mi'
});
```

`timeoutSeconds` bounds the whole wait for the Job, not one watch connection.
The Kubernetes client caps a single watch connection at 30 seconds, so the
executor re-establishes the watch until its own deadline passes. It reopens a
connection that closed cleanly or that hit the cap. It does not reopen one the
API server refused: a Role without `watch` on `batch/jobs` is reported as a
Kubernetes API error on the first attempt, not as a timeout.

## What you get back

Job mode never throws. Every failure comes back as `stderr` on the result, so
the agent can read the error and try again.

| Situation                         | `stdout`    | `stderr`                               | `exitCode`                     |
| --------------------------------- | ----------- | -------------------------------------- | ------------------------------ |
| The Job succeeded                 | the Pod log | `''`                                   | the container's status, or `0` |
| The Job failed                    | `''`        | `Job failed. Logs:` and the Pod log    | the container's status, or `1` |
| The Kubernetes API refused a call | `''`        | `Kubernetes API error:` and the reason | unset                          |
| The Job outlived `timeoutSeconds` | `''`        | `Executor timed out:` and the Pod log  | unset                          |

`exitCode` is read from the `code-runner` container of the Job's Pod. When that
container reports no terminated state, the status is narrowed to what the Job's
own outcome implies. `outputFiles` is always empty: the executor collects the
Pod log and nothing else.

## Sandbox mode

Sandbox mode needs the agent-sandbox controller, a `SandboxTemplate` and a
sandbox router and gateway deployed in the cluster.

```ts
new GkeCodeExecutor({
  executorType: 'sandbox',
  namespace: 'agents',
  sandboxTemplate: 'python-sandbox-template',
  sandboxGatewayName: 'sandbox-gateway',
});
```

The executor writes the code to `script.py` in the sandbox, runs
`python3 script.py`, and releases the sandbox on both the success and the error
path. The result carries the sandbox's `stdout`, `stderr` and `exitCode`, and
`exitCode` is unset when the sandbox reports none. Unlike job mode it throws: a
`SandboxInfrastructureError` for a gateway or provisioning failure, and the
original error for anything else. Only a timeout comes back as a `stderr`
result. That asymmetry matches adk-python.

ADK ships `AgentSandboxClient`, which provisions the `Sandbox` resource and
talks to the router. Pass `sandboxClientFactory` to substitute your own:

```ts
import {AgentSandboxClient, GkeCodeExecutor} from '@google/adk';

new GkeCodeExecutor({
  executorType: 'sandbox',
  namespace: 'agents',
  sandboxClientFactory: (options) =>
    new AgentSandboxClient({...options, serverPort: 9000}),
});
```

## Verifying it against a real cluster

The automated tests use a local HTTP server in place of the Kubernetes API, so
they prove the wire format but not the sandbox. To check the real thing, deploy
the agent to a cluster with a gVisor node pool and the RBAC above, then run:

```ts
import {CodeExecutionLanguage, GkeCodeExecutor} from '@google/adk';

const executor = new GkeCodeExecutor({namespace: 'agents'});
const result = await executor.executeCode({
  invocationContext,
  codeExecutionInput: {
    code: 'print("hello world")',
    language: CodeExecutionLanguage.PYTHON,
    inputFiles: [],
  },
});
```

Expect `result.stdout` to be `hello world` and `result.exitCode` to be `0`. Run
`kubectl get jobs,configmaps -n agents` straight afterwards to see the pair, and
again ten minutes later to see the TTL controller remove both.
