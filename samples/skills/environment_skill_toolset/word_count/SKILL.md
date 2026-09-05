---
name: word-count
description: Counts the words in a file, using a bundled shell script.
---

# word-count

Use this skill when the user asks how many words a file contains.

1. Call `run_skill_script` with `script_path="count.sh"` and a `command` that
   runs the script against the file, for example
   `sh <skills_folder>/word-count/scripts/count.sh notes.txt`.
2. Report the number the script prints.
