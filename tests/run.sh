#!/bin/sh
set -eu
home_dir=$(mktemp -d "${TMPDIR:-/tmp}/pi-tree-graph-home.XXXXXX")
trap 'rm -r -- "$home_dir"' EXIT
HOME="$home_dir" pi --no-extensions -e "$(dirname "$0")/checkpoints.test.ts" -p test
