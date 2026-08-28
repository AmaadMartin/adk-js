# ADK Developer Guides

This directory contains specific developer guides for the ADK JavaScript and
TypeScript implementation. For the official ADK documentation, visit
[adk.dev](https://adk.dev/).

## Index

### Agents

- [Agent info](agents/agent_info/index.md) - Flattening an agent tree into
  per-agent metadata, with resolved tool declarations, so a host can describe an
  app without running it.
- [BasePlanner](agents/planner/index.md) - Making an agent plan before it
  answers, and marking its reasoning as thought parts.

### Evaluation

- [BaseEvalService](evaluation/eval_service/index.md) - The two-phase eval
  contract: run the agent over an eval set, then score the results.
