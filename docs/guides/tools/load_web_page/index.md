# loadWebPage

Fetches a URL and returns the readable text of the page. Reach for it when an
agent must read a public web page, and you want the fetch to be safe to hand to
a model.

## Introduction

A model chooses the URL, so the URL is attacker-influenced. A naive fetch tool
therefore lets a prompt reach anything the agent's host can reach: the cloud
metadata endpoint, a database admin port on `localhost`, an internal service on
a private address. This class of bug is Server-Side Request Forgery (SSRF).

`loadWebPage` closes that path. It rejects any scheme other than `http` and
`https`, rejects `localhost` and `*.localhost`, and rejects an address that is
not globally routable — private, loopback, link-local, shared (CGNAT),
documentation, benchmarking, multicast, and reserved ranges. An IPv6 address
that wraps an IPv4 target is vetted by the IPv4 address inside it, because
`64:ff9b::169.254.169.254` reaches the metadata endpoint on a network with
NAT64. The whole 6to4 range `2002::/16` is rejected.

Vetting a name and then fetching it is not enough on its own: the name can
resolve again, to a different address, between the check and the connection.
`loadWebPage` resolves the name once and then pins the connection to an address
that passed vetting. The URL is never rewritten, so the `Host` header and the
TLS certificate check still use the hostname the caller wrote. When a name
resolves to several addresses, each is tried in turn until one answers.

Redirects are never followed, because a redirect is a second URL that the first
one chose. The tool never throws: every failure returns the string
`Failed to fetch url: <url>`, so a model always receives a value it can act on.

`LOAD_WEB_PAGE` is the same behaviour packaged as a `FunctionTool`. Give it to
an agent when you want the model to decide what to read.

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

A blocked target returns the failure string rather than raising:

```ts
await loadWebPage('http://[64:ff9b::169.254.169.254]/computeMetadata/v1/');
// 'Failed to fetch url: http://[64:ff9b::169.254.169.254]/computeMetadata/v1/'
```

## Timeout

Each attempt has a deadline. It defaults to 30 seconds and the request is
destroyed when it expires.

```ts
await loadWebPage('https://example.com/', {timeoutMs: 5000});
```

## Proxies

`loadWebPage` reads the usual proxy environment variables: `http_proxy`,
`https_proxy` and `all_proxy`, in the lowercase spelling first, then the
uppercase one. `no_proxy` exempts a host. An empty `no_proxy` exempts nothing, a
`*` exempts everything, and an entry matches a host that equals it or ends with
a dot and the entry. An entry written as an IPv4 block, such as `10.0.0.0/8`,
matches an IP-literal host inside that block.

An `http` target goes to the proxy in absolute form. An `https` target opens a
`CONNECT` tunnel and runs TLS inside it, with the certificate checked against
the target hostname. Credentials in the proxy URL are sent as
`Proxy-Authorization: Basic`.

One guarantee weakens when a proxy applies: the proxy resolves the name, so
there is no local address to vet. `loadWebPage` still rejects a blocked IP
literal, and still rejects `localhost` names, but it cannot vet a hostname that
only the proxy can resolve. A `socks5://` proxy is not supported and returns the
failure string.

## Limits

The body is read into memory and is capped at 10 MiB; a larger response returns
the failure string rather than a truncated page. The request asks for
`accept-encoding: identity`, so the response arrives uncompressed. Text
extraction strips `<script>`, `<style>` and comments, decodes HTML entities, and
keeps only lines of more than three words — short navigation fragments are
dropped.

The tool needs Node built-ins (`node:http`, `node:https`, `node:dns`), so it
does not run in a browser bundle.
