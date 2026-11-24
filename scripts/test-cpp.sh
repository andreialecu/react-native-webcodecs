#!/usr/bin/env bash
# Host tests of the Android C++ helpers that need no NDK
# (android/src/test/cpp/*_test.cpp), each built with clang and run under
# AddressSanitizer and UndefinedBehaviorSanitizer: `yarn test:cpp`.
# clang, not g++: P010.hpp uses __fp16, which clang has on every target.
set -euo pipefail

cd "$(dirname "$0")/.."
CXX="${CXX:-clang++}"
OUT=android/build/test-cpp
mkdir -p "$OUT"

failed=0
for test in android/src/test/cpp/*_test.cpp; do
  name="$(basename "$test" .cpp)"
  echo "== $name"
  "$CXX" -std=c++20 -Wall -Wextra -Werror -g -O1 -fno-omit-frame-pointer \
    -fsanitize=address,undefined -fno-sanitize-recover=all \
    -I android/src/main/cpp -o "$OUT/$name" "$test"
  if ! ASAN_OPTIONS=detect_leaks=0 "$OUT/$name"; then
    failed=1
  fi
done
exit "$failed"
