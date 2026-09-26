# shellcheck shell=bash
# Trust checks for what the self-hosted release runner executes (beadbox-5p1).
# Other accounts on the runner's machine must not be able to change any program
# the signing job runs: every PATH directory and the Rust toolchain must be
# owned by root, have no group or other write bit, and not be a symlink, and
# the same holds for every ancestor directory (whoever can write a parent can
# swap the child). Sourced by check-runner-path.sh and by test-hooks.sh, which
# pass their own owner set so the same code can be tested without root.

# untrusted_dir <dir> <owner>...: prints why <dir> or one of its ancestors is
# not trusted; prints nothing when it is.
untrusted_dir() {
  local d=$1 p
  shift
  case "$d" in
    /*) ;;
    *) echo "not an absolute path: '$d'"; return ;;
  esac
  [ -e "$d" ] || { echo "missing: $d"; return; }
  p=$d
  while :; do
    if [ -L "$p" ]; then echo "symlink: $p"; return; fi
    if [ ! -d "$p" ]; then echo "not a directory: $p"; return; fi
    if ! _owned_by_one_of "$p" "$@"; then echo "not owned by ${*}: $p"; return; fi
    if [ -n "$(find "$p" -maxdepth 0 \( -perm -g+w -o -perm -o+w \) -print)" ]; then
      echo "group- or other-writable: $p"
      return
    fi
    [ "$p" = / ] && return
    p=$(dirname "$p")
  done
}

_owned_by_one_of() {
  local p=$1 o
  shift
  for o in "$@"; do
    if [ -n "$(find "$p" -maxdepth 0 -user "$o" -print 2>/dev/null)" ]; then return 0; fi
  done
  return 1
}

# untrusted_tree <dir> <owner>...: the dir itself (and its ancestors) as above,
# then every entry below it: owned by one of <owner>, no group or other write
# bit. A symlink is allowed only as rustup lays out its proxies (cargo ->
# rustup): a bare name in the same directory that is a regular file there.
untrusted_tree() {
  local d=$1 why bad o link target
  shift
  why=$(untrusted_dir "$d" "$@")
  if [ -n "$why" ]; then echo "$why"; return; fi
  local owner_test=()
  for o in "$@"; do owner_test+=(! -user "$o"); done
  bad=$(find "$d" -mindepth 1 \( \( "${owner_test[@]}" \) -o \( ! -type l \( -perm -g+w -o -perm -o+w \) \) \) -print 2>/dev/null | head -1)
  if [ -n "$bad" ]; then echo "untrusted entry: $bad"; return; fi
  while IFS= read -r link; do
    target=$(readlink "$link")
    case "$target" in
      */* | "" | . | ..) echo "symlink leaving its directory: $link -> $target"; return ;;
    esac
    if [ -L "$(dirname "$link")/$target" ] || [ ! -f "$(dirname "$link")/$target" ]; then
      echo "symlink to something other than a file beside it: $link -> $target"
      return
    fi
  done < <(find "$d" -mindepth 1 -type l 2>/dev/null)
}

# untrusted_path_entries <PATH> <skip-prefix>... -- <owner>...: checks every
# entry of <PATH>, except those under a skip prefix (the job's own dirs).
# An empty entry means the current directory, and is refused.
untrusted_path_entries() {
  local path=$1 entry skip s why
  shift
  local skips=()
  while [ $# -gt 0 ] && [ "$1" != -- ]; do skips+=("$1"); shift; done
  shift
  local IFS=:
  # shellcheck disable=SC2206 # split on ':' deliberately; empty fields kept below
  local entries=($path)
  [ "${path: -1}" = : ] && entries+=("")
  unset IFS
  # (bash 3.2, the runner's /bin/bash, calls an empty array unbound under set -u)
  for entry in ${entries[@]+"${entries[@]}"}; do
    if [ -z "$entry" ]; then echo "empty PATH entry (the current directory)"; return; fi
    skip=no
    for s in ${skips[@]+"${skips[@]}"}; do
      case "$entry" in "$s"/*) skip=yes ;; esac
    done
    [ "$skip" = yes ] && continue
    why=$(untrusted_dir "$entry" "$@")
    if [ -n "$why" ]; then echo "PATH entry $entry: $why"; return; fi
  done
}
