# Agent instructions

## Scratch files stay inside the project

Test scripts, debug probes, captured payloads, mock servers, logs and every other
intermediate artifact MUST be written inside this project. Never use `/tmp`,
`/private/tmp`, `/var/tmp`, `$TMPDIR` or `os.tmpdir()` for them.

- Default location: `tmp/<task-slug>/`. Create it when missing; `tmp/` is gitignored.
- Prefer it over shell redirection into a temp path; pass the path explicitly:
  `curl -o tmp/probe/out.txt`, `--data-binary @tmp/fail.json`,
  `node tmp/probe.mjs`, `> tmp/run.log`.
- If a tool or library defaults to the system temp directory, pass an explicit path
  under the project instead.
- Delete the artifacts when the task is finished, unless the user asked to keep them.

The same applies to commands run over SSH or in subagents: write to the project
directory on that machine (e.g. `/opt/bridge-ai/tmp/`), not to its `/tmp`.

The only exception is an operation that genuinely cannot work outside a system temp
path (for example a package installer's internal staging). Ask the user first, and
clean up afterwards.

## Reporting

When you finish a task that created scratch artifacts, mention where they live and
whether you removed them.
