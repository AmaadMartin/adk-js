# Service registry sample

A session backend declared beside the agent. `services.yaml` binds the `demo://`
scheme to `DemoSessionService`, so the CLI can serve a URI ADK does not know.

See the [ServiceRegistry guide](../../docs/guides/apps/service_registry/index.md)
for the whole feature.

## Running

Build once, then run the agent with the custom scheme:

```bash
npm run build
npm run sample -- samples/service_registry/agent.ts \
  --session_service_uri demo://local
```

The agent has no model, so the run is offline. Type anything and it echoes it
back.

Change the scheme to one nothing registers and the CLI refuses it, which is the
proof that `services.yaml` is what makes `demo://` resolve:

```bash
npm run sample -- samples/service_registry/agent.ts \
  --session_service_uri nope://local
# Error running agent: Unsupported session service URI: nope://local
```
