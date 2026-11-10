#!/bin/zsh
# Let Gemini (Antigravity agy, Google subscription login) use find-skills to search skills.sh
# and install a skill into one project. Headless `agy -p` cannot show permission prompts and
# `--mode auto` is unavailable on this account, so commands are approved for this run only
# (--dangerously-skip-permissions, inside --sandbox). No settings.json allow rules are added.
# Usage: scripts/gemini-find-skills.sh <project-dir> "<what kind of skill to find>"
set -euo pipefail
AGY=/Applications/Gemini.app/Contents/Helpers/agy
dir=${1:?project dir}; need=${2:?skill need}
[[ -f "$dir/.agents/skills/find-skills/SKILL.md" ]] || { echo "find-skills is not installed in $dir/.agents/skills" >&2; exit 1; }
cd "$dir"
# Subscription only: drop API-key and Vertex/GCA auth so agy uses the Google login.
exec env -u GEMINI_API_KEY -u GOOGLE_API_KEY -u GOOGLE_GENAI_USE_VERTEXAI -u GOOGLE_GENAI_USE_GCA -u GOOGLE_APPLICATION_CREDENTIALS \
  "$AGY" -p "Use your find-skills skill. Search skills.sh for: $need. Pick the best match and install it into THIS project only for the antigravity agent (project scope, -y). Do not install globally and do not modify any settings files. Report the search command, the chosen skill, and the installed path." \
  --sandbox --dangerously-skip-permissions --output-format json --print-timeout 600s
