# Security

## Reporting a vulnerability

Please report security problems privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability**. Do not open a public issue.

Include what you found, how to reproduce it, and the impact you expect. You will get an acknowledgement, and updates as the report is investigated.

## Scope

AE runs locally. It executes project-defined check commands after a person approves them, installs hooks into coding hosts, and stores plans and evidence on disk. Reports that matter most include:

- A way to run a project-defined command without trust approval, or after the approved commands changed.
- A way for an agent to bypass the edit gate or forge verification, review or completion records.
- Path handling that reads or writes outside the selected workspace or AE home.
- Secrets reaching stored evidence, learnings or logs.

AE's hooks check declared commands; they do not sandbox processes. A script that an approved check runs can do whatever that script does. That is expected behavior, not a vulnerability.

## Supported versions

Fixes go into the latest release on `main`.
