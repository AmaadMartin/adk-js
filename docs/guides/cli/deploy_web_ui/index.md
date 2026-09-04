# Deploying with ADK Web

`adk deploy` builds a container that serves your agent. The `--with_ui` flag decides whether that container also serves ADK Web, the developer user interface. Reach for it when you want a hosted place to try an agent by hand, and leave it off for anything a real client calls.

## Introduction

ADK Web is a development tool. It lists every agent in the deployment, opens any session, and reads every event and artifact those sessions hold. That is the point during development and a hazard in production: whoever reaches the deployed URL reaches all of it. The container has no separate login for the UI, so the deployment's own access control is the only thing in front of it.

The flag picks the command the generated Dockerfile runs. With `--with_ui` the container starts `adk web`; without it the container starts `adk api_server`, which serves the same HTTP API and no UI. Nothing else in the image changes, so you can deploy the same agent both ways.

Because the choice is easy to make by accident, every deploy command prints a warning on stderr before it does any work:

```
WARNING: ADK Web is for development purposes. It has access to all data and should not be used in production.
```

The warning goes to stderr, not stdout, so a script that parses the deployment output is unaffected. adk-python prints the same line, from `_warn_if_with_ui`.

## Get started

Deploy without the UI. This is the default, so the flag is only shown here for contrast:

```bash
adk deploy cloud_run ./my_agent \
  --project my-project --region us-central1 --service_name my-agent
```

Deploy with the UI, and see the warning:

```bash
adk deploy cloud_run ./my_agent \
  --project my-project --region us-central1 --service_name my-agent \
  --with_ui
```

## Which commands accept it

`--with_ui` is available on `deploy cloud_run`, `deploy agent_engine` and `deploy reasoning_engine`. All three default to `false`, and all three print the warning when you set it.

adk-python offers the flag on `deploy cloud_run` and `deploy gke`. adk-js has no `deploy gke`, and its Agent Engine commands ship the same UI, so they warn as well.
