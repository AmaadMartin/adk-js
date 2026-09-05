# Cloud Run sandbox code execution

`CloudRunSandboxCodeExecutor` runs model-generated code through the guest
`sandbox` binary that the Cloud Run container runtime installs. Deploy this
sample to Cloud Run with sandboxes enabled to see it execute anything. Anywhere
else the binary is missing, and every run returns a result whose `stderr` says
so.

## Running

```bash
npm run build            # builds @google/adk and the CLI; needed once
npm run sample -- samples/code_executors/cloud_run_sandbox/agent.ts
```

## Trying it without Cloud Run

Point `SANDBOX_BIN` at a stand-in script that drops the `do` subcommand and any
flags, then runs the interpreter named last:

```bash
cat > /tmp/sandbox <<'EOF'
#!/bin/sh
shift
while [ "${1#--}" != "$1" ]; do shift; done
exec "$@"
EOF
chmod +x /tmp/sandbox
SANDBOX_BIN=/tmp/sandbox npm run sample -- samples/code_executors/cloud_run_sandbox/agent.ts
```

The stand-in gives you the argument handling and the stdin plumbing. It gives
you no isolation at all, so use it to check wiring and nothing else.
