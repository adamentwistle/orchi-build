#!/bin/sh
# voice-sweep.sh -- sweep authored text before it leaves the machine.
#
# A PR body, a commit message and a review comment all go out under
# Adam's name, and the same four things have been caught in them
# before: a non-ASCII character (7 em dashes on one branch, 3 on
# another, ~150 in one README), a git trailer, an AI reference, an
# internal URL. Those rules live in skills/pr-drafter/SKILL.md, where a
# human reads them. This is the same rules made mechanical, so that
# "the text is clean" is something somebody ran rather than something
# somebody believed.
#
# Usage:
#   voice-sweep.sh FILE                sweep one authored text file
#   voice-sweep.sh --max-cols 72 FILE  long-line limit (default 120)
#   voice-sweep.sh --self-test         run the built-in cases
#
# Exit 0 clean, 1 something to fix or look at, 2 usage error.
#
# Two severities, because they deserve different answers. BLOCK is text
# with no defensible reason to be there: a smart quote, an em dash, a
# Co-Authored-By line, "generated with Claude", a grafana hostname.
# LOOK is a shape that is usually wrong and occasionally right: a bare
# product name in a change that is genuinely about that product, a
# trailer-shaped last block, a localhost URL, a long line inside pasted
# command output. A human settles those, and gets a line and a column
# to settle them from. Both severities exit 1, as secret-sweep.sh does,
# because both mean look before you send.
#
# It reads a named file rather than stdin on purpose. The text that
# goes out has to exist as a file anyway (gh pr create --body-file, git
# commit -F), and sweeping the exact file you will send is the point; a
# pipe lets the swept text and the sent text drift apart.
#
# This script is pure ASCII. Every non-ASCII character it hunts for is
# built from printf octal escapes at startup, so it never trips its own
# rules and stays readable in any editor. Do not point it at itself:
# it holds every pattern by definition.
#
# What it cannot do, said plainly. It matches bytes and shapes. It has
# no idea whether the writing is good, whether the five sections are
# present, or whether one word of the Verification section is true --
# that is the skill's job and a reader's. It does not parse markdown,
# so it cannot tell pasted command output inside a fence from prose,
# which is why long lines and trailer-shaped lines are LOOK. Its AI and
# internal-host lists are finite: they hold what has actually been
# caught plus the obvious neighbours, and a product nobody has written
# yet will walk straight through. Columns are byte offsets, not
# character offsets. A NUL byte cannot survive the read at all, so
# binary input is refused rather than swept. It is the floor under the
# habit, not a substitute for reading the draft out loud.
set -eu

# Byte-oriented from here down: awk must see bytes, not characters, or
# the column numbers stop meaning anything and the non-ASCII test
# stops firing.
LC_ALL=C
export LC_ALL

usage() {
  echo "voice-sweep: usage: voice-sweep.sh [--max-cols N] FILE" >&2
  echo "                    voice-sweep.sh --self-test" >&2
}

MAXCOLS=120
MODE=file
FILE=

while [ $# -gt 0 ]; do
  case "$1" in
    --self-test) MODE=selftest ;;
    --max-cols)
      shift
      [ $# -gt 0 ] || { usage; exit 2; }
      MAXCOLS=$1
      ;;
    --max-cols=*) MAXCOLS=${1#--max-cols=} ;;
    -h|--help) usage; exit 0 ;;
    -*) usage; exit 2 ;;
    *)
      [ -z "$FILE" ] || { usage; exit 2; }
      FILE=$1
      ;;
  esac
  shift
done

case "$MAXCOLS" in
  ''|*[!0-9]*) echo "voice-sweep: --max-cols wants a number" >&2; exit 2 ;;
esac
[ "$MAXCOLS" -gt 0 ] || { echo "voice-sweep: --max-cols wants a number above 0" >&2; exit 2; }

