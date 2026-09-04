# Connector fixture guide

Connector fixtures let contributors develop and test page extraction without
capturing authenticated provider pages or using real billing information.
Fixtures are deterministic JSON documents containing static synthetic markup
and either an expected normalized subscription or an expected safe failure.

## Adding a fixture

Before committing a fixture, confirm every item:

- [ ] The fixture ID and provider ID start with `synthetic-`.
- [ ] Every person, provider, plan, date, price, and status was invented for
      the fixture; no value was copied from an account or provider page.
- [ ] The markup was written by hand and has
      `data-vaultscout-fixture="synthetic"` on its root element.
- [ ] The markup contains no scripts, forms, external resources, event
      handlers, resource-bearing attributes, styles, encoded HTML entities,
      comments copied from a page, or hidden page data.
- [ ] The fixture contains no account identifier, email address, invoice,
      cookie, token, authorization value, browser storage, password, MFA value,
      credential, payment-card number, or authenticated HTML.
- [ ] `checkedAt` is a fixed synthetic timestamp, not the current time.
- [ ] The fixture passes `validateConnectorFixture`.
- [ ] The harness test passes with networking disabled.

Do not sanitize a captured authenticated page. Build the smallest synthetic
document needed to exercise the connector's selectors and parsing behavior.

## Format

```json
{
  "version": 1,
  "id": "synthetic-example",
  "description": "A hand-written deterministic billing summary.",
  "html": "<main data-vaultscout-fixture=\"synthetic\">...</main>",
  "expectation": {
    "outcome": "subscription",
    "subscription": {
      "providerId": "synthetic-example",
      "providerName": "Synthetic Example",
      "planName": "Fixture Basic",
      "renewalDate": "2030-01-15",
      "amountMinor": 1995,
      "currency": "USD",
      "billingCycle": "monthly",
      "status": "active",
      "checkedAt": "2030-01-01T00:00:00.000Z"
    }
  }
}
```

An intentionally changed or missing selector may instead declare:

```json
{
  "expectation": {
    "outcome": "error",
    "code": "CONNECTOR_EXTRACTION_FAILED"
  }
}
```

The complete document remains subject to the strict schema and sanitizer.
Unknown fields are rejected.

## Runtime safety

`withConnectorFixturePage` creates a fresh Playwright context with JavaScript
and service workers disabled. It aborts all network requests and rejects the
run if any request is attempted. Fixture-loading and extraction errors expose
only stable codes and generic messages; they do not include markup, selectors,
or extracted values.
