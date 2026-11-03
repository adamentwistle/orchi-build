"""What the Mac does with sh, ls, mkdir, cp, rm, sleep, osascript and zsh, done for Windows. Run as `python -I -S win.py
<command> ...`, standard library only. Each command prints its answer to stdout.

  session <pid> <dir>...      The Claude Code session under a terminal. On Windows `hc get` names the shell as the
                              foreground process, not Claude Code, so this looks for <dir>/sessions/<pid>.json for every
                              process started under the terminal's. Prints {"dir", "text"} for the newest, or null.
  locate <dir> <id>           The newest <dir>/projects/*/<id>.jsonl, or nothing.
  mkdir <path>                Makes a folder and its parents.
  copy <from> <to>            Copies a file.
  remove <path>               Deletes a file, and says nothing if it's gone.
  sleep <seconds>             Waits.
  clipboard <path>            Saves the clipboard's image as a PNG at <path>. Prints ok or none.
  headless <line> <arg>...    Runs claude with <arg>s, <line> on its standard input, and passes on its output and code.
  tracker <dir>               A legwork tracker's projects, as the Mac's awk prints them: per project a line
                              `@@projects/<file>.md`, its frontmatter, then its next prompt between `@@prompt` and
                              `@@endprompt`.
  list <dir>                  The names in a folder, one a line, or nothing when it isn't there.
  copy-text <text>            Puts the text on the clipboard, as pbcopy does.

The same file sits in each mod that runs it, because a mod can't read outside its folder.
"""
import json
import os
import shutil
import subprocess
import sys
import time


def processes():
    """Every running process's parent, by pid, from a Toolhelp snapshot."""
    import ctypes
    from ctypes import wintypes

    class Entry(ctypes.Structure):
        _fields_ = [("dwSize", wintypes.DWORD), ("cntUsage", wintypes.DWORD), ("th32ProcessID", wintypes.DWORD),
                    ("th32DefaultHeapID", ctypes.c_void_p), ("th32ModuleID", wintypes.DWORD), ("cntThreads", wintypes.DWORD),
                    ("th32ParentProcessID", wintypes.DWORD), ("pcPriClassBase", ctypes.c_long), ("dwFlags", wintypes.DWORD),
                    ("szExeFile", ctypes.c_wchar * 260)]

    k = ctypes.WinDLL("kernel32", use_last_error=True)
    k.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
    k.CreateToolhelp32Snapshot.argtypes = [wintypes.DWORD, wintypes.DWORD]
    k.Process32FirstW.argtypes = k.Process32NextW.argtypes = [wintypes.HANDLE, ctypes.POINTER(Entry)]
    k.CloseHandle.argtypes = [wintypes.HANDLE]
    snap = k.CreateToolhelp32Snapshot(0x2, 0)
    if snap in (None, wintypes.HANDLE(-1).value):
        return {}
    parents = {}
    try:
        e = Entry()
        e.dwSize = ctypes.sizeof(Entry)
        ok = k.Process32FirstW(snap, ctypes.byref(e))
        while ok:
            parents[e.th32ProcessID] = e.th32ParentProcessID
            ok = k.Process32NextW(snap, ctypes.byref(e))
    finally:
        k.CloseHandle(snap)
    return parents


def descendants(root, parents):
    """`root` and every process started under it. A pid that came round again can point back up the tree, so each is
    visited once."""
    children = {}
    for pid, parent in parents.items():
        if pid != parent:
            children.setdefault(parent, []).append(pid)
    seen, todo = [], [root]
    while todo:
        pid = todo.pop()
        if pid in seen:
            continue
        seen.append(pid)
        todo.extend(children.get(pid, []))
    return seen


def newest_session(pids, dirs):
    best = None
    for d in dirs:
        for pid in pids:
            try:
                with open(os.path.join(d, "sessions", f"{pid}.json"), encoding="utf-8") as f:
                    text = f.read()
                updated = json.loads(text).get("updatedAt") or 0
            except (OSError, ValueError, AttributeError):
                continue
            if best is None or updated > best[0]:
                best = (updated, {"dir": d, "text": text})
    return best[1] if best else None


def session(pid, *dirs):
    print(json.dumps(newest_session(descendants(int(pid), processes()), dirs)))