# The characters that get caught, built as bytes so this file stays
# ASCII. Each entry is (bytes to match, bytes to consume, what to say).
# The consume count differs from the match length for the two prefix
# families: box drawing is a 3-byte character matched on its 2-byte
# prefix, an emoji is 4 bytes matched on its 2-byte prefix.
EM=$(printf '\342\200\224')
EN=$(printf '\342\200\223')
LSQ=$(printf '\342\200\230')
RSQ=$(printf '\342\200\231')
LDQ=$(printf '\342\200\234')
RDQ=$(printf '\342\200\235')
ELL=$(printf '\342\200\246')
NBSP=$(printf '\302\240')
BULL=$(printf '\342\200\242')
ARR=$(printf '\342\206\222')
CHK=$(printf '\342\234\223')
CRS=$(printf '\342\234\227')
BOXA=$(printf '\342\224')
BOXB=$(printf '\342\225')
EMOJI=$(printf '\360\237')
CR=$(printf '\r')
# Control bytes, tab and newline excluded. NUL cannot be held in a
# shell variable and cannot reach here anyway; binary files are refused.
CTRL=$(printf '\001\002\003\004\005\006\007\010\013\014\016\017\020\021\022\023\024\025\026\027\030\031\032\033\034\035\036\037\177')

# emit_report LABEL MAXCOLS < text
# Writes one report line per finding to stdout, ordered by line then
# column. No exit logic: the caller decides what the findings mean.
emit_report() {
  awk -v label="$1" -v maxcols="$2" \
      -v EM="$EM" -v EN="$EN" -v LSQ="$LSQ" -v RSQ="$RSQ" \
      -v LDQ="$LDQ" -v RDQ="$RDQ" -v ELL="$ELL" -v NBSP="$NBSP" \
      -v BULL="$BULL" -v ARR="$ARR" -v CHK="$CHK" -v CRS="$CRS" \
      -v BOXA="$BOXA" -v BOXB="$BOXB" -v EMOJI="$EMOJI" \
      -v CR="$CR" -v CTRL="$CTRL" '
function addseq(bytes, consume, what) {
  nseq++
  seq[nseq] = bytes
  slen[nseq] = consume
  sname[nseq] = what
}

# Which named sequence starts at pos, or 0.
function named_at(s, pos,   k) {
  for (k = 1; k <= nseq; k++)
    if (substr(s, pos, length(seq[k])) == seq[k]) return k
  return 0
}

function store(sev, ln, col, msg) {
  nrep++
  rsev[nrep] = sev
  rln[nrep] = ln
  rcol[nrep] = col
  rmsg[nrep] = msg
}

# Report every match of pat in hay. adjust=1 means the pattern carries
# a leading boundary character that is not part of the offending text,
# so the column moves one to the right when one was consumed.
function scan(sev, ln, hay, pat, msg, adjust,   off, rest, col, m) {
  off = 0
  rest = hay
  while (match(rest, pat)) {
    if (RLENGTH < 1) return
    m = substr(rest, RSTART, RLENGTH)
    col = off + RSTART
    if (adjust && m !~ /^[a-z0-9]/) col++
    store(sev, ln, col, msg)
    off += RSTART + RLENGTH - 1
    rest = substr(rest, RSTART + RLENGTH)
  }
}

BEGIN {
  addseq(EM,   3, "em dash: write -- instead")
  addseq(EN,   3, "en dash: write - or -- instead")
  addseq(LSQ,  3, "left single quote: write a plain apostrophe")
  addseq(RSQ,  3, "right single quote: write a plain apostrophe")
  addseq(LDQ,  3, "left double quote: write a plain double quote")
  addseq(RDQ,  3, "right double quote: write a plain double quote")
  addseq(ELL,  3, "ellipsis character: write three dots")
  addseq(NBSP, 2, "non-breaking space: write a plain space")
  addseq(BULL, 3, "bullet character: write a markdown - list")
  addseq(ARR,  3, "arrow character: write -> instead")
  addseq(CHK,  3, "check mark: say what passed in words")
  addseq(CRS,  3, "cross mark: say what failed in words")
  addseq(BOXA, 3, "box-drawing character: draw it in ASCII or drop it")
  addseq(BOXB, 3, "box-drawing character: draw it in ASCII or drop it")
  addseq(EMOJI, 4, "emoji: say it in words")
  addseq(CR,   1, "carriage return: the file has CRLF line endings")

  TRAILER_KNOWN = "^[ \t]*(co-authored-by|co-committed-by|co-developed-by"
  TRAILER_KNOWN = TRAILER_KNOWN "|signed-off-by|generated-by|generated-with"
  TRAILER_KNOWN = TRAILER_KNOWN "|assisted-by|authored-by|helped-by"
  TRAILER_KNOWN = TRAILER_KNOWN "|reported-by|reviewed-by|suggested-by"
  TRAILER_KNOWN = TRAILER_KNOWN "|tested-by|acked-by|on-behalf-of"
  TRAILER_KNOWN = TRAILER_KNOWN "|change-id|cc)[ \t]*:"

  TRAILER_SHAPE = "^[a-z][a-z0-9-]*:[ \t]"

  AI_ATTRIB = "(generated|written|authored|created|drafted|produced|built"
  AI_ATTRIB = AI_ATTRIB "|made|assisted)[ \t]+(with|by)[ \t]+"
  AI_ATTRIB = AI_ATTRIB "(the[ \t]+help[ \t]+of[ \t]+)?(an?[ \t]+)?"
  AI_ATTRIB = AI_ATTRIB "(ai|a\\.i\\.|claude|chatgpt|gpt|copilot|codex"
  AI_ATTRIB = AI_ATTRIB "|llm|language model|coding agent|ai assistant)"

  AI_PHRASE = "(with[ \t]+(the[ \t]+help[ \t]+of[ \t]+)?"
  AI_PHRASE = AI_PHRASE "(claude|chatgpt|copilot|ai[ \t]+assistance)"
  AI_PHRASE = AI_PHRASE "|ai[- ](generated|assisted|authored|written|drafted)"
  AI_PHRASE = AI_PHRASE "|(as|i am)[ \t]+an[ \t]+ai"
  AI_PHRASE = AI_PHRASE "|claude[ \t-]?code|claude\\.ai|anthropic\\.com"
  AI_PHRASE = AI_PHRASE "|openai\\.com"
  AI_PHRASE = AI_PHRASE "|(pair[- ]programmed|paired)[ \t]+with[ \t]+(an[ \t]+)?ai)"

  AI_MENTION = "(^|[^a-z0-9_])(claude|anthropic|chatgpt|openai|copilot"
  AI_MENTION = AI_MENTION "|codex|gpt-[0-9]|llm|@cursor)([^a-z0-9_]|$)"

  # Internal-looking references. The schemed forms are the ones that
  # cannot be anything else; a bare word like admin.py must not fire,
  # which is why every host family below needs a scheme or two dots.
  INT_URL = "https?://[a-z0-9.-]*(grafana|rancher|kibana|jenkins|vault"
  INT_URL = INT_URL "|argocd|prometheus|alertmanager|admin|dashboard"
  INT_URL = INT_URL "|intranet|jira|confluence)\\.[a-z0-9.-]+"
  INT_URL2 = "https?://(10\\.[0-9]+\\.[0-9]+\\.[0-9]+"
  INT_URL2 = INT_URL2 "|192\\.168\\.[0-9]+\\.[0-9]+"
  INT_URL2 = INT_URL2 "|172\\.(1[6-9]|2[0-9]|3[01])\\.[0-9]+\\.[0-9]+)"
  INT_HOST = "(^|[^a-z0-9._-])[a-z0-9-]+\\.[a-z0-9.-]*"
  INT_HOST = INT_HOST "\\.(internal|intranet|corp|lan)([^a-z0-9._-]|$)"

  INT_LOOK = "(https?://(localhost|127\\.0\\.0\\.1)|localhost:[0-9]+"
  INT_LOOK = INT_LOOK "|notion\\.so|linear\\.app"
  INT_LOOK = INT_LOOK "|atlassian\\.net)"

  nrep = 0
}

{
  lines[NR] = $0
  low = tolower($0)
  n = length($0)

  # Every byte outside printable ASCII and tab, named where the name
  # is known and counted as a run where it is not.
  i = 1
  while (i <= n) {
    c = substr($0, i, 1)
    if (c ~ /^[\t -~]$/) { i++; continue }
    k = named_at($0, i)
    if (k > 0) {
      store("BLOCK", NR, i, sname[k])
      i += slen[k]
      continue
    }
    if (index(CTRL, c) > 0) {
      store("BLOCK", NR, i, "control byte: it has no business in prose")
      i++
      continue
    }
    j = i + 1
    while (j <= n && substr($0, j, 1) !~ /^[\t -~]$/ && named_at($0, j) == 0 \
           && index(CTRL, substr($0, j, 1)) == 0) j++
    store("BLOCK", NR, i, sprintf("non-ASCII character, %d bytes: rewrite it in ASCII", j - i))
    i = j
  }

  if (match(low, TRAILER_KNOWN)) {
    known[NR] = 1
    store("BLOCK", NR, RSTART, "git trailer: this text carries no trailers, ever")
  } else {
    # One class per line. The three AI patterns overlap by design --
    # "generated with Claude Code" is all three -- and reporting one
    # phrase three times teaches the reader to skim the output.
    aihit = 0
    if (match(low, AI_ATTRIB)) {
      scan("BLOCK", NR, low, AI_ATTRIB, "AI attribution: the author is Adam and nobody else", 0)
      aihit = 1
    } else if (match(low, AI_PHRASE)) {
      scan("BLOCK", NR, low, AI_PHRASE, "AI reference: cut it, the tooling is not the subject", 0)
      aihit = 1
    }
    if (!aihit)
      scan("LOOK", NR, low, AI_MENTION, "AI product name: keep it only if the change is about that product", 1)
  }

  scan("BLOCK", NR, low, INT_URL, "internal-looking URL: link something a reader outside can open", 0)
  scan("BLOCK", NR, low, INT_URL2, "private-network address: link something a reader outside can open", 0)
  scan("BLOCK", NR, low, INT_HOST, "internal-looking hostname: name it without the host", 1)
  scan("LOOK", NR, low, INT_LOOK, "local or internal-ish reference: check a reader outside can use it", 0)

  if (n > maxcols)
    store("LOOK", NR, maxcols + 1, sprintf("line is %d columns, limit is %d", n, maxcols))
}

END {
  # A trailer block is the last paragraph when every line of it has the
  # Key: value shape. Git calls it a trailer block at a quarter of the
  # lines; this is stricter on purpose, because a PR body ends in prose
  # far more often than it ends in trailers.
  last = NR
  while (last > 0 && lines[last] ~ /^[ \t]*$/) last--
  if (last > 0) {
    first = last
    while (first > 1 && lines[first - 1] !~ /^[ \t]*$/) first--
    if (last - first + 1 <= 5) {
      allshape = 1
      for (i = first; i <= last; i++)
        if (tolower(lines[i]) !~ TRAILER_SHAPE) { allshape = 0; break }
      if (allshape)
        for (i = first; i <= last; i++)
          if (!known[i])
            store("LOOK", i, 1, "trailer-shaped line in the last block: git may read it as a trailer")
    }
  }

  for (i = 2; i <= nrep; i++) {
    sv = rsev[i]; ln = rln[i]; cl = rcol[i]; ms = rmsg[i]
    j = i - 1
    while (j >= 1 && (rln[j] > ln || (rln[j] == ln && rcol[j] > cl))) {
      rsev[j+1] = rsev[j]; rln[j+1] = rln[j]
      rcol[j+1] = rcol[j]; rmsg[j+1] = rmsg[j]
      j--
    }
    rsev[j+1] = sv; rln[j+1] = ln; rcol[j+1] = cl; rmsg[j+1] = ms
  }
  for (i = 1; i <= nrep; i++)
    printf "%-5s  %s:%d:%d  %s\n", rsev[i], label, rln[i], rcol[i], rmsg[i]
}
'
}

