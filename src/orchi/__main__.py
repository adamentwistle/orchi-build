"""Lets `python -m orchi` run the same command as `orchi`."""
from orchi.cli import main

if __name__ == "__main__":
    raise SystemExit(main())
