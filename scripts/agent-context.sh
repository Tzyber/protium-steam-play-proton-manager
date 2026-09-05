#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repo_root=$(CDPATH= cd -- "$script_dir/.." && pwd)
cd "$repo_root"

if (( $# > 1 )); then
  printf 'verwendung: %s [rg-suchmuster]\n' "$0" >&2
  exit 2
fi

required_files=(
  AGENTS.md
  HANDOFF.md
  PROTIUM_STATUS.md
  docs/notizen/Arbeitsablauf.md
  docs/notizen/Aufgaben.md
  docs/notizen/Entscheidungen.md
)

for required_file in "${required_files[@]}"; do
  if [[ ! -f "$required_file" || ! -r "$required_file" ]]; then
    printf 'pflichtdatei fehlt oder ist nicht lesbar: %s\n' "$required_file" >&2
    exit 1
  fi
done

linked_notes_text=''
linked_notes_status=0
linked_notes_text=$(
  rg -o 'docs/notizen/(vorhaben|entscheidungen)/[[:alnum:]_.-]+\.md' HANDOFF.md | sort -u
) || linked_notes_status=$?
if (( linked_notes_status > 1 )); then
  printf 'kontextnotizen konnten nicht aus HANDOFF.md gelesen werden.\n' >&2
  exit "$linked_notes_status"
fi

linked_notes=()
if [[ -n "$linked_notes_text" ]]; then
  mapfile -t linked_notes <<< "$linked_notes_text"
fi
for linked_note in "${linked_notes[@]}"; do
  if [[ ! -f "$linked_note" || ! -r "$linked_note" ]]; then
    printf 'verlinkte kontextnotiz fehlt oder ist nicht lesbar: %s\n' "$linked_note" >&2
    exit 1
  fi
done

print_section() {
  local start_prefix=$1
  local stop_pattern=$2
  local source=$3

  if ! awk -v start_prefix="$start_prefix" -v stop_pattern="$stop_pattern" '
    index($0, start_prefix) == 1 {
      active = 1
      found = 1
    }
    active && emitted && $0 ~ stop_pattern { exit }
    active {
      print
      emitted = 1
    }
    END {
      if (!found) exit 1
    }
  ' "$source"; then
    printf 'abschnitt fehlt in %s: %s\n' "$source" "$start_prefix" >&2
    return 1
  fi
}

printf '=== HANDOFF.md ===\n'
cat HANDOFF.md

handoff_lines=$(wc -l < HANDOFF.md)
if (( handoff_lines > 300 )); then
  printf 'warnung: HANDOFF.md hat %d zeilen; soft-limit ist 300.\n' "$handoff_lines" >&2
fi

printf '\n=== PROTIUM_STATUS.md: aktueller stand ===\n'
head -n 1 PROTIUM_STATUS.md
printf '\n'
print_section '## aktueller kanonischer stand' '^### ' PROTIUM_STATUS.md

printf '\n=== PROTIUM_STATUS.md: invarianten ===\n'
print_section '### invarianten (INV) & spec-anker' '^### ' PROTIUM_STATUS.md

printf '\n=== docs/notizen/Arbeitsablauf.md ===\n'
cat docs/notizen/Arbeitsablauf.md

printf '\n=== relevante notizen ===\n'
printf '%s\n' docs/notizen/Aufgaben.md docs/notizen/Entscheidungen.md
if (( ${#linked_notes[@]} > 0 )); then
  printf '%s\n' "${linked_notes[@]}"
fi

printf '\n=== git status --short ===\n'
git status --short

printf '\n=== git log -5 --oneline ===\n'
git log -5 --oneline

if (( $# == 1 )); then
  pattern=$1
  if [[ -z "$pattern" ]]; then
    printf 'suchmuster darf nicht leer sein.\n' >&2
    exit 2
  fi

  printf '\n=== optionale suche: %s ===\n' "$pattern"
  project_search_status=0
  rg -n --hidden -S --glob '!.git/**' -- "$pattern" . || project_search_status=$?
  if (( project_search_status > 1 )); then
    exit "$project_search_status"
  fi

  context_search_status=0
  rg -n --hidden --no-ignore -S -- "$pattern" \
    AGENTS.md HANDOFF.md PROTIUM_STATUS.md docs/notizen || context_search_status=$?
  if (( context_search_status > 1 )); then
    exit "$context_search_status"
  fi

  if (( project_search_status == 1 && context_search_status == 1 )); then
    printf 'keine treffer.\n'
  fi
fi
