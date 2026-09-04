const byId = (id) => document.getElementById(id);

const loadingState = byId("loading-state");
const errorState = byId("error-state");
const dashboardContent = byId("dashboard-content");
const refreshButton = byId("refresh-button");

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function formatCurrency(amountMinor, currency) {
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
    }).format(amountMinor / 100);
  } catch {
    return `${(amountMinor / 100).toFixed(2)} ${currency}`;
  }
}

function formatDate(value) {
  const date = new Date(`${value}T00:00:00.000Z`);
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

function formatTimestamp(value) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(value));
}

function timeElement(value, dateOnly = false) {
  const node = element("time", "", dateOnly ? formatDate(value) : formatTimestamp(value));
  node.dateTime = value;
  node.title = dateOnly ? `${value} (UTC date)` : value;
  return node;
}

function friendlyCode(value) {
  return value ? value.toLowerCase().replaceAll("_", " ") : "No failure code";
}

function statusBadge(status) {
  return element(
    "span",
    `status-badge ${status}`,
    status.replaceAll("_", " "),
  );
}

function tableCell(label, child, className = "") {
  const cell = element("td", className);
  cell.dataset.label = label;
  if (typeof child === "string") {
    cell.textContent = child;
  } else {
    cell.append(child);
  }
  return cell;
}

function renderSummary(summary) {
  byId("metric-active").textContent = String(summary.activeSubscriptions);
  byId("metric-seven").textContent = String(summary.renewalsWithin7Days);
  byId("metric-thirty").textContent = String(summary.renewalsWithin30Days);
  byId("metric-reauth").textContent = String(summary.reauthenticationRequired);
  byId("metric-failures").textContent = String(summary.recentFailedChecks);

  const asOf = byId("summary-as-of");
  asOf.replaceChildren("Updated ", timeElement(summary.asOf));
}

function warningCard(tone, title, primary, secondary) {
  const card = element("article", `warning-card ${tone}`);
  card.append(
    element("h3", "", title),
    element("p", "", primary),
    element("span", "warning-meta", secondary),
  );
  return card;
}

function renderWarnings(warnings) {
  const grid = byId("warning-grid");
  const empty = byId("warning-empty");
  const cards = [];

  for (const item of warnings.pastDue) {
    cards.push(
      warningCard(
        "danger",
        "Past-due subscription",
        `${item.providerName} · ${item.planName}`,
        `${item.accountLabel} · Last checked ${formatTimestamp(item.checkedAt)}`,
      ),
    );
  }
  for (const item of warnings.reauthentication) {
    cards.push(
      warningCard(
        "warning",
        "Reauthentication required",
        `${item.providerName} · ${item.accountLabel}`,
        `${friendlyCode(item.failureCode)} · ${formatTimestamp(item.checkedAt)}`,
      ),
    );
  }
  for (const item of warnings.recentFailures) {
    cards.push(
      warningCard(
        "danger",
        "Connector check failed",
        `${item.providerName} · ${item.accountLabel}`,
        `${friendlyCode(item.failureCode)} · ${formatTimestamp(item.checkedAt)}`,
      ),
    );
  }

  grid.replaceChildren(...cards);
  grid.hidden = cards.length === 0;
  empty.hidden = cards.length !== 0;
}

function renderRenewals(data) {
  const rows = byId("renewal-rows");
  const table = byId("renewal-table-wrap");
  const empty = byId("renewal-empty");
  const count = byId("renewal-count");

  count.textContent = `${data.renewals.length} scheduled`;
  const rendered = data.renewals.map((renewal) => {
    const row = document.createElement("tr");
    const provider = element("div", "provider-cell");
    provider.append(
      element("span", "", renewal.providerName),
      element("small", "", renewal.accountLabel),
    );
    const lastCheck = element("div");
    lastCheck.append(
      timeElement(renewal.checkedAt),
      element("div", "cell-subtle", "UTC preserved"),
    );
    row.append(
      tableCell("Provider", provider),
      tableCell("Plan", renewal.planName),
      tableCell("Renews", timeElement(renewal.renewalDate, true)),
      tableCell(
        "Amount",
        formatCurrency(renewal.amountMinor, renewal.currency),
        "amount-cell",
      ),
      tableCell("Cycle", renewal.billingCycle),
      tableCell("Status", statusBadge(renewal.status)),
      tableCell("Last check", lastCheck),
    );
    return row;
  });

  rows.replaceChildren(...rendered);
  table.hidden = rendered.length === 0;
  empty.hidden = rendered.length !== 0;
}

