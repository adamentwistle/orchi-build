---
description: Run the review loop on a pull request until it is clean. Bugbot where the repo has it, else /code-review. Fix, push, go round, max three rounds.
---

Review loop for pull request: $ARGUMENTS (a PR number, or blank to use the
PR for the current branch via `gh pr view --json number -q .number`).

The review is Bugbot when the repo has it, otherwise Claude Code's
`/code-review` skill. `bugbot-wait` asks GitHub which: Bugbot is enabled
when it has run or reviewed on any of the repo's last 20 pull requests.

Bugbot is Cursor's reviewer. It posts a review as login `cursor`; findings
arrive as inline review comments, a clean run says "found no new issues".
The poll is a script, not a hand-rolled sleep loop, and it runs in the
foreground. Never use Monitor or a background task for this; they have
missed verdicts before.

Steps, per round (max 3 rounds):
1. Trigger and wait in one call with `bugbot-wait` from `<orchi_dir>/bin/`
   (`orchi_dir` in Orchi's settings):
   `bugbot-wait <pr> --trigger --timeout 1200`
   If a verdict may already exist for the current head, run
   `bugbot-wait <pr> --after <ISO time of the last push> --timeout 60` first.
2. Read the JSON it prints.
   - `CLEAR`: go to step 6.
   - `TIMEOUT`: stop. Report that Bugbot did not answer; do not retrigger blindly.
   - `NO_BUGBOT`: Bugbot is not enabled on the repo. Nothing was posted;
     do not wait, retrigger or post a "bugbot run" comment by hand. Go to
     step 5 and use `/code-review` for the rest of the loop.
   - `FINDINGS`: go to step 3.
3. For each item in `comments`, open the file at the line, decide whether
   the finding is real. Fix the real ones. For a finding you reject, reply
   on that review comment with one sentence saying why (as me, plain text,
   no attribution). Do not argue in the PR description.
4. Run the repo's gate if it has one (`scripts/pr-gate.sh`, else the test
   command in the README). Commit with a plain message, no trailer, no
   co-author. Push the branch. Never push to main. Next round:
   `bugbot-wait <pr> --trigger --timeout 1200`, then step 2.
5. Without Bugbot: run the `/code-review` skill on the pull request
   (`/code-review <pr>`). If it reports no findings, go to step 6. Otherwise
   fix every finding it reports, run the gate, commit and push as in step 4,
   and run `/code-review <pr>` again. When it reports none, go to step 6;
   after three rounds, stop with the findings left.
6. Clean: request the reviewers the repo's AGENTS.md names:
   `gh pr edit <pr> --add-reviewer <logins>`, leaving out the PR's author
   and anyone already requested (skip if AGENTS.md names none). Then stop.
   Report the review time and the commit it reviewed (for Bugbot), and who
   was requested.

After the loop, reply with: which review ran (Bugbot or `/code-review`), final
state (CLEAR, FINDINGS left or TIMEOUT), rounds used, what was fixed, and each
rejected Bugbot finding with its reason. Findings still open after round 3 are
listed, not fixed.
