const $ = (id) => document.getElementById(id);

const els = {
  modeLabel: $("modeLabel"),
  modeBadge: $("modeBadge"),
  runState: $("runState"),
  beatAge: $("beatAge"),
  pulse: $("pulse"),
  heartbeat: $("heartbeat"),
  btnStart: $("btnStart"),
  btnStop: $("btnStop"),
  equity: $("equity"),
  realized: $("realized"),
  unrealized: $("unrealized"),
  notional: $("notional"),
  record: $("record"),
  paramForm: $("paramForm"),
  paramHint: $("paramHint"),
  posCount: $("posCount"),
  posBody: $("posBody"),
  orderCount: $("orderCount"),
  orderBody: $("orderBody"),
  updated: $("updated"),
  err: $("err"),
  errBanner: $("errBanner"),
  btnCopyErr: $("btnCopyErr"),
  btnDismissErr: $("btnDismissErr"),
};

let busy = false;
/** Sticky UI error — not wiped by the 3s dashboard refresh. */
let stickyError = "";
let stickyUntil = 0;

function showError(msg, holdMs = 120_000) {
  stickyError = String(msg || "").trim();
  stickyUntil = Date.now() + holdMs;
  if (!stickyError) {
    hideError();
    return;
  }
  console.error("[rh-bot]", stickyError);
  els.err.textContent = stickyError;
  els.errBanner.classList.remove("hidden");
}

function hideError() {
  stickyError = "";
  stickyUntil = 0;
  els.err.textContent = "";
  els.errBanner.classList.add("hidden");
}

function paintStickyError() {
  if (stickyError && Date.now() < stickyUntil) {
    els.err.textContent = stickyError;
    els.errBanner.classList.remove("hidden");
    return true;
  }
  if (stickyError && Date.now() >= stickyUntil) {
    hideError();
  }
  return false;
}

els.btnDismissErr?.addEventListener("click", () => hideError());
els.btnCopyErr?.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(stickyError || els.err.textContent || "");
    els.btnCopyErr.textContent = "Copied";
    setTimeout(() => {
      els.btnCopyErr.textContent = "Copy";
    }, 1500);
  } catch {
    /* ignore */
  }
});

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: {
      "content-type": "application/json",
      ...(opts.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function money(eth, usd) {
  if (eth == null || Number.isNaN(eth)) return "—";
  const e = `${eth >= 0 ? "" : "−"}${Math.abs(eth).toFixed(4)} ETH`;
  if (usd == null) return e;
  const u = `${usd >= 0 ? "" : "−"}$${Math.abs(usd).toFixed(2)}`;
  return `${u}`;
}

function clsPnl(n) {
  if (n > 0) return "pos";
  if (n < 0) return "neg";
  return "";
}

function fmtAge(iso) {
  if (!iso) return "no beat";
  const sec = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (sec < 5) return "just now";
  if (sec < 60) return `${sec}s ago`;
  return `${Math.floor(sec / 60)}m ${sec % 60}s ago`;
}

function setHeartbeat(hb) {
  const running = hb.running || hb.state === "running";
  els.runState.textContent = hb.state || (running ? "running" : "stopped");
  els.beatAge.textContent = fmtAge(hb.lastHeartbeatAt);
  els.pulse.classList.toggle("on", running);
  els.pulse.classList.toggle("off", !running);
  els.btnStart.disabled = busy || running || hb.state === "starting";
  els.btnStop.disabled = busy || (!running && hb.state !== "starting");
}

function fillParams(p) {
  const form = els.paramForm;
  form.TAKE_PROFIT_PERCENT.value = p.TAKE_PROFIT_PERCENT;
  form.STOP_LOSS_PERCENT.value = p.STOP_LOSS_PERCENT;
  form.MAX_HOLD_MINUTES.value = p.MAX_HOLD_MINUTES;
  form.MAX_OPEN_POSITIONS.value = p.MAX_OPEN_POSITIONS;
}

function renderPositions(rows, ethUsd) {
  els.posCount.textContent = String(rows.length);
  if (!rows.length) {
    els.posBody.innerHTML = `<tr><td colspan="7" class="empty">No open positions</td></tr>`;
    return;
  }
  els.posBody.innerHTML = rows
    .map((p) => {
      const pnlUsd = p.unrealizedUsd;
      const pnlCls = clsPnl(p.pnlPct);
      return `<tr>
        <td>${p.id}</td>
        <td class="sym">${escapeHtml(p.symbol)}<div style="color:var(--muted);font-size:0.7rem">${p.token.slice(0, 10)}…</div></td>
        <td><span class="book ${p.book}">${p.book}</span></td>
        <td>${p.sizeEth.toFixed(4)} ETH</td>
        <td class="${pnlCls}">${p.pnlPct.toFixed(1)}%<div style="font-size:0.75rem">${money(p.unrealizedEth, pnlUsd)}</div></td>
        <td>${new Date(p.openedAt).toLocaleString()}</td>
        <td>
          <button type="button" class="btn no" data-action="writeoff" data-id="${p.id}" title="Mark worthless / clear from open">Clear</button>
        </td>
      </tr>`;
    })
    .join("");
}

els.posBody.addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-action='writeoff']");
  if (!btn || busy) return;
  const id = btn.getAttribute("data-id");
  if (!id) return;
  if (
    !window.confirm(
      `Clear #${id} as a total loss?\n\nUse this when the token is worthless / unsellable.\nThis does NOT send a blockchain sell — it only closes the bot position.`,
    )
  ) {
    return;
  }
  busy = true;
  btn.disabled = true;
  showError(`Clearing #${id}…`, 10_000);
  try {
    await api(`/api/positions/${id}/writeoff`, { method: "POST", body: "{}" });
    showError(`Cleared #${id} (write-off)`, 15_000);
    await refresh();
  } catch (err) {
    showError(err.message);
    btn.disabled = false;
  } finally {
    busy = false;
  }
});

