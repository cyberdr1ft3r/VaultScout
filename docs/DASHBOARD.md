# Local renewal dashboard

The dashboard is a read-only browser view over SubWatch's local SQLite read
models. It does not run connectors, start authentication, accept credentials,
or provide payment, cancellation, or plan-change controls.

## Start it

```bash
npm run dev -- dashboard
```

The default address is `http://127.0.0.1:4173`. The dashboard uses
`SUBWATCH_DATA_DIR` when set and otherwise uses `.subwatch`.

An alternate loopback port is safe:

```bash
npm run dev -- dashboard --port 4300
```

Binding beyond this machine is refused unless both a non-loopback host and the
explicit warning acknowledgement are supplied:

```bash
npm run dev -- dashboard --host 192.0.2.10 --allow-non-loopback
```

The dashboard has no login layer. Non-loopback mode exposes private normalized
billing metadata to clients that can reach that interface, so use it only on a
trusted network with host firewall rules. A reverse proxy and remote deployment
are outside the supported security model.

## Read models

The interface shows:

- active subscriptions and renewal counts for the next 7 and 30 days;
- upcoming non-cancelled renewals ordered by UTC renewal date;
- past-due subscriptions;
- accounts whose latest connector state requires reauthentication;
- connector failures recorded in the last 7 days; and
- up to 200 recent check-history entries with normalized snapshot details.

Opaque account references never leave the server. When accounts need
differentiation, the UI receives only a short local label derived from the last
four random characters. Currency is formatted in the browser with
`Intl.NumberFormat`. Human-readable dates retain the stored UTC value in their
`time` element metadata and tooltip.

## Local HTTP security

- The server binds to `127.0.0.1` by default.
- Request `Host` headers must identify loopback or the explicitly configured
  bind host, mitigating DNS-rebinding requests.
- All APIs accept `GET` only and have no mutation behavior.
- Static files come from an exact three-file asset allowlist. Request paths are
  never mapped to arbitrary filesystem paths.
- CORS is not enabled.
- Every response uses `Cache-Control: no-store`, a restrictive
  Content-Security-Policy, `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: no-referrer`, and same-origin opener isolation.
- Frontend assets use no external scripts, styles, fonts, images, telemetry,
  analytics, or network services. Runtime requests are same-origin API reads.
- Server and API failures use stable generic messages and never include
  database paths, SQL, exception text, session state, or authenticated content.
