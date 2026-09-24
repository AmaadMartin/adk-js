# Service registry sample

A session backend declared beside the agent, in `services.yaml`. See the
[service registry guide](../../docs/guides/apps/service_registry/index.md).

`services.yaml` binds the `demo` scheme to `DemoSessionService`, exported by
`demo_session_service.js` in this directory. The CLI reads the file from the
agent's own directory, so nothing has to be installed or configured.

## Running

```bash
npm run build
npm run sample -- samples/service_registry/agent.ts --session_service_uri demo://sessions
```

The agent answers without a model, so no API key is needed. Type `exit` to
leave.

To see that the registration is what made it work, rename `services.yaml` and
run the same command again. The URI then reaches the built-in resolver, which
does not know the scheme:

```
Unsupported session service URI: demo://sessions
```
