# 4. Reading tickets: one command, one reference, one shape

Accepted, 2026-11-03.

## Context

The Linear panel and the Orchi panel each read tickets their own way, and four copies of one regular expression
decided what a ticket ID was. Planning now reads four sources: legwork, GitHub Issues, Linear and Markdown task files.
Agents, the panels and the planning skills need one way to name a ticket and one way to read it.

## Decision

`orchi tickets` lists the open tickets of every chosen source, and `orchi tickets show <ref>` reads one ticket, open or
done. Both print plain lines, and `--json` gives agents the same. Nothing else reads tickets.

A ticket reference names its source: `linear:ENG-12`, `gh:owner/repo#12`, `legwork:<project>`, `md:<file>#<anchor>`.
A bare `ENG-12` reads as Linear. `src/orchi/refs.py` is the one parser; each mod that needs it carries the same
`refs.js`, and one fixture file proves the two agree, error messages included. The rules:

- A Linear key is `ENG-12`: a capital letter, up to nine more capitals or digits, a hyphen, and a number from 1 with
  no leading zero. Lower case is not a Linear key.
- GitHub owners and repos are compared without case, so the reference is written in lower case.
- A legwork project is its file name without `.md`. Names starting with `_`, such as `_template`, are not projects.
- A Markdown file is a full path, from `/` or `~/`, with no spaces, commas, `#`, control characters or `..`, ending in `.md`. The anchor is the
  task's anchor as below.

Each source, as a ticket:

- **Legwork**: each `projects/*.md` in `legwork_dir`. Its state is the `status:` line; `done` and `icebox` are not open.
- **GitHub**: the issues of each repo in `github.repos`, through the gh command `github.command` names (`gh` unless
  set, so a wrapper such as gh-personal works). Its state is `open` or `closed`.
- **Linear**: open issues in `linear.teams` or `linear.projects`, else the ones assigned to you, through Linear's
  GraphQL API with one API key. The key is `LINEAR_API_KEY` when that is set, for agents and tests, else the
  keychain's generic password under the service `orchi-linear`, read with `/usr/bin/security`. The key is never
  printed or logged; a refused key reads as "Invalid Linear API key".
- **Markdown**: each top-level task list item (`- [ ] ...`, `- [x] ...`) in the files `markdown.paths` names, or in
  the `.md` files directly inside the folders it names. Items inside code blocks are not tasks. A task's anchor is
  its text in lower case, with spaces made hyphens and anything but `a` to `z`, digits, `_` and `-` left out, then
  `-1`, `-2` added until no other task in the file has it; one with no letters left is `task`. Indented lines under an item are its
  body. A checked item is done. `show` reads only files those paths cover.

`--source <name>`, given once or more, is the sources for that one call: it can narrow the chosen ones or add one
settings leave out. Without it, the chosen sources are read, legwork always among them.

A source that fails, such as Linear with no key, is named on its own line and the others still list; the command then
exits 1. A list cut short, past 200 open issues in a GitHub repo or 2,000 from Linear, says so the same way. A
reference that can't be parsed exits 2; a ticket that isn't there exits 1.

The panels keep acting on Linear tickets only until the tickets panel replaces them. They now take `linear:ENG-12`
as well as `ENG-12`, and hold the bare key.

## Consequences

- Planning skills can say "run `orchi tickets`" and name no per-source tool.
- The keychain read and every network call sit behind one small function each (`keychain.find_password`,
  `linear.post`, `github.run`). Tests replace them with fakes, and the top conftest fails any test that starts the
  `security` binary or opens a socket off the computer.
- Writing tickets back, and `orchi tickets sync`, come later and use the same references.