def locate(d, sid):
    root = os.path.join(d, "projects")
    found = []
    try:
        for name in os.listdir(root):
            path = os.path.join(root, name, sid + ".jsonl")
            if os.path.isfile(path):
                found.append((os.path.getmtime(path), path))
    except OSError:
        pass
    if found:
        print(max(found)[1].replace("\\", "/"))


def mkdir(path):
    os.makedirs(path, exist_ok=True)


def copy(src, dst):
    shutil.copyfile(src, dst)


def remove(path):
    try:
        os.remove(path)
    except FileNotFoundError:
        pass


def sleep(seconds):
    time.sleep(float(seconds))


# Windows PowerShell is always there, and its Forms clipboard reads a screenshot, a copied image or a browser's PNG.
CLIPBOARD = r"""Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$i = [Windows.Forms.Clipboard]::GetImage()
if ($i) { $i.Save($args[0], [Drawing.Imaging.ImageFormat]::Png); 'ok' } else { 'none' }"""


def clipboard(path):
    shell = os.path.join(os.environ.get("SystemRoot", r"C:\Windows"), "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    script = "& {" + CLIPBOARD + "} '" + path.replace("'", "''") + "'"
    r = subprocess.run([shell, "-STA", "-NoProfile", "-NonInteractive", "-Command", script], capture_output=True, text=True,
                       creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    print("ok" if r.returncode == 0 and r.stdout.strip() == "ok" else "none")


def headless(line, *args):
    claude = shutil.which("claude")
    if not claude:
        sys.exit(127)
    r = subprocess.run([claude, *args], input=line + "\n", capture_output=True, text=True, encoding="utf-8",
                       creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    sys.stdout.write(r.stdout)
    sys.exit(r.returncode)


def tracker(d):
    """The same text as the Mac's awk over projects/*.md: the first line is taken as the frontmatter's opening `---`,
    the frontmatter runs to the next `---`, and the next prompt is the first fenced block under `## Next prompt`."""
    folder = os.path.join(d, "projects")
    try:
        names = sorted(n for n in os.listdir(folder) if n.endswith(".md"))
    except OSError:
        sys.exit(1)
    out = []
    for name in names:
        try:
            with open(os.path.join(folder, name), encoding="utf-8", errors="replace") as f:
                lines = f.read().splitlines()
        except OSError:
            continue
        out.append(f"@@projects/{name}")
        front, in_prompt, fence = True, False, False
        for line in lines[1:]:
            if front:
                if line == "---":
                    front = False
                else:
                    out.append(line)
                continue
            if line.startswith("## Next prompt"):
                in_prompt = True
                continue
            if in_prompt and line.startswith("```"):
                if fence:
                    in_prompt, fence = False, False
                    out.append("@@endprompt")
                else:
                    fence = True
                    out.append("@@prompt")
                continue
            if in_prompt and fence:
                out.append(line)
    print("\n".join(out))


def list_folder(d):
    try:
        names = sorted(os.listdir(d))
    except OSError:
        return
    if names:
        print("\n".join(names))


# The text goes as Base64 inside the script, so nothing in it can be read as PowerShell.
def copy_text(text):
    import base64
    shell = os.path.join(os.environ.get("SystemRoot", r"C:\Windows"), "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    encoded = base64.b64encode(text.encode("utf-8")).decode("ascii")
    script = f"Set-Clipboard -Value ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('{encoded}')))"
    r = subprocess.run([shell, "-STA", "-NoProfile", "-NonInteractive", "-Command", script], capture_output=True,
                       creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    sys.exit(r.returncode)


COMMANDS = {"session": session, "locate": locate, "mkdir": mkdir, "copy": copy, "remove": remove, "sleep": sleep,
            "clipboard": clipboard, "headless": headless, "tracker": tracker, "list": list_folder, "copy-text": copy_text}

if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        # LF, not Windows' CRLF: the mods split replies on "\n".
        sys.stdout.reconfigure(encoding="utf-8", newline="\n")
    if len(sys.argv) < 2 or sys.argv[1] not in COMMANDS:
        sys.exit("usage: win.py " + "|".join(COMMANDS) + " ...")
    COMMANDS[sys.argv[1]](*sys.argv[2:])
