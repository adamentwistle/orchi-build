"""Orchi's state folder, and everything `orchi` keeps in it.

The folder is named here and nowhere else: ~/.local/state/orchi, or $ORCHI_STATE. It holds

  lock        held by a run of bare `orchi` for as long as it runs, so two runs never overlap
  state.json  the last run of bare `orchi`: when, each step's result, whether it finished or was stopped
  owned.json  every file, link and folder a step created, so uninstall removes only those
  backups/    one folder per run, with a copy of each thing a step changed, under its full path

Nothing is written until a run of bare `orchi` needs to. Doctor only ever reads.
"""
import contextlib
import fcntl
import json
import os
import shutil
import signal
import tempfile
import threading
import time
from pathlib import Path

STATE_DIR = "~/.local/state/orchi"


def now():
    """The local time, for the records here."""
    return time.strftime("%Y-%m-%dT%H:%M:%S%z")


def state_dir():
    return Path(os.path.abspath(os.path.expanduser(os.environ.get("ORCHI_STATE") or STATE_DIR)))


class Busy(Exception):
    """Another run holds the lock."""

    def __init__(self, pid=None):
        self.pid = pid
        super().__init__(f"Another orchi run is going (pid {pid})." if pid else "Another orchi run is going.")


class StoreError(Exception):
    """A file in the state folder can't be read, so it is left alone rather than written over."""


def full(path):
    """A path made absolute without following links, since a link's own path is what a step makes."""
    return Path(os.path.abspath(os.fspath(path)))


def replace_file(path, data, new=False, mode=None):
    """Write a file whole: a temporary file beside it, then a rename, so a stop part way leaves the old file or the
    new one, never half of one. The file gets mode, else an existing file's permissions, else 644. With new set, the
    file must not be there yet: it is linked into place rather than renamed, which raises FileExistsError if something
    got there first."""
    path = full(path)
    data = data.encode() if isinstance(data, str) else data
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        if mode is not None:
            os.chmod(tmp, mode)
        elif not new and path.exists() and not path.is_symlink():
            os.chmod(tmp, path.stat().st_mode & 0o7777)
        else:
            os.chmod(tmp, 0o644)
        if new:
            try:
                os.link(tmp, path)
            except FileExistsError:
                raise
            except OSError:
                # No hard links here: take the name with an empty file first, so it still fails if taken.
                os.close(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644))
                os.replace(tmp, path)
            else:
                os.unlink(tmp)
        else:
            os.replace(tmp, path)
    except BaseException:
        with contextlib.suppress(OSError):
            os.unlink(tmp)
        raise


@contextlib.contextmanager
def shielded():
    """Hold Ctrl-C back until the block ends, so a change and its record are written together."""
    if threading.current_thread() is not threading.main_thread():
        yield
        return
    caught = []
    old = signal.signal(signal.SIGINT, lambda *how: caught.append(how))
    try:
        yield
    finally:
        signal.signal(signal.SIGINT, old)
        if caught and callable(old):
            old(*caught[0])
        elif caught and old == signal.SIG_DFL:
            signal.raise_signal(signal.SIGINT)


