# BaseAgentLoader

`BaseAgentLoader` is the interface the ADK development API server uses to find
the agents it serves. Implement it to serve agents that do not live in a
directory of agent files.

## Introduction

`AdkApiServer` needs a set of named agents. By default it builds an
`AgentLoader`, which scans the directory given by the `agentsDir` option,
compiles each agent file, and caches the result. That default suits local
development, where the agents are files you are editing.

It does not suit every host. An application that keeps agent definitions in a
database, fetches them from a registry, or builds them in process has no
directory to point at. `BaseAgentLoader` is the seam for those hosts: the server
depends on the interface, so any object with the two methods can replace the
directory scanner. `AgentLoader` implements the same interface, so the default
path is unchanged.

The interface has two methods, and the server calls nothing else on a loader:

| Method                 | The server uses it for                                                                                                      |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `listAgents()`         | `GET /list-apps`, the app-name check the graph endpoints make first, and choosing which agents to mount on the A2A surface. |
| `loadAgent(agentName)` | Building the `Runner` for `/run`, `/run_sse` and `/api/reasoning_engine`, the two graph endpoints, and the A2A surface.     |

`loadAgent` returns a `RunnableRoot` or an `App`. Return an `App` when the agent
needs app-wide plugins or configuration; return the agent or `Workflow` itself
otherwise. The server unwraps either one.

## Get started

This server holds its agents in a `Map`. It never reads the filesystem, and it
sets no `agentsDir`.

```ts
import {App, LlmAgent, RunnableRoot} from '@google/adk';
import {AdkApiServer, BaseAgentLoader} from '@google/adk-devtools';

/** Serves the agents held in a map. */
class InMemoryAgentLoader implements BaseAgentLoader {
  constructor(private readonly agents: Map<string, RunnableRoot | App>) {}

  async listAgents(): Promise<string[]> {
    return [...this.agents.keys()].sort();
  }

  async loadAgent(agentName: string): Promise<RunnableRoot | App> {
    const agent = this.agents.get(agentName);
    if (!agent) {
      throw new Error(`No agent named '${agentName}'`);
    }

    return agent;
  }
}

const support = new LlmAgent({
  name: 'support',
  model: 'gemini-2.5-flash',
  description: 'Answers support questions.',
});

const server = new AdkApiServer({
  agentLoader: new InMemoryAgentLoader(new Map([['support', support]])),
});

await server.start();
```

`GET /list-apps` now answers `["support"]`, and a `POST /run` naming `support`
runs that agent.

## What the server expects

**Return names in alphabetical order.** `listAgents()` is the order the
`/list-apps` response uses. The server does not sort it for you.

**Let errors propagate.** The server maps a rejection from `loadAgent` to HTTP
500 and puts the error message in the response body. Do not catch and re-message
the failure: the message you throw is the message the caller reads.

**Expect repeated calls.** The server calls `loadAgent` on every request that
needs the agent. It caches the `Runner` it builds under the app name, so only
the first call's agent serves traffic; later calls are loaded and discarded.
Cache inside your loader if construction is expensive. `AgentLoader` does that
already — it keeps one compiled agent file per name and returns the same
instance.

**Own your cleanup.** The server never disposes what a loader returns, because
it does not know what the loader allocated. Release resources on your own
schedule, as `AgentLoader` does when it reloads a changed file and when the
process exits.

## Using it with the default loader

`agentLoader` and `agentsDir` are alternatives. When you pass `agentLoader`, the
server uses it and ignores `agentsDir`, `agentFileLoadOptions` and
`reloadAgents`, which only configure the default `AgentLoader`. To serve both
directory agents and your own, wrap an `AgentLoader` in your implementation and
delegate to it for the names it owns.
