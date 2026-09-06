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
context, asks `VertexAiMemoryBankService` for that scope, and returns one
payload per profile. The model cannot supply a scope, so it cannot read another
user's profiles.

Profile retrieval is not part of `BaseMemoryService`, so the tool does not read
the invocation's memory service. You pass the service to the constructor.

## Get started

You need an agent engine with structured memory schemas configured. The schema
id you configure there keys each returned profile.

```ts
import {
  LlmAgent,
  VertexAiLoadProfilesTool,
  VertexAiMemoryBankService,
} from '@google/adk';

const memoryService = new VertexAiMemoryBankService({
  projectId: process.env['GOOGLE_CLOUD_PROJECT'],
  location: process.env['GOOGLE_CLOUD_LOCATION'],
  agentEngineId: process.env['AGENT_ENGINE_ID']!,
});

export const rootAgent = new LlmAgent({
  name: 'concierge',
  model: 'gemini-2.5-flash',
  instruction: 'Call load_profiles before you answer anything about the user.',
  tools: [new VertexAiLoadProfilesTool(memoryService)],
});
```

`samples/tools/vertex_ai_load_profiles/agent.ts` is this agent, ready to run.

## What the tool returns

The model sees a function named `load_profiles` that takes no arguments. A call
returns `{profiles: [...]}`, where each entry is one profile payload, in the
order the service returned:

```json
{"profiles": [{"name": "Kim", "tier": "gold"}]}
```

The tool drops a profile whose payload is absent or empty, so a scope with three
registered schemas and one populated record returns a single entry. A scope with
no populated profile returns `{"profiles": []}`. That is not an error.

## Failure modes

The tool does not catch anything. A rejection from the memory bank reaches the
caller unchanged, so a failed lookup surfaces as a failed tool call rather than
as an empty profile list.
