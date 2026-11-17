#!/usr/bin/env bash
# build.sh <screen> : makes /home/user/m/<screen>-{old,new,fin} worktrees and merges new codemod output into -new
set -u
S=$1
case $S in
  one) REPO=/home/user/t3-exp; O=edd6b6f6; F=683cfc31;;
  big) REPO=/home/user/t3-exp; O=a114b6b0; F=ea44c473;;
  cm)  REPO=/home/user/cm-exp; O=3ee6e27;  F=49ec5eb;;
esac
DIR=experiments/solid2-one-screen
M=/home/user/m; mkdir -p $M
for v in old new fin; do
  W=$M/$S-$v
  [ -d $W ] && git -C $REPO worktree remove --force $W
  C=$O; [ $v = fin ] && C=$F
  git -C $REPO worktree add -q --detach $W $C
  ln -s $REPO/$DIR/node_modules $W/$DIR/node_modules
done
[ $S != cm ] && for v in old new fin; do mkdir -p $M/$S-$v/node_modules; ln -sfn /home/user/t3-exp/$DIR/node_modules/effect $M/$S-$v/node_modules/effect; done
RW=/home/user/rw/$S
conf=0
for f in $(cd $RW/decided && find . -name '*.tsx' | sed 's|^\./||'); do
  T=$M/$S-new/$DIR/$f
  base=$RW/mech-old/$f
  only=""; [ $S = big ] && [ $f = src/components/settings/settingsLayout.tsx ] && only="SettingsRow,SettingsPageContainer"
  node /home/user/rules/measure/merge.js "$T" "$base" "$RW/mech-new/$f" $only > $T.merged; rc=$?
  mv $T.merged $T
  if [ $rc -ne 0 ]; then echo "CONFLICT $S $f ($rc)"; conf=$((conf+rc)); fi
done
echo "$S conflicts: $conf"
