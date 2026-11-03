"""Where Orchi's shipped content (mods, themes, skills, scripts and the rest) lives."""
from pathlib import Path


def data_dir():
    """The folder that holds mods/, themes/, skills/ and the other content folders.

    An installed wheel carries them in `orchi/data` beside this file. A source
    checkout keeps them at the repository root, three levels above this file
    (`src/orchi/paths.py`).
    """
    package = Path(__file__).resolve().parent
    packaged = package / "data"
    if packaged.is_dir():
        return packaged
    checkout = package.parent.parent
    if (checkout / "mods").is_dir():
        return checkout
    raise FileNotFoundError("orchi's content folders were not found beside %s" % package)
