#!/bin/bash
cd ~/smartpetfeeder
git add -A
CHANGES=$(git diff --cached --stat)
if [ -z "$CHANGES" ]; then
  echo "Sin cambios que subir."
  exit 0
fi
git commit -m "Update $(date +%Y-%m-%d_%H:%M)"
git push origin main
echo "Subido a GitHub."
