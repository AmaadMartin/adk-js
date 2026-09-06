# ManagedAgent sample

Four `ManagedAgent` shapes behind one `LlmAgent` coordinator: a search agent, a
code-execution agent built from a raw `Tool`, a remote-MCP agent, and a
summarizer. See
[the ManagedAgent guide](../../../docs/guides/agents/managed_agent/index.md).

## Setup

Every agent here calls the Managed Agents API, so running the sample needs an
agent id and credentials.

```bash
export MANAGED_AGENT_ID=antigravity-preview-05-2026   # or your own agent id
```

Pick one backend:

```bash
# Gemini Developer API
export GEMINI_API_KEY=...

# or the enterprise backend, which ManagedAgent pins to the `global` location
export GOOGLE_GENAI_USE_ENTERPRISE=1
gcloud auth application-default login
```

The MCP agent points at `https://api.example.com/mcp` unless you override it.
Set both variables to reach a real server:

```bash
export MCP_SERVER_URL=https://your-server.example.com/mcp
export MCP_BEARER_TOKEN=...
```

## Running

```bash
npm run build
npm run sample -- samples/agents/managed_agent/agent.ts
```
