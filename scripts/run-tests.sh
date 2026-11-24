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

# Every os.tmpdir() a test calls lands under the data root too, so a test that
# forgets to remove its own mkdtemp dir is cleaned up above instead of piling
# up in the real $TMPDIR (the suite itself can never see such a leak).
test_tmp="$data_root/tmp"
/bin/mkdir -m 0700 "$test_tmp" || exit 1

# Tester #451: the interpreter used to be the literal /usr/local/bin/node — the first entry of the
# daemon's own fallback list (config.mjs platform_install_fallback_node_paths) treated as the only
# answer. On a machine whose node lives under nvm/fnm/asdf, that path does not exist and `npm test`
# exited 127 having run nothing. Same shape as resolveInstallNodePath (daemon.mjs): the configured
# override, the fallback candidates, then whatever node is on PATH, then this shell's own node
# when the runner IS node. CCMEM_STRICT_INTERPRETER=1 (the test that pins the refusal) forbids the
# last two so the no-node message can be exercised on a machine that does have a fallback.
node_bin=
for candidate in "${CCMEM_INSTALL_NODE_PATH:-}" /usr/local/bin/node /opt/homebrew/bin/node /usr/bin/node; do
  if [ -n "$candidate" ] && [ -x "$candidate" ]; then node_bin=$candidate; break; fi
done
if [ -z "$node_bin" ] && [ "${CCMEM_STRICT_INTERPRETER:-}" != "1" ]; then
  node_bin=$(command -v node 2>/dev/null || true)
fi
# CCMEM_STRICT_INTERPRETER asks the runner to pretend no node is reachable, so the refusal below
# can be pinned on a machine that does have one (tester #451).
if [ "${CCMEM_STRICT_INTERPRETER:-}" = "1" ]; then node_bin=; fi
if [ -z "$node_bin" ]; then
  echo "ccmem: no usable node interpreter found (looked at CCMEM_INSTALL_NODE_PATH, /usr/local/bin/node," >&2
  echo "       /opt/homebrew/bin/node, /usr/bin/node, and PATH). Set CCMEM_INSTALL_NODE_PATH to the" >&2
  echo "       absolute path of a node with the sqlite module, e.g. \"\$(command -v node)\"." >&2
  exit 127
fi

# Tester #461: the daemon-loop tests' loop guard (tests/helpers/loop-timeout.mjs) is 1000 ms when a
# file runs alone; a suite run at default concurrency on a loaded machine missed that budget in 43
# tests. The suite gets 5000 ms unless the caller chose a budget.
CCMEM_TEST_LOOP_TIMEOUT_MS=${CCMEM_TEST_LOOP_TIMEOUT_MS:-5000}
export CCMEM_TEST_LOOP_TIMEOUT_MS

env -u CCMEM_CONFIG_PATH -u CODEX_HOME -u CCMEM_OMP_AGENT_DIR -u PI_CODING_AGENT_DIR \
  -u OMP_PROFILE -u PI_PROFILE -u PI_CONFIG_DIR -u CCMEM_LAUNCHAGENT_DIR \
  HOME="$test_home" TMPDIR="$test_tmp" CCMEM_DATA_ROOT="$data_root" PATH="$stub_bin:$PATH" "$node_bin" --test "$@"
