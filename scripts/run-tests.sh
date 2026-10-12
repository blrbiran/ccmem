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

env -u CCMEM_CONFIG_PATH CCMEM_DATA_ROOT="$data_root" /usr/local/bin/node --test "$@"