# verdict REPORT LABEL LINECOUNT -- prints the summary, returns 0 or 1.
verdict() {
  _report=$1
  _label=$2
  _lines=$3
  _block=$(printf '%s\n' "$_report" | grep -c '^BLOCK' || true)
  _look=$(printf '%s\n' "$_report" | grep -c '^LOOK' || true)
  if [ "$_block" -gt 0 ]; then
    echo "voice-sweep: $_block blocking and $_look to look at in $_label ($_lines lines). Do not send it."
    return 1
  fi
  if [ "$_look" -gt 0 ]; then
    echo "voice-sweep: nothing blocking, but $_look to look at in $_label ($_lines lines). Look before sending."
    return 1
  fi
  echo "voice-sweep: clean, $_label, $_lines lines, no non-ASCII, no trailers, no AI references, no internal references."
  return 0
}

# ------------------------------------------------------------ self-test

PASS=0
FAIL=0

# check NAME WANT_BLOCK WANT_LOOK WANT_TEXT LINE...
# WANT_TEXT is a substring the report must contain; prefix it with !
# to require its absence, or leave it empty to check counts only.
check() {
  _name=$1
  _wb=$2
  _wl=$3
  _want=$4
  shift 4
  _out=$(printf '%s\n' "$@" | emit_report selftest 120)
  _gb=$(printf '%s\n' "$_out" | grep -c '^BLOCK' || true)
  _gl=$(printf '%s\n' "$_out" | grep -c '^LOOK' || true)
  _why=
  [ "$_gb" = "$_wb" ] || _why="block $_gb want $_wb"
  [ "$_gl" = "$_wl" ] || _why="$_why look $_gl want $_wl"
  case "$_want" in
    '') ;;
    '!'*)
      case "$_out" in
        *"${_want#!}"*) _why="$_why unwanted text present: ${_want#!}" ;;
      esac
      ;;
    *)
      case "$_out" in
        *"$_want"*) ;;
        *) _why="$_why missing text: $_want" ;;
      esac
      ;;
  esac
  if [ -n "$_why" ]; then
    FAIL=$((FAIL + 1))
    echo "FAIL  $_name  ($_why)"
    printf '%s\n' "$_out" | sed 's/^/        /'
  else
    PASS=$((PASS + 1))
    echo "pass  $_name"
  fi
}

