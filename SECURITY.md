# Security policy

SubWatch handles authenticated billing pages and must be treated as sensitive local software.

## Connector rules

Connectors must remain read-only. They may navigate to billing pages and extract subscription metadata. They must not submit purchases, cancellations, plan changes, payment methods, passwords, recovery codes, or MFA values.

Never log cookies, authorization headers, browser storage, complete HTML, screenshots of billing pages, or input values. Redact account identifiers from errors. Session files must remain inside the configured data directory and must never be committed.

## Reporting a problem

Do not include credentials, cookies, tokens, invoices, or personal billing details in a public issue. Describe the affected connector and the observable behavior with sanitized data.
