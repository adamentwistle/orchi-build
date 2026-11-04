"""The orchi command with the settings and Herdr steps only, for tests that run it in a child process or a terminal. A
whole run also installs tools and loads a launch agent, which no test may do for real."""
import sys

from orchi import cli, herdr, steps, system

# Whatever the machine is, the steps are a Mac's.
system.platform = lambda: "darwin"
steps.steps = lambda: steps.core() + herdr.steps()
sys.exit(cli.main(sys.argv[1:]))
