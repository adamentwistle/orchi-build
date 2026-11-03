# Notices

Orchi is MIT licensed (see LICENSE). These parts come from other projects and keep their own licences.

## The Linear panel

`mods/linear/` (`open.js`, `urls.js`, `mod.json`, `linear.js`, `main.js`), `keys/linear.json` and
`tests/linear/linear.test.mjs` and `tests/linear/task.test.mjs` started from
[dantech99/herdr-linear](https://github.com/dantech99/herdr-linear). `linear.js` and `main.js` are much changed.

```
MIT License

Copyright (c) 2026 dantech99

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## The planner task

`mods/linear-agent/` started from the `issue-agent` mod in
[obrunogonzaga/herdr-mods](https://github.com/obrunogonzaga/herdr-mods).
Portions Copyright (c) 2026 Bruno Gonzaga, under the MIT licence above.

## Herdr

These files are changed copies of mods and a layout that ship with the Herdr desktop app, by
[Herdr](https://github.com/ogulcancelik/herdr), under the Apache License 2.0 (`LICENSES/Apache-2.0.txt`).

| File | From | What changed |
| --- | --- | --- |
| `mods/pane-header/main.js` | the shipped `pane` mod | A chat pane's header reads "Claude Code" and takes its terminal's folder and status, and a chat's unread count shows on both headers |
| `mods/orchi-chrome/main.js` | the shipped `workspace-chrome` mod | Orchi's name and mark in the sidebar in place of Herdr's |
| `mods/space-agents/main.js` | the shipped `spaces` and `agents` mods | One sidebar list: a Needs you inbox, fleet counts, and each space folding with its agents under it by status |
| `layouts/main-linear.json` | the shipped `main` layout | Orchi's mods in place of the shipped sidebar and header blocks |

## The Linear mark

`mods/linear/linear.svg` is Linear's logo, a trademark of Linear. It is used only to show that a panel or a ticket is
Linear's. Orchi is not made or endorsed by Linear.

## Sounds

`sounds/needs-you.mp3` and `sounds/done.mp3` are CC0 sounds from OpenGameArt. `sounds/README.md` credits them.
