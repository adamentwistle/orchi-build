# Native checklist

Checked by hand. Playwright drives the app through the `wails dev` browser
bridge, so nothing beyond the WebView is covered by the specs. Edit this list
for this app; delete lines that do not apply.

- [ ] App menu: every item opens, and its keyboard shortcut works.
- [ ] Native dialogs: open and save dialogs appear, cancel leaves no change.
- [ ] Window state: size and position survive a restart; minimise and restore work.
- [ ] Tray or menu bar item: appears, its menu works, quitting from it quits the app.
- [ ] Notifications: permission prompt on first use, clicking one focuses the app.
- [ ] Dock icon and badge (macOS): badge count updates, clicking the icon restores the window.
- [ ] Global hotkeys: fire when the app is not focused.
