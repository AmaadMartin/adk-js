#!/bin/bash

echo "🔍 Checking for license headers..."

MISSING=0

FILE_LIST=$(mktemp "${TMPDIR:-/tmp}/adk_license_files.XXXXXX")
trap 'rm -f "$FILE_LIST"' EXIT

# find prints the paths it reached before it aborts, so a partial scan reads as
# a full one unless its exit status is checked. The temp file keeps that status
# readable; a pipe or a process substitution would hide it.
if ! find . -type d \( -name "node_modules" -o -name "dist" -o -name ".git" -o -name "browser" \) -prune -o \
            -type f \( -name "*.js" -o -name "*.ts" \) -print0 > "$FILE_LIST"; then
    echo "❌ Error: failed to list source files; the license check did not run." >&2
    exit 1
fi

FILES=()
while IFS= read -r -d '' FILE; do
    FILES+=("$FILE")
done < "$FILE_LIST"

if [ "${#FILES[@]}" -eq 0 ]; then
    echo "❌ Error: no .js or .ts files were found; the license check did not run." >&2
    exit 1
fi

for FILE in "${FILES[@]}"; do
    # -0777 slurps the whole file, -ne executes, and we exit with 0 if found
    if ! perl -0777 -ne "exit 0 if m|\Q/**\E\n \* \@license\n \* Copyright \d{4} Google LLC\n \* SPDX-License-Identifier: Apache-2.0\n \*/|; exit 1" "$FILE"; then
        echo "❌ Missing or invalid license header: $FILE"
        MISSING=1
    fi
done

if [ "$MISSING" -eq 1 ]; then
    echo "------------------------------------------------"
    echo "Error: Some files are missing the required license header."
    exit 1
else
    echo "✅ All files have the correct license header."
    exit 0
fi
