---
name: subwatch-project
description: Resume and manage development of the SubWatch repository, including durable project memory, GitHub Issues, task selection, handoffs, and implementation sequencing.
---

# SubWatch project workflow

Read `AGENTS.md`, `docs/PROJECT_MEMORY.md`, and `docs/ROADMAP.md` before planning or editing.

For implementation work:

1. Inspect open GitHub Issues and choose the requested issue or the earliest unblocked roadmap issue.
2. Keep one primary issue in progress at a time.
3. Implement only its acceptance criteria and preserve the security invariants in project memory.
4. Run type checking and relevant tests.
5. Update project memory when status, architecture, constraints, or the recommended next task changes.
6. Report the completed issue, verification results, and exact next issue.

For new work, create a GitHub Issue with context, acceptance criteria, security considerations, and verification steps. Do not use project memory as a backlog.

Do not copy credentials, cookies, invoices, or authenticated page content into issues, commits, fixtures, logs, or project memory. Use sanitized synthetic fixtures for connector tests.
