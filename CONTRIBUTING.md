# How to contribute

We'd love to accept your patches and contributions to this project.

## Before you begin

### Getting Started

To set up your local development environment for contributing:

1. **Clone the repository**:

   ```bash
   git clone https://github.com/google/adk-js.git
   cd adk-js
   ```

1. **Install dependencies**:

   ```bash
   npm install
   ```

1. **Build and test**: Ensure everything is working correctly:

   ```bash
   npm run build
   npm test
   ```

### Code Quality

To maintain high code quality and consistency:

1. **Linting**: Use ESLint to check for code quality issues.

   ```bash
   npm run lint
   ```

   To automatically fix some linting issues:

   ```bash
   npm run lint:fix
   ```

1. **Formatting**: Use Prettier for consistent code styling.

   ```bash
   npm run format
   ```

1. **Dependency declarations**: Check that every imported package is declared.

   ```bash
   npm run deps:check
   ```

   A failure means a file imports a package that no `package.json` between it
   and the repository root declares. It resolves here only because npm
   workspaces hoist a sibling workspace's copy into the root `node_modules`,
   and it will fail for anyone installing the published package. Fix it by
   adding the package to the `package.json` the report names.

   `scripts/phantom_deps_allowlist.json` records the violations that already
   existed when this check was introduced. They are being paid down, and the
   check also fails on an allowlist entry that no longer matches a real
   violation, so the list can only shrink. Do not add entries to it.

The project uses `husky` and `lint-staged` to automatically lint and format
your changes before each commit.

### Sign our Contributor License Agreement

Contributions to this project must be accompanied by a
[Contributor License Agreement](https://cla.developers.google.com/about)
(CLA). You (or your employer) retain the copyright to your contribution; this
simply gives us permission to use and redistribute your contributions as part
of the project.

If you or your current employer have already signed the Google CLA (even if it
was for a different project), you probably don't need to do it again.

Visit <https://cla.developers.google.com/> to see your current agreements or
to sign a new one.

### Review our community guidelines

This project follows
[Google's Open Source Community Guidelines](https://opensource.google/conduct/).

## Contribution process

### Code reviews

All submissions, including submissions by project members, require review. We
use GitHub pull requests for this purpose. Consult
[GitHub Help](https://help.github.com/articles/about-pull-requests/) for more
information on using pull requests.

## PR policy

### AI Generated code

It's ok to generate the first draft using AI but we would like code which has
gone through human refinement.

### TSDoc

We want our TSDocs to be concise and meaningful. Usually aligned with
adk-python.