function detailField(term, value) {
  const wrapper = document.createElement("div");
  wrapper.append(element("dt", "", term));
  const description = element("dd");
  if (value instanceof Node) description.append(value);
  else description.textContent = value;
  wrapper.append(description);
  return wrapper;
}

function renderHistoryDetail(check) {
  const detail = byId("history-detail");
  const header = element("div", "detail-header");
  const title = document.createElement("div");
  title.append(
    element("h3", "", check.providerName),
    element("p", "", `${check.accountLabel} · Check ${check.id}`),
  );
  header.append(title, statusBadge(check.outcome));

  const fields = element("dl", "detail-grid");
  fields.append(
    detailField("Checked", timeElement(check.checkedAt)),
    detailField("Outcome", check.outcome.replaceAll("_", " ")),
    detailField("Failure code", friendlyCode(check.failureCode)),
  );
  if (check.subscription) {
    fields.append(
      detailField("Plan", check.subscription.planName),
      detailField(
        "Renewal date",
        timeElement(check.subscription.renewalDate, true),
      ),
      detailField(
        "Amount",
        formatCurrency(
          check.subscription.amountMinor,
          check.subscription.currency,
        ),
      ),
      detailField("Billing cycle", check.subscription.billingCycle),
      detailField("Subscription status", check.subscription.status.replaceAll("_", " ")),
    );
  }
  detail.replaceChildren(header, fields);
}

function renderHistory(data) {
  const list = byId("history-list");
  const layout = list.parentElement;
  const empty = byId("history-empty");
  const count = byId("history-count");
  count.textContent = `${data.checks.length} checks`;

  const buttons = data.checks.map((check, index) => {
    const button = element("button", "history-item");
    button.type = "button";
    const dot = element("span", `outcome-dot ${check.outcome}`);
    dot.setAttribute("aria-hidden", "true");
    const primary = element("span", "history-primary");
    primary.append(
      element("strong", "", check.providerName),
      element(
        "small",
        "",
        `${check.accountLabel} · ${check.outcome.replaceAll("_", " ")}`,
      ),
    );
    button.append(
      dot,
      primary,
      element("time", "history-time", formatTimestamp(check.checkedAt)),
    );
    button.addEventListener("click", () => {
      for (const item of list.querySelectorAll(".history-item")) {
        item.classList.remove("selected");
      }
      button.classList.add("selected");
      renderHistoryDetail(check);
    });
    if (index === 0) button.classList.add("selected");
    return button;
  });

  list.replaceChildren(...buttons);
  layout.hidden = buttons.length === 0;
  empty.hidden = buttons.length !== 0;
  if (data.checks[0]) renderHistoryDetail(data.checks[0]);
}

async function requestJson(path) {
  const response = await fetch(path, {
    method: "GET",
    headers: { Accept: "application/json" },
    credentials: "same-origin",
    cache: "no-store",
  });
  if (!response.ok) throw new Error("Dashboard request failed.");
  return response.json();
}

async function loadDashboard() {
  loadingState.hidden = false;
  errorState.hidden = true;
  dashboardContent.hidden = true;
  refreshButton.disabled = true;

  try {
    const [summary, renewals, warnings, history] = await Promise.all([
      requestJson("/api/summary"),
      requestJson("/api/renewals"),
      requestJson("/api/warnings"),
      requestJson("/api/history"),
    ]);
    renderSummary(summary);
    renderRenewals(renewals);
    renderWarnings(warnings);
    renderHistory(history);
    loadingState.hidden = true;
    dashboardContent.hidden = false;
  } catch {
    loadingState.hidden = true;
    errorState.hidden = false;
  } finally {
    refreshButton.disabled = false;
  }
}

refreshButton.addEventListener("click", () => {
  void loadDashboard();
});

void loadDashboard();
