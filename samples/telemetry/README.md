# Agent Engine telemetry sample

A minimal agent for exercising the Vertex AI Agent Engine telemetry paths by
hand. The
[Agent Engine telemetry guide](../../docs/guides/telemetry/agent_engine/index.md)
explains what the paths do and what the metric reader guarantees.

Every Agent Engine path is inert unless `GOOGLE_CLOUD_AGENT_ENGINE_ID` is set.
Off Agent Engine this sample is an ordinary agent, which is the point: nothing
changes for a laptop run.

## Run it

```bash
npm run build
npm run sample -- samples/telemetry/agent_engine/agent.ts
```

## Drive the telemetry paths

Serve the agent, pretending to be Agent Engine:

```bash
export GOOGLE_CLOUD_AGENT_ENGINE_ID=my-deployment
npx adk api_server samples/telemetry
```

Send a request carrying both headers. `Google-Agent-Engine-Traceparent` parents
the run onto the caller's span; `traceparent` is the support identifier the run
records as the `supportID` attribute on its top span.

```bash
curl -sS http://localhost:8000/api/reasoning_engine \
  -H 'Content-Type: application/json' \
  -H 'Google-Agent-Engine-Traceparent: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01' \
  -H 'traceparent: support-id-from-the-user-report' \
  -d '{"input": {"appName": "agent_engine", "userId": "u", "sessionId": "s",
       "newMessage": {"role": "user", "parts": [{"text": "hello"}]}}}'
```

Request-driven metric export needs Google Cloud telemetry as well, so add
`--otel_to_cloud` to the server command. Metrics then leave on the request path
instead of on a background timer.
