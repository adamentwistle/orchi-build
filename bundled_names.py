"""The words no bundled skill may hold: a person, an employer, work tools and rules, a home folder, a private plan's
numbered decisions, and projects that are not Orchi's own. bin/tests and pkgtests both read this one pattern."""
import re

NAMES = re.compile(
    r"\bAdam\b|entwistle|quic?k?node|\baae\b|\.claude[-]work|/Users/|/home/[a-z]|~/Projects|\blegwork\b|bugbot|"
    r"\bdecisions?\b[ ]+\d|\bHermes\b|\bSupabase\b|filter-branch|secret-sweep|\bThomas\b|\bLinear ticket\b",
    re.I,
)
