# VertexAiLoadProfilesTool

`VertexAiLoadProfilesTool` lets the model read the current user's structured
profiles from Vertex AI Memory Bank. Reach for it when a profile is large, or
changes between turns, and you do not want to put it in the system instruction
on every turn.

## Introduction

Memory Bank stores two different things for a scope. Memories are free-form
facts that you find with a semantic query. Profiles are schema-shaped records
that you look up by scope. `LoadMemoryTool` covers the first case, and this tool
covers the second.

The tool takes no arguments. It reads the app name and the user id from the tool
context, asks the service for that scope, and returns one payload per profile. A
profile with no payload carries nothing for the model to read, so the tool drops
it.

Profile retrieval is not part of `BaseMemoryService`, so the tool does not take
the invocation's memory service. You inject the service yourself, and the tool
accepts anything that satisfies `ProfileRetrievingMemoryService`:

```ts
export interface ProfileRetrievingMemoryService {
  retrieveProfiles(request: {
    appName: string;
    userId: string;
  }): Promise<MemoryProfile[]>;
}
```

`VertexAiMemoryBankService` does not expose `retrieveProfiles`, so pass a
service of your own that does. The next section builds one on the Vertex AI SDK.

## Get started

You need an Agent Engine with structured memory schemas configured. The schema
id you configure there becomes the key of each returned profile.

```ts
import {Client} from '@google-cloud/vertexai';
import {MemoryProfile} from '@google-cloud/vertexai/build/src/genai/types.js';
import {
  LlmAgent,
  ProfileRetrievingMemoryService,
  VertexAiLoadProfilesTool,
} from '@google/adk';

class MemoryBankProfiles implements ProfileRetrievingMemoryService {
  private readonly memories;

  constructor(
    private readonly agentEngineId: string,
    client: Client,
  ) {
    this.memories = client.agentEnginesInternal.memories;
  }

  async retrieveProfiles(request: {
    appName: string;
    userId: string;
  }): Promise<MemoryProfile[]> {
    const response = await this.memories.retrieveProfiles({
      name: `reasoningEngines/${this.agentEngineId}`,
      scope: {app_name: request.appName, user_id: request.userId},
    });
    return Object.values(response.profiles ?? {});
  }
}

const client = new Client({
  project: process.env['GOOGLE_CLOUD_PROJECT'],
  location: process.env['GOOGLE_CLOUD_LOCATION'],
});

export const agent = new LlmAgent({
  name: 'concierge',
  model: 'gemini-2.5-flash',
  tools: [
    new VertexAiLoadProfilesTool({
      memoryService: new MemoryBankProfiles('456', client),
    }),
  ],
});
```

The model sees a function named `load_profiles` that takes no arguments. A call
returns `{profiles: [...]}`, where each entry is one profile payload.

## What the tool returns

The tool preserves the order the service returned. It drops a profile whose
payload is absent or empty, so a scope with three registered schemas and one
populated record returns a single entry:

```json
{"profiles": [{"name": "Kim", "tier": "gold"}]}
```

A scope with no populated profile returns `{"profiles": []}`. That is not an
error.

## Failure modes

The tool does not catch anything. `FunctionTool` wraps a thrown error as
`Error in tool 'load_profiles': <message>`, so a failing lookup reaches the
model as a failed tool call rather than ending the run.

Two errors are worth knowing:

- The service rejects. The reason reaches the model inside the wrapper.
- The framework calls the tool with no tool context. The tool cannot resolve a
  scope without one, so it throws
  `Tool 'load_profiles' requires a tool context.`
