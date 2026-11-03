## atlas-150 UPDATE 2026-03-14 19:52
Merged 233 (tags now match without regard to case; mixed-case tags fold together on first launch, tests first), 237 (the importer reads exports that start with a byte-order mark, plus a review fix: an empty export now shows a message instead of a blank list) and 238 (ENG-47: reminders fire at the right hour after a clock change. Checked in 6 of 7 time zones, the half-hour zone not run because the test clock cannot shift by 30 minutes, and no doubled reminders in a simulated week). Still running: ENG-52 (deep folder import) and row 9 (tag cloud). ENG-49's review findings are still being checked.

## atlas-151 DECISION 2026-03-14 19:59
Attempted: ENG-52 option B is built as 240 and is in its gate. Imports now keep folders at any depth, proven with a 40-level export. Exports from one browser still lose their folder order: it writes sibling folders by date added, not by position, and the file has no position field.
Uncertain: whether to keep the file's order or sort sibling folders by name on import. Either way some people see their order change.
Options: A) Keep the file's order, and say on the import screen that one browser exports by date added. B) Sort sibling folders by name on import, with a setting to turn it off. C) Ask on every import. Not recommended, it adds a step for everyone.
Recommendation: A. It does what the file says, and a line of copy is cheaper than a setting. It builds on the depth fix from atlas-146.
Blocks: the import screen copy only. 240 merges either way once its gate and review pass.
Meanwhile: 240's review, then the tag cloud row and the release.

## atlas-152 CYCLE 2026-03-14 20:01
Context cycle after 9 merges. Still running across the cycle: the row 9 worker (pane tag-cloud) and 240's gate (pane w2:p3, the release pane). Open for you: atlas-151 (folder order on import, recommendation A).
Resume: /fanout atlas --resume
ANSWERED atlas-151: B (2026-03-14 20:10)

## atlas-163 UPDATE 2026-03-15 01:22
Merged 245. The preview check now measures the page preview cache: 40 ms for a cached preview against about 1.9 s for a fresh fetch, on a page of 50 bookmarks. It also fixed a bug where two previews for the same address could be saved side by side. Filed ENG-58 (Low): a page behind a login gets the login form as its preview. Filed ENG-59 (Low): the cache does not shrink after a bulk delete. The final v2.4.0 check run is going on a17c3e8.

## atlas-164 DECISION 2026-03-15 01:38
Attempted: v2.4.0 on main a17c3e8, which includes 240 (deep folder import), 243, 244 and 245. The gate passes. The full check run gives 41 OBSERVED, 0 FAILED, 6 NOT RUN, each NOT RUN with its reason (extension store signing, a second sync server, the phone share sheet). The server image builds and its smoke test passes. v2.4.0 is tagged locally only, on a17c3e8; nothing is pushed.
Zip: /tmp/atlas-build/Atlas-v2.4.0.zip (4.6 MB, sha256 856ef7e6077f8e6d5856aec2ab4e6098aa652e9007e7295756db52f52079fdcd).
Uncertain: the browser extension's manifest still says 2.3.2, so its store page would show the old number. The app and the server both report 2.4.0. Filed as ENG-60.
Options: A) Publish now with the extension as it is, and bump its manifest in 2.4.1. B) Bump the manifest first, then re-tag, rerun the check run and rebuild, about 25 minutes. C) Hold.
Recommendation: B. The store number is the one people see, and the rebuild is short.
Blocks: publishing v2.4.0, then 241 (your atlas-158 A) and the tag cloud.
Meanwhile: merging main into 241 and gating it, ready to merge once the tag is out.

## atlas-165 CYCLE 2026-03-15 01:58
Context cycle after the v2.4.0 build. Still running across the cycle: the 241 review fix (pane tag-merge). Open for you: atlas-164 (publish v2.4.0, recommendation B).
Resume: /fanout atlas --resume
ANSWERED atlas-164: A (2026-03-15 07:00)

## atlas-145 DECISION 2026-03-14 18:30
Attempted: the full check run for v2.4.0 on main 6c09d1f had 9 FAILED lines. The triage (PR 235) sorts them: 4 were a stale test server address (now fixed), 2 are ENG-49 (fixed in 234, merging now), and 3 are one real defect, filed as ENG-52 (High): an export with folders nested more than 8 deep loses everything below level 8, with no warning.
Uncertain: the release checklist wants a check report with no FAILED line, and ENG-52 keeps one check red until its fix is chosen (atlas-146).
Options: A) Release v2.4.0 with ENG-52 as a written known gap. B) Hold v2.4.0 until ENG-52 is fixed and proven.
Recommendation: B. Losing bookmarks without a word is worse than a late release, and the fix looks small.
Blocks: the v2.4.0 release DECISION (commit and zip).
Meanwhile: rerunning the import checks against the fixed test server.

## atlas-146 DECISION 2026-03-14 18:30
Attempted: ENG-52. The importer walks folders with a fixed stack of 8, a limit from the first version, and stops without a word when it fills.
Uncertain: whether to lift the limit or keep one and warn. Very deep trees are rare, and they make the sidebar hard to read.
Options: A) Keep the limit of 8 and move anything deeper into its level-8 parent, with a warning that lists the moved folders. B) Remove the limit: walk the tree without a fixed stack, and let the sidebar collapse past level 8. C) No fix now. Refuse imports deeper than 8 with a clear message.
Recommendation: B. Every bookmark stays where it was, and the sidebar change is small.
Blocks: the ENG-52 fix, and a fully green check report.
Meanwhile: nothing waits on this except that one check line.
ANSWERED atlas-145: B, and put ENG-52 first (2026-03-14 18:52)
ANSWERED atlas-146: B, with a note in the sidebar past level 8 (2026-03-14 18:52)
