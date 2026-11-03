# 1. Pull request review: Bugbot when the repo has it, else /code-review

Accepted, 2026-11-03.

## Context

Every pull request Orchi's agents open gets a review loop before reviewers are asked and before it merges. The loop
was built on Cursor Bugbot, which only runs where its GitHub App is installed. On any other repo there was no review,
and a setting had to list the owners that had Bugbot.

## Decision

`/pr-review` runs the loop. It asks GitHub whether Bugbot runs on the repo: a `Cursor Bugbot` check run from the
`cursor` app, or a review by `cursor[bot]`, on any of the last 20 pull requests. If it does, the loop triggers Bugbot
and waits for its verdict. If not, the loop runs Claude Code's `/code-review` on the pull request. Either way it fixes
the findings, pushes and goes round again, at most three times.

## Consequences

- Every repo gets a review, with or without Bugbot, and there is nothing to configure.
- On a repo where Bugbot was only just installed, the first pull request can go to `/code-review`, because GitHub
  shows no Bugbot run yet. The next one finds it.
- `/code-review` runs on the user's own Claude usage; Bugbot runs on Cursor's.
