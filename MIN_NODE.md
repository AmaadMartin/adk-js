# Minimum Node.js version

**Node.js 20.19** or newer.

Source — `README.md:55`:

> **Prerequisite:** ADK for TypeScript requires Node.js 20.19 or newer.

This is the only statement of the minimum in the repo. Note that no `package.json`
declares an `engines` field — not the root manifest nor the `core`, `dev`, or
`integrations` workspaces — so the requirement is documented but not enforced at
install time.
