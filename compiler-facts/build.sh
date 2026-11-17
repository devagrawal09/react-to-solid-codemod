#!/usr/bin/env bash
# Builds lib/compiler-facts.wasm: oxc at a pinned commit, plus oxc-facts.patch (which exposes
# the React Compiler's reactive analysis), compiled to wasm32-unknown-unknown.
#
#   compiler-facts/build.sh               # clones oxc from GitHub into compiler-facts/.oxc
#   OXC_REPO=~/src/oxc compiler-facts/build.sh   # or from a local clone
#
# oxc 0.158 needs Rust 1.98 or newer; set RUST_TOOLCHAIN to pick another installed one.
set -euo pipefail
cd "$(dirname "$0")"

OXC_COMMIT=e375dff31cc44c1fe8f17e2997d46ba85dc38c2a
OXC_REPO=${OXC_REPO:-https://github.com/oxc-project/oxc.git}
TOOLCHAIN=${RUST_TOOLCHAIN:-1.100.0}

if [ ! -d .oxc/.git ]; then
  git init -q .oxc
  git -C .oxc remote add origin "$OXC_REPO"
fi
git -C .oxc fetch -q --depth 1 origin "$OXC_COMMIT"
git -C .oxc checkout -q --force FETCH_HEAD
git -C .oxc clean -qfdx
git -C .oxc apply ../oxc-facts.patch

rustup target add wasm32-unknown-unknown --toolchain "$TOOLCHAIN" >/dev/null
cargo +"$TOOLCHAIN" build --release --target wasm32-unknown-unknown
cp target/wasm32-unknown-unknown/release/compiler_facts.wasm ../lib/compiler-facts.wasm
ls -l ../lib/compiler-facts.wasm
