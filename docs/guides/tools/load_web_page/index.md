# loadWebPage

Fetches a URL and returns the readable text of the page. Reach for it when an
agent must read a public web page, and you want the fetch to be safe to hand to
a model.

## Introduction

A model chooses the URL, so the URL is attacker-influenced. A naive fetch tool
therefore lets a prompt reach anything the agent's host can reach: the cloud
metadata endpoint, a database admin port on `localhost`, an internal service on
a private address. This class of bug is Server-Side Request Forgery (SSRF).

`loadWebPage` closes that path in three steps. It rejects any scheme other than
`http` and `https`, and rejects `localhost` and `*.localhost`. It rejects an
address that is not globally routable, including an IPv6 address that wraps a
non-global IPv4 target — `64:ff9b::169.254.169.254` reaches the metadata
endpoint on a network with NAT64. It then pins the connection to an address that
passed vetting, so the name cannot resolve to something else between the check
and the connection.

Two properties follow from pinning at the socket layer rather than rewriting the
URL to the IP: the `Host` header and the TLS certificate check still use the
hostname the caller wrote. Redirects are never followed, because a redirect is a
second URL that the first one chose.

Every failure to read a page returns `Failed to fetch url: <url>`, so a model
always receives a value it can act on. The one exception is a missing `parse5`,
which throws; see [Text extraction](#text-extraction).

## Get started

```ts
import {LlmAgent, LOAD_WEB_PAGE, loadWebPage} from '@google/adk';

// Call it directly.
const text = await loadWebPage('https://example.com/');

// Or let the model call it.
const agent = new LlmAgent({
  name: 'researcher',
  model: 'gemini-flash-latest',
  instruction: 'Answer questions by reading the pages the user names.',
  tools: [LOAD_WEB_PAGE],
});
```

## Choosing between the two vetting paths

Address vetting needs a local DNS resolution, and a proxy resolves the name
remotely instead. The two cannot both hold, so the path decides what is vetted:

|                   | Direct              | Through a proxy                   |
| ----------------- | ------------------- | --------------------------------- |
| Hostname target   | resolved and vetted | not vetted; the proxy resolves it |
| IP-literal target | vetted              | vetted                            |
| `localhost` names | rejected            | rejected                          |

The environment picks the path, as it does for the Python tool. `no_proxy` is
read first and wins. Otherwise `https_proxy` or `http_proxy` applies for the
URL's scheme, and `all_proxy` is the fallback. Lowercase and uppercase names
both count.

An `http` target goes to the proxy in absolute form. An `https` target opens a
`CONNECT` tunnel and runs TLS inside it. A `socks5://` proxy is not supported.

Set `proxy` per call to override the environment. Pass `null` to force the
direct, vetted path for a host you do not want a proxy to resolve:

```ts
// Route this one call through a proxy, whatever the environment says.
await loadWebPage('https://internal.example/', {
  proxy: 'http://proxy.example.test:8080',
});

// Resolve and vet this one call locally, whatever the environment says.
await loadWebPage('https://untrusted.example/', {proxy: null});
```

`LOAD_WEB_PAGE`, the tool the model calls, takes no options, so a model-chosen
URL follows whichever path the environment selects.

## Text extraction

`parse5` parses the body, and the tool then reads the text nodes in document
order. Each one is trimmed, the empty ones are dropped, and the rest are joined
with newlines. Comments and the contents of `<script>`, `<style>` and
`<template>` are left out. Finally the tool keeps only the lines with more than
three words, which removes titles, menu entries and other page furniture. A
page whose every line is shorter than that returns an empty string.

`parse5` is an optional peer dependency, so it is not installed with
`@google/adk`. Install it in an application that calls this tool:

```sh
npm install parse5
```

Without it, `loadWebPage` throws an error naming the package and this command.
That is the one failure it reports by throwing, because a missing parser is a
configuration problem rather than a page it could not read.

## Limits

The body is read into memory and is capped at 10 MiB; a larger response returns
the failure string rather than a truncated page.

Markup nested deeper than 256 elements returns the failure string too. `parse5`
builds the tree synchronously and its cost grows with the square of the nesting
depth, so 40,000 nested elements in 430 KiB take about 13 seconds during which
nothing else in the process runs. A page is chosen by a model, so that is a
denial of service worth refusing. Real documents are far shallower.

The whole call, including parsing and text extraction, is bounded by
`timeoutMs`.

The tool needs Node built-ins (`node:http`, `node:https`, `node:dns`), so it
does not run in a browser bundle.
