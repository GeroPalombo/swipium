# Contributing

Contributions are welcome, but all changes must be reviewed and approved by the maintainer before they are merged.

## Before You Start

Open an issue before starting large work, changing public tool behavior, adding dependencies, or expanding the v1 scope.

Small fixes, tests, documentation improvements, and clear bug reports can be submitted directly as pull requests.

## Development Setup

Requirements:

- Node.js 20 or newer.
- npm.
- Android Studio and/or Xcode only when testing simulator workflows.

Install dependencies:

```bash
npm ci
```

Run checks:

```bash
npm run typecheck
npm test
npm run audit:prod
```

Before a release-oriented change, run:

```bash
npm run release:check
```

## Pull Requests

Pull requests should:

- Keep changes focused.
- Include tests for behavior changes.
- Avoid unrelated formatting or refactors.
- Avoid committing generated local state, private planning docs, credentials, logs, simulator artifacts, or `.swipium` data.
- Update public documentation when user-facing behavior changes.

The maintainer may request changes, close stale PRs, or decline work that does not fit the current release scope.

## Code Standards

- Prefer small, explicit changes over broad abstractions.
- Keep public tool behavior stable and documented.
- Do not inline secrets in tests, generated artifacts, or examples.
- Use consent gates for mutating actions.
- Keep simulator-focused v1 behavior separate from experimental or future real-device work.

## Security

Do not report vulnerabilities in public issues or pull requests. Follow `SECURITY.md` and contact hi@swipium.com.