class Store:
    def __init__(self, root=None):
        self.root = Path(root) if root else state_dir()
        self.backup_dir = None
        self._backed_up = {}
        # owned.json, read once: while a run holds the lock, only this Store writes it.
        self._records = None

    # The lock

    @contextlib.contextmanager
    def lock(self):
        """Hold the lock for a run of bare `orchi`, or raise Busy. The system lets it go when the process ends, however
        it ends, so a lock left by a killed run is simply taken."""
        self.root.mkdir(parents=True, exist_ok=True)
        fd = self._open_lock(os.O_RDWR | os.O_CREAT)
        try:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise Busy(_holder(fd)) from None
            os.ftruncate(fd, 0)
            os.pwrite(fd, f"{os.getpid()}\n".encode(), 0)
            yield
        finally:
            os.close(fd)

    @contextlib.contextmanager
    def peek(self):
        """Share the lock for doctor, or raise Busy while a run holds it. With no lock file there is nothing to wait
        for, and nothing is created."""
        try:
            fd = self._open_lock(os.O_RDONLY)
        except FileNotFoundError:
            yield
            return
        try:
            try:
                fcntl.flock(fd, fcntl.LOCK_SH | fcntl.LOCK_NB)
            except BlockingIOError:
                raise Busy(_pid(fd)) from None
            yield
        finally:
            os.close(fd)

    def _open_lock(self, flags):
        """The lock file, never through a link, which could point the pid write at any file."""
        try:
            return os.open(self.root / "lock", flags | os.O_NOFOLLOW, 0o644)
        except OSError as e:
            if os.path.islink(self.root / "lock"):
                raise StoreError(f"{self.root / 'lock'} is a link; a lock must be a plain file") from None
            raise

    # The record of runs

    def last_run(self):
        """The last run of bare `orchi`, or None when there was none or its record can't be read."""
        try:
            data = self._read("state.json")
        except StoreError:
            return None
        return data if isinstance(data, dict) else None

    def save_run(self, record):
        self.root.mkdir(parents=True, exist_ok=True)
        replace_file(self.root / "state.json", json.dumps(record, indent=2, ensure_ascii=False) + "\n")

    # Ownership records

    def owned(self):
        """Every record: {"path", "kind" (file, link or folder), "step", "at", "id"}. "id" is what was there when Orchi
        made or last changed it, so something put in its place since is not taken for Orchi's."""
        if self._records is None:
            data = self._read("owned.json")
            records = data.get("owned") if isinstance(data, dict) else [] if data is None else None
            if not isinstance(records, list) or not all(isinstance(r, dict) and isinstance(r.get("path"), str)
                                                        for r in records):
                raise StoreError(f"{self.root / 'owned.json'} can't be read: not a list of records")
            self._records = records
        return list(self._records)

    def owns(self, path):
        """Whether what is at path now is what Orchi made there."""
        path = full(path)
        record = next((r for r in self.owned() if r["path"] == str(path)), None)
        if record is None or kind(path) != record.get("kind"):
            return False
        now = _identity(path, record.get("kind"))
        return now is not None and record.get("id") == now

    def own(self, path, kind, step):
        """Record what is at path now as Orchi's, replacing any older record for it."""
        path = full(path)
        records = [r for r in self.owned() if r["path"] != str(path)]
        records.append({"path": str(path), "kind": kind, "step": step, "at": now(),
                        "id": _identity(path, kind)})
        self._save_owned(records)

    def disown(self, path):
        path = str(full(path))
        records = self.owned()
        if any(r["path"] == path for r in records):
            self._save_owned([r for r in records if r["path"] != path])

    def _save_owned(self, records):
        self.root.mkdir(parents=True, exist_ok=True)
        replace_file(self.root / "owned.json", json.dumps({"owned": records}, indent=2, ensure_ascii=False) + "\n")
        self._records = list(records)

    # Backups

    def backup(self, path):
        """Copy what is at path into this run's backup folder, under its full path, once per run. A link is kept as a
        link and a folder is copied whole. Returns the copy, or None when nothing is there."""
        path = full(path)
        if not os.path.lexists(path):
            return None
        if str(path) in self._backed_up:
            return self._backed_up[str(path)]
        for above in path.parents:
            if str(above) in self._backed_up and not self._backed_up[str(above)].is_symlink():
                # Already copied this run with the folder above it, before anything changed it.
                return self._backed_up[str(above)] / path.relative_to(above)
        if self.backup_dir is None:
            self.backup_dir = self._new_backup_dir()
        copy = self.backup_dir / str(path).lstrip("/")
        here = copy.parent
        while here != self.backup_dir:
            if here.is_symlink():
                raise StoreError(f"{path} can't be backed up: {here} in this run's backup is a link")
            here = here.parent
        copy.parent.mkdir(parents=True, exist_ok=True)
        if path.is_symlink():
            os.symlink(os.readlink(path), copy)
        elif path.is_dir():
            # Something inside may already be copied this run, from before it changed: that copy stays.
            shutil.copytree(path, copy, symlinks=True, dirs_exist_ok=True, copy_function=_copy_new)
        else:
            shutil.copy2(path, copy)
        self._backed_up[str(path)] = copy
        return copy

    def _new_backup_dir(self):
        base = self.root / "backups"
        base.mkdir(parents=True, exist_ok=True)
        stamp = time.strftime("%Y-%m-%dT%H-%M-%S")
        for n in range(1, 1000):
            folder = base / (stamp if n == 1 else f"{stamp}-{n}")
            try:
                folder.mkdir()
                return folder
            except FileExistsError:
                continue
        raise StoreError(f"{base}: no free name for this run's backup")

    def _read(self, name):
        try:
            with open(self.root / name, encoding="utf-8") as f:
                return json.load(f)
        except FileNotFoundError:
            return None
        except (OSError, ValueError) as e:
            raise StoreError(f"{self.root / name} can't be read: {e}") from None


def _identity(path, kind):
    """What tells one file, link or folder from another put at the same path: its device and inode, and for a file
    or link its size and modification time too, since a file system may give a new file a deleted one's inode. A
    change of mode, extended attributes or links leaves these alone, so it doesn't change whose a file is. A folder's
    modification time moves whenever something is added to it, so a folder is known by device and inode alone. None
    when nothing is there."""
    try:
        info = os.lstat(path)
    except OSError:
        return None
    if kind == "folder":
        return [info.st_dev, info.st_ino]
    return [info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns]


def _copy_new(source, destination):
    if not os.path.lexists(destination):
        shutil.copy2(source, destination)


def kind(path):
    """file, link or folder, or None when nothing is there."""
    if path.is_symlink():
        return "link"
    if path.is_dir():
        return "folder"
    return "file" if os.path.lexists(path) else None


def _holder(fd):
    """The pid of the run holding the lock, or None when doctor holds it, since doctor writes no pid and the one in
    the file is then an earlier run's."""
    try:
        fcntl.flock(fd, fcntl.LOCK_SH | fcntl.LOCK_NB)
    except BlockingIOError:
        return _pid(fd)
    fcntl.flock(fd, fcntl.LOCK_UN)
    return None


def _pid(fd):
    """The pid written in the lock file, or None."""
    try:
        text = os.pread(fd, 32, 0).decode().strip()
        return int(text) if text.isdigit() else None
    except (OSError, ValueError):
        return None
