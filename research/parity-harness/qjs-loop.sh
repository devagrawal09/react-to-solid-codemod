#!/bin/bash
# One process per file so a hang in QuickJS (not interruptible) costs only that file.
cd /home/user/src/harness
for i in 12 18 $(seq 20 2 46) $(seq 60 2 76); do
  out=$(timeout 90 node --stack-size=8000 qjs-one.mjs $i 2>&1 | grep -E '^\{"name"')
  if [ -z "$out" ]; then echo "{\"index\":$i,\"timeout\":true}"; else echo "$out"; fi
done
echo DONE