function renderOrders(rows) {
  els.orderCount.textContent = String(rows.length);
  if (!rows.length) {
    els.orderBody.innerHTML = `<tr><td colspan="7" class="empty">No open orders</td></tr>`;
    return;
  }
  els.orderBody.innerHTML = rows
    .map(
      (o) => `<tr data-order-id="${o.id}">
        <td>${o.id}</td>
        <td>${escapeHtml(o.side)}</td>
        <td class="sym">${escapeHtml(o.symbol)}</td>
        <td>${o.sizeEth.toFixed(4)} ETH</td>
        <td>${escapeHtml(o.notes || "")}</td>
        <td>${new Date(o.expiresAt).toLocaleString()}</td>
        <td>
          <div class="order-actions">
            <button type="button" class="btn yes" data-action="approve" data-id="${o.id}">Yes</button>
            <button type="button" class="btn no" data-action="reject" data-id="${o.id}">No</button>
          </div>
        </td>
      </tr>`,
    )
    .join("");
}

els.orderBody.addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-action]");
  if (!btn || busy) return;
  const id = btn.getAttribute("data-id");
  const action = btn.getAttribute("data-action");
  if (!id || !action) return;

  const label = action === "approve" ? `Approve #${id} and send live tx?` : `Reject #${id}?`;
  if (!window.confirm(label)) return;

  busy = true;
  btn.disabled = true;
  showError(action === "approve" ? `Approving #${id}…` : `Rejecting #${id}…`, 10_000);
  try {
    await api(`/api/orders/${id}/${action}`, { method: "POST", body: "{}" });
    showError(action === "approve" ? `Approved #${id}` : `Rejected #${id}`, 20_000);
    await refresh();
  } catch (err) {
    showError(err.message, 300_000);
    btn.disabled = false;
  } finally {
    busy = false;
  }
});

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function refresh() {
  try {
    const data = await api("/api/dashboard");
    // Don't wipe approve/reject errors on the 3s poll
    if (!paintStickyError()) {
      if (data.heartbeat?.error) showError(data.heartbeat.error, 60_000);
      else hideError();
    }
    setHeartbeat(data.heartbeat);
    fillParams(data.params);
    const mode = String(data.mode || data.heartbeat?.mode || "paper").toLowerCase();
    if (els.modeBadge) {
      els.modeBadge.textContent = mode;
      els.modeBadge.classList.toggle("live", mode === "live");
      els.modeBadge.classList.toggle("paper", mode === "paper");
      els.modeLabel.textContent = `ETH $${(data.ethUsd || 0).toFixed(0)} · block ${data.heartbeat.block ?? "—"}`;
    } else {
      // Old cached HTML without modeBadge
      els.modeLabel.textContent = `${mode.toUpperCase()} · ETH $${(data.ethUsd || 0).toFixed(0)} · block ${data.heartbeat.block ?? "—"}`;
    }
    document.title = mode === "live" ? "LIVE · RH Chain Bot" : "Paper · RH Chain Bot";
    document.body.dataset.mode = mode;

    const b = data.balance;
    els.equity.textContent = money(b.equityMtmEth, b.equityMtmUsd);
    els.equity.className = clsPnl(b.equityMtmEth - b.startingEth);
    els.realized.textContent = money(b.realizedPnlEth, b.realizedPnlUsd);
    els.realized.className = clsPnl(b.realizedPnlEth);
    els.unrealized.textContent = money(b.unrealizedPnlEth, b.unrealizedPnlUsd);
    els.unrealized.className = clsPnl(b.unrealizedPnlEth);
    els.notional.textContent = money(b.openNotionalEth, data.ethUsd ? b.openNotionalEth * data.ethUsd : null);

    const ps = data.paperStats;
    const wr = ps.winRate != null ? `${ps.winRate.toFixed(0)}%` : "n/a";
    els.record.textContent = `${ps.wins}W / ${ps.losses}L (${wr})`;

    renderPositions(data.positions, data.ethUsd);
    renderOrders(data.orders);
    els.updated.textContent = `updated ${new Date(data.updatedAt).toLocaleTimeString()}`;
  } catch (err) {
    showError(err.message);
  }
}

