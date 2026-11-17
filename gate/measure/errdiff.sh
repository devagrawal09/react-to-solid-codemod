#!/usr/bin/env bash
# errors in new not in old (by file + code + message), and vice versa
S=$1
norm(){ grep "error TS" out/$S-$1.tsc.txt | sed -E 's/\(([0-9]+),([0-9]+)\)//' | sort; }
echo "--- only in new:"; comm -13 <(norm old) <(norm new) | cut -c1-220
echo "--- only in old (fixed):"; comm -23 <(norm old) <(norm new) | wc -l
