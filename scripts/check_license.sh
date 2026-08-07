#!/bin/bash

echo "🔍 Checking for license headers..."

MISSING_FILES=""
# Find files and check them using Perl (more robust for multi-line regex)
FILES=$(find . -type d \( -name "node_modules" -o -name "dist" -o -name ".git" -o -name "browser" \) -prune -o \
               -type f \( -name "*.js" -o -name "*.ts" \) -print)

for FILE in $FILES; do
    # -0777 slurps the whole file; \A pins the header to the top, so a file that
    # merely contains it lower down no longer passes. An optional shebang and an
    # optional single-line block comment (/* eslint-disable */) may precede it.
    if ! perl -0777 -ne 'exit 0 if m|\A(?:#![^\n]*\n)?(?:/\*[^\n]*\*/\n)?\Q/**\E\n \* \@license\n \* Copyright \d{4} Google LLC\n \* SPDX-License-Identifier: Apache-2.0\n \*/|; exit 1' "$FILE"; then
        echo "❌ Missing or invalid license header: $FILE"
        MISSING_FILES="$MISSING_FILES $FILE"
    fi
done

if [ -n "$MISSING_FILES" ]; then
    echo "------------------------------------------------"
    echo "Error: Some files are missing the required license header."
    echo "The header must be the first thing in the file; only a shebang line or a single-line comment may precede it."
    exit 1
else
    echo "✅ All files have the correct license header."
    exit 0
fi
