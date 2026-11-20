# AGENTS.md

Notes for coding agents working in this repository. [README.md](README.md) covers what it does and how to use it.

## Versioning

Plain SemVer: `vX.Y.Z` tags, each publishing the package to npm at version `X.Y.Z`, per the [versioning standard](https://github.com/mbologna/.github/blob/main/VERSIONING.md).

- Never create, move or delete tags, and never edit a version number to cut a release: auto-release tags from the commit types (`feat` minor; `fix`, `perf`, `revert` patch; `!` or a `BREAKING CHANGE:` footer major).
- Write Conventional Commit subjects; they decide the next version.
- `publish.yml` sets the published version from the tag (`npm version`), so `version` in `package.json` never decides a release. It is brought up to the latest release by hand after the tag, in a `chore` commit such as `chore: set the package version to the 1.5.0 release`.
