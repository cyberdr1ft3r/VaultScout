# VaultScout agent instructions

Before planning or changing VaultScout, read:

1. `docs/PROJECT_MEMORY.md`
2. `docs/ROADMAP.md`
3. `docs/ARCHITECTURE.md`
4. The GitHub issue being implemented, if one exists

Keep `docs/PROJECT_MEMORY.md` short and current. Update it in the same change whenever work modifies project status, architecture, security invariants, or the next recommended task.

Use GitHub Issues for actionable work. Use the roadmap for sequencing, not for duplicating detailed acceptance criteria.

Never commit credentials, cookies, browser storage, invoices, screenshots of authenticated pages, or real subscription data.

VaultScout is not a password manager. Do not add a generic secret-returning API,
vault listing/search, caller-selected credential domains, or billing/account
mutations. The AI-facing surface may request a domain-bound subscription check;
it must never receive credentials or reusable authentication material.