els.btnStart.addEventListener("click", async () => {
  busy = true;
  els.btnStart.disabled = true;
  try {
    const hb = await api("/api/start", { method: "POST", body: "{}" });
    setHeartbeat(hb);
    await refresh();
  } catch (err) {
    showError(err.message);
  } finally {
    busy = false;
  }
});

els.btnStop.addEventListener("click", async () => {
  busy = true;
  els.btnStop.disabled = true;
  try {
    const hb = await api("/api/stop", { method: "POST", body: "{}" });
    setHeartbeat(hb);
    await refresh();
  } catch (err) {
    showError(err.message);
  } finally {
    busy = false;
  }
});

els.paramForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const fd = new FormData(els.paramForm);
  const body = {
    TAKE_PROFIT_PERCENT: Number(fd.get("TAKE_PROFIT_PERCENT")),
    STOP_LOSS_PERCENT: Number(fd.get("STOP_LOSS_PERCENT")),
    MAX_HOLD_MINUTES: Number(fd.get("MAX_HOLD_MINUTES")),
    MAX_OPEN_POSITIONS: Number(fd.get("MAX_OPEN_POSITIONS")),
  };
  try {
    const next = await api("/api/params", { method: "POST", body: JSON.stringify(body) });
    fillParams(next);
    els.paramHint.textContent = `Saved · TP ${next.TAKE_PROFIT_PERCENT}% / SL ${next.STOP_LOSS_PERCENT}% / hold ${next.MAX_HOLD_MINUTES}m / max ${next.MAX_OPEN_POSITIONS}`;
  } catch (err) {
    showError(err.message);
  }
});

refresh();
setInterval(refresh, 3000);
