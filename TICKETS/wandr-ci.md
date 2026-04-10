# TICKET: GitHub Actions CI
## Priority: P1 — before public release
## Agent: wandr

---

## Problem

No CI. No way for contributors to know if a PR breaks the build. Open source credibility requires green badges.

## Solution

Create `.github/workflows/ci.yml` that runs on push and PR:

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  build-and-test:
    runs-on: ubuntu-latest

    services:
      redis:
        image: redis:7
        ports:
          - 6379:6379

    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
      - run: npm ci
      - run: npm run lint
      - run: npm run build
      - run: npm test
```

## Also Add

Badge in README.md, first line after the title:

```markdown
[![CI](https://github.com/YOUR_ORG/wandr/actions/workflows/ci.yml/badge.svg)](https://github.com/YOUR_ORG/wandr/actions/workflows/ci.yml)
```

## Files to Create/Modify

| File | Action |
|------|--------|
| `.github/workflows/ci.yml` | CREATE |
| `README.md` | ADD badge after title |

## Acceptance Criteria

- [ ] `.github/workflows/ci.yml` exists
- [ ] Runs lint, build, test on push to main and on PRs
- [ ] Redis service available for any tests that need it
- [ ] Badge added to README

## DO NOTs

- Do NOT add deployment steps — CI only
- Do NOT add secrets to the workflow (no Slack tokens needed for tests)
