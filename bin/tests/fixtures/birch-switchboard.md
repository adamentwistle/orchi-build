## birch-17 DECISION 2026-03-14 19:26
Attempted: report 8 (build time on a large site). The page count flag is built and committed on the local branch report/build-time (b81f0a36, the tests pass). The first run on the 5,000-page sample failed: "image folder not found". Every page with a picture stops the build, so nothing was measured. One half-written output folder (out/report-8) is in the sample and can be deleted.
Uncertain: whether to time the build without images, or wait until the sample's images are on this machine.
Options: A) Run the build with images skipped (the --no-images flag), which still times pages and templates; image work is already timed in report 6. B) You copy the image folder over (about 3 GB) and the worker reruns. C) Park report 8 for a later run with the flag ready.
Recommendation: A, because it runs today and report 6 already covers the image half.
Blocks: report 8 only.
Meanwhile: report 7 is running on the small sample; the theme switcher PR is in its final gate run.

## birch-18 UPDATE 2026-03-14 19:30
Report 7 done: .legwork/roadmap-1/reports/incremental-build.md. On the 300-page sample, a one-page edit rebuilds 3 pages in 0.4 s and a template edit rebuilds all 300 in 6.1 s. Watch mode missed 2 of 50 saves made less than 100 ms apart. Side finding: a page whose title holds a colon gets an empty feed entry.
birch-17 on hold: the sample's images may be on this machine under another name, so report 8's missing folder is being re-checked before you need to act. Answer birch-17 only if it comes back BLOCKED again.

## birch-19 UPDATE 2026-03-14 19:46
PR 18 (theme switcher in the site header, remembers the choice) opened, gate PASS, Bugbot CLEAR on 3f6e2b19 at round 1. Its live check predates the last commit (the switcher moved to the right), so the worker is re-checking before I call it ready.

## birch-20 DECISION 2026-03-14 19:46
Replaces birch-17 (no need to answer birch-17).
Attempted: report 8 re-check. The images ARE on this machine, under the sample's old folder name (5,000 pages, 12,400 images). The config still pointed at the new name. The config fix is committed on the local branch only (7d4c0e21). Then the full build ran out of memory at page 3,900, and the worker stopped rather than raise the limit itself. I checked: nothing is left running and the build cache is intact.
