---
description: Land the current work. Commit, push the branch, open or refresh the pull request, run the review loop (/pr-review) until clean, then /wrap.
---

Ship what is in the working tree, then close the session.
Project for the tracker: $ARGUMENTS if given, otherwise infer it from the repo.

Rules that apply to every step: author everything as me. No attribution
trailer, no co-author line, no mention of Claude or any agent in commits,
PR bodies or comments. Work lands on a branch through a pull request,
never by pushing to main. `gh` here means the command `github.command` names in Orchi's settings, such as `gh-personal`. Plain `gh` may be another account that can't see the repo.

Steps:
1. `git status --short` and `git diff --stat`. Stage only the files this
   session changed on purpose; never `git add -A`. Anything unexpected
   stays unstaged and is named in the final reply.
2. If the current branch is `main`, `master` or `release`: stop and say so.
   Do not create a branch and move the work silently; ask which branch name
   to use.
3. Commit with an honest message describing what changed and why. Plain
   message, no trailer.
4. Push to the branch's upstream (`git push -u origin HEAD` if none). If the
   push would need `--force`, stop and ask.
5. Pull request. If `gh pr view` finds none for this branch, draft the body
   with the pr-drafter skill (TL;DR first, ticket IDs linked, every
   Verification line marked OBSERVED, STALE or NOT RUN, voice-sweep run on
   the file) and open it with `gh pr create`. The body and commit messages
   go out without me seeing them first. Reviewers: request none at open (no `--reviewer`);
   /pr-review requests the ones the repo's AGENTS.md names once it is clean
   on the current head. Never request the PR's author. If one exists,
   update the body only if the change set moved beyond what it describes.
6. Run /pr-review for that PR. It reviews with Bugbot where the repo has
   it, else with /code-review, fixes real findings, pushes, and goes round
   again, up to three rounds.
7. Run /wrap for the project. The log entry names the PR, which review ran
   and its state.
8. Reply in three lines: PR URL and branch; review, state and rounds;
   what /wrap minted as the next prompt.