# check_order NAME EXPECTED LINE...
# EXPECTED is the line:col sequence the report must come out in.
check_order() {
  _name=$1
  _want=$2
  shift 2
  _out=$(printf '%s\n' "$@" | emit_report selftest 120)
  _got=$(printf '%s\n' "$_out" |
    awk -F'selftest:' 'NF > 1 { split($2, a, "  "); printf "%s ", a[1] }')
  _got=${_got% }
  if [ "$_got" = "$_want" ]; then
    PASS=$((PASS + 1))
    echo "pass  $_name"
  else
    FAIL=$((FAIL + 1))
    echo "FAIL  $_name  (order $_got want $_want)"
  fi
}

self_test() {
  LONG=$(awk 'BEGIN { s = ""; while (length(s) < 130) s = s "x"; print s }')

  check "clean body passes" 0 0 "" \
    "Fixes the retry loop that dropped the last event." \
    "" \
    "Verified with: go test ./internal/stream/ -run TestRetry" \
    "ok  internal/stream 0.412s"

  # Both em-dash cases assert the message and not only the column. The
  # first version asserted the column alone, and deleting the em dash
  # from the table still scored 25/25: the generic non-ASCII fallback
  # fires at the same column and the check could not tell them apart.
  check "em dash is blocked with its column" 1 0 "selftest:1:8  em dash" \
    "$(printf 'A dash \342\200\224 here')"

  check "en dash is blocked" 1 0 "en dash" \
    "$(printf 'range 1\342\200\2235')"

  check "all four smart quotes are blocked" 4 0 "left double quote" \
    "$(printf '\342\200\234quoted\342\200\235 and \342\200\230single\342\200\231')"

  check "non-breaking space is blocked" 1 0 "non-breaking space" \
    "$(printf 'two\302\240words')"

  check "ellipsis is blocked" 1 0 "ellipsis" \
    "$(printf 'and so on\342\200\246')"

  check "an unnamed multibyte character reports once as a run" 1 0 "2 bytes" \
    "$(printf 'caf\303\251 order')"

  check "box drawing is blocked" 1 0 "box-drawing" \
    "$(printf 'table \342\224\200 edge')"

  check "an emoji is blocked once, not four times" 1 0 "emoji" \
    "$(printf 'ship it \360\237\232\200')"

  check "a carriage return is named, not called non-ASCII" 1 0 "carriage return" \
    "$(printf 'windows line\r')"

  check "a tab is not a violation" 0 0 "" \
    "$(printf 'col1\tcol2')"

  check "Co-Authored-By is blocked" 1 0 "git trailer" \
    "Summary line." \
    "" \
    "Co-Authored-By: Someone <someone@example.com>"

  check "Signed-off-by is blocked" 1 0 "git trailer" \
    "Summary line." \
    "" \
    "Signed-off-by: Someone <someone@example.com>"

  check "a trailer-shaped last block is a look, not a block" 0 1 "trailer-shaped" \
    "Summary line." \
    "" \
    "Refs: ABC-123"

  check "trailer shape in the middle of prose is left alone" 0 0 "!trailer-shaped" \
    "Note: the retry is bounded now." \
    "" \
    "That is the whole change."

  check "generated with Claude Code is blocked once" 1 0 "AI attribution" \
    "Generated with Claude Code."

  check "AI-assisted is blocked" 1 0 "AI reference" \
    "This patch was AI-assisted."

  check "a bare product name is a look, not a block" 0 1 "AI product name" \
    "Bumps the claude-sdk pin to 2.4.0."

  check "an internal dashboard URL is blocked" 1 0 "internal-looking URL" \
    "Checked the graph at https://grafana.example.net before and after."

  check "an internal hostname suffix is blocked" 1 0 "internal-looking hostname" \
    "Ran it against api.staging.corp and it held."

  check "a private-network address is blocked" 1 0 "private-network" \
    "Pointed the client at http://10.4.2.9:8080 for the repro."

  check "localhost is a look, not a block" 0 1 "local or internal-ish" \
    "Verified at http://localhost:5173 in both themes."

  check "an over-long line is a look" 0 1 "columns, limit is 120" \
    "$LONG"

  check "two violations on one line are both reported" 2 0 "selftest:1:26  em dash" \
    "$(printf 'The fix \342\200\224 the real one \342\200\224 landed')"

  check_order "findings come out in line then column order" "1:5 1:40 2:12" \
    "$(printf 'See https://grafana.example.net for it \342\200\224 it dropped')" \
    "$(printf 'And a dash \342\200\224 here')"

  echo "$PASS/$((PASS + FAIL)) checks pass"
  [ "$FAIL" -eq 0 ] || return 1
  return 0
}

# ----------------------------------------------------------------- main

if [ "$MODE" = selftest ]; then
  self_test
  exit $?
fi

[ -n "$FILE" ] || { usage; exit 2; }
[ -f "$FILE" ] || { echo "voice-sweep: no such file: $FILE" >&2; exit 2; }
if ! grep -Iq . "$FILE" 2>/dev/null; then
  echo "voice-sweep: $FILE is not text. Sweep the draft, not a binary." >&2
  exit 2
fi

REPORT=$(emit_report "$FILE" "$MAXCOLS" < "$FILE")
LINECOUNT=$(wc -l < "$FILE" | tr -d ' ')
[ -n "$REPORT" ] && printf '%s\n' "$REPORT"
verdict "$REPORT" "$FILE" "$LINECOUNT"
exit $?
