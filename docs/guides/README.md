# ADK Developer Guides

This directory contains specific developer guides for the ADK TypeScript
implementation. For the official ADK documentation, visit
[adk.dev](https://adk.dev/).

## Index

### Context

- [BaseSummarizer](context/summarizer/index.md) - The strategy a context compactor uses to summarize a window of events, and how a summarizer declines to compact.
- [LlmSummarizer](context/llm_summarizer/index.md) - The built-in summarizer: what it puts in the prompt, how it renders tool traffic, and what the compacted event carries.
