# Skill toolset backed by an environment

This sample runs a skill's script inside a `LocalEnvironment` instead of a code
executor. The toolset writes the skill's files into the environment the first
time one of its scripts runs, and the model supplies the shell command.

Run it:

```
npm run sample -- samples/skills/environment_skill_toolset
```

Then ask: `how many words are in notes.txt?`

`LocalEnvironment` runs the command on the host with no sandboxing. Point it at
a workspace you are willing to let a model write to.
