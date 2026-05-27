# Telenotes — workspace fixture

This is a fixture directory the wrapped-agent example reads from. It
stands in for "the project the wrapped coding agent is working on."

The two files in this directory simulate the kind of repo content an
agent might be asked to look at during a real session:

- `README.md` (this file): ordinary project notes.
- `notes.md`: ordinary notes — except they've been quietly poisoned
  with prompt-injection content. The example is structured to
  demonstrate that Lodestar's auto-observation gate keeps the
  poisoned content from auto-promoting to a trusted belief.

Editing this file is fine for experimentation; the example does not
write back.
