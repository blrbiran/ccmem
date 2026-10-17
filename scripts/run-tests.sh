#!/bin/sh
set -u

test_tmp_base=${TMPDIR:-/private/tmp}
data_root=$(/usr/bin/mktemp -d "${test_tmp_base%/}/ccmem-test.XXXXXX") || exit 1

cleanup() {
  result=$?
  trap - EXIT HUP INT TERM
  /bin/rm -rf -- "${data_root:?}" || exit 1
  exit "$result"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

# No test may reach a real `claude`: a stub shadows it on PATH. It answers the
# daemon-install capability probe (`claude -p --help`, which must list
# --json-schema) and fails every other call. (CCMEM_CLAUDE_P_COMMAND is not used
# for this: its mere presence turns on the LLM bridge and is written into the
# daemon plist, so defaulting it would change what the tests measure.) Tests
# that need a fake set their own.
stub_bin="$data_root/stub-bin"
/bin/mkdir -p "$stub_bin" || exit 1
/bin/cat > "$stub_bin/claude" <<'STUB' || exit 1
#!/bin/sh
if [ "$#" -eq 2 ] && [ "$1" = "-p" ] && [ "$2" = "--help" ]; then
  echo "ccmem test stub: --json-schema <schema>"
  exit 0
fi
echo "ccmem tests: real claude is blocked" >&2
exit 1
STUB
/bin/chmod 0700 "$stub_bin/claude" || exit 1

# No test may reach the human's real home either: every default that derives
# from os.homedir() (~/.claude/ccmem, ~/.codex, ~/.omp/agent,
# ~/Library/LaunchAgents) lands in a temp HOME instead, so a test that forgets
# its own override writes into this dir, not into real user data. The
# variables that point OMP or Codex elsewhere are dropped for the same reason:
# an inherited one would outrank the temp HOME.
test_home="$data_root/home"
/bin/mkdir -m 0700 "$test_home" || exit 1

env -u CCMEM_CONFIG_PATH -u CODEX_HOME -u CCMEM_OMP_AGENT_DIR -u PI_CODING_AGENT_DIR \
  -u OMP_PROFILE -u PI_PROFILE -u PI_CONFIG_DIR -u CCMEM_LAUNCHAGENT_DIR \
  HOME="$test_home" CCMEM_DATA_ROOT="$data_root" PATH="$stub_bin:$PATH" /usr/local/bin/node --test "$@"
