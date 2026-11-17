#!/usr/bin/env bash
# measure.sh <screen> : tsc errors and Solid lint warnings for old/new/fin
S=$1; D=experiments/solid2-one-screen
FILES=$(cd /home/user/rw/$S/decided && find . -name '*.tsx' | sed 's|^\./||')
ESL=/home/user/cp/gate/node_modules/.bin/eslint
for v in old new fin; do
  W=/home/user/m/$S-$v/$D
  ( cd $W && npx tsc -p tsconfig.json --noEmit --pretty false > /home/user/rules/measure/out/$S-$v.tsc.txt 2>&1 )
  ( cd $W && $ESL --no-config-lookup -c /home/user/cp/gate/eslint.config.mjs -f json $FILES > /home/user/rules/measure/out/$S-$v.lint.json 2>/dev/null )
  t=$(grep -c "error TS" /home/user/rules/measure/out/$S-$v.tsc.txt)
  l=$(node -e 'const r=require(process.argv[1]); let w=0,e=0; for(const f of r){w+=f.warningCount;e+=f.errorCount} console.log(w+"w/"+e+"e")' /home/user/rules/measure/out/$S-$v.lint.json)
  echo "$S $v tsc=$t lint=$l"
done
