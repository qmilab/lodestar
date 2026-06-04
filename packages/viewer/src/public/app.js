// @ts-nocheck
/*
 * Lodestar Governing UI — read-side viewer client.
 *
 * No framework, no build step. The server does the projection work
 * (projectChain / renderReport); this renders the JSON into an
 * interactive chain, with drill-down, an event-type filter, a live tail
 * over Server-Sent Events, and a read-only pending-approval view.
 *
 * SECURITY: the event log carries attacker-controlled content (that is the
 * whole point — poisoned files, injected tool output). Every dynamic
 * string is inserted as a text node or HTML-escaped first. The only place
 * we assign innerHTML is the markdown renderer, which escapes its source
 * before adding its own (controlled) structural tags.
 */

const state = {
  sessions: [],
  sessionFilter: "",
  current: null, // { project_id, session_id }
  tab: "chain",
  projection: null,
  events: [],
  maxSeq: -1,
  reportLoaded: false,
  approvals: [],
  eventTypeFilter: "",
  eventTextFilter: "",
  live: false,
  es: null,
  refreshTimer: null,
}

// ── DOM helpers ────────────────────────────────────────────────────────
function h(tag, attrs, ...kids) {
  const node = document.createElement(tag)
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue
      if (k === "class") node.className = v
      else if (k === "html")
        node.innerHTML = v // trusted: markdown renderer output only
      else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v)
      else node.setAttribute(k, v === true ? "" : String(v))
    }
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue
    node.append(kid instanceof Node ? kid : document.createTextNode(String(kid)))
  }
  return node
}

function esc(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  )
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild)
  return node
}

function fmtTime(iso) {
  if (!iso) return "—"
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return String(iso)
  return d.toLocaleString(undefined, { hour12: false })
}

async function api(path) {
  const res = await fetch(path, { headers: { accept: "application/json" } })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  return res.json()
}

const $ = (id) => document.getElementById(id)

// ── Tags ───────────────────────────────────────────────────────────────
const GOOD = new Set(["supported", "fresh", "normal", "completed", "approved", "verified", "ok"])
const BAD = new Set(["contradicted", "rejected", "failed", "refuted", "quarantine", "quarantined"])
const WARN = new Set([
  "unverified",
  "stale",
  "pending",
  "restricted",
  "hidden",
  "flagged",
  "secret",
])
const HOLD = new Set(["pending_approval", "held", "hold", "awaiting_approval"])

function tagEl(value, forced) {
  if (value == null || value === "") return null
  const v = String(value)
  let cls = forced || ""
  if (!cls) {
    if (GOOD.has(v)) cls = "good"
    else if (BAD.has(v)) cls = "bad"
    else if (HOLD.has(v)) cls = "hold"
    else if (WARN.has(v)) cls = "warn"
  }
  return h("span", { class: `tag ${cls}`.trim() }, v)
}

function kv(pairs) {
  const dl = h("dl", { class: "kv" })
  for (const [k, v] of pairs) {
    if (v == null || v === "" || (Array.isArray(v) && v.length === 0)) continue
    dl.append(h("dt", null, k))
    dl.append(h("dd", null, Array.isArray(v) ? v.join(", ") : String(v)))
  }
  return dl
}

function rawDetails(obj) {
  return h(
    "details",
    { class: "raw" },
    h("summary", null, "raw"),
    h("pre", { class: "json" }, JSON.stringify(obj, null, 2)),
  )
}

function card(cls, kicker, headline, tags, body) {
  const head = h(
    "div",
    { class: "card-head" },
    h("span", { class: "chev" }, "▸"),
    h("span", { class: "kicker" }, kicker),
    h("span", { class: "headline" }, headline || "(no headline)"),
    ...(tags || []).filter(Boolean),
  )
  const cardEl = h("div", { class: `card ${cls}` }, head, h("div", { class: "card-body" }, body))
  head.addEventListener("click", () => cardEl.classList.toggle("open"))
  return cardEl
}

// ── Chain rendering ────────────────────────────────────────────────────
function group(title, count, items, render) {
  const g = h(
    "div",
    { class: "chain-group" },
    h("h2", null, title, h("span", { class: "count" }, `(${count})`)),
  )
  if (!items || items.length === 0) {
    g.append(h("div", { class: "empty-note" }, "none recorded"))
    return g
  }
  for (const item of items) g.append(render(item))
  return g
}

function renderChain(p) {
  const root = h("div")
  root.append(
    group("Observations", p.observations.length, p.observations, (o) =>
      card(
        "obs",
        "OBS",
        o?.source?.tool ?? o?.schema ?? o?.id,
        [tagEl(o?.trust), tagEl(o?.sensitivity)],
        h(
          "div",
          null,
          kv([
            ["id", o?.id],
            ["tool", o?.source?.tool],
            ["schema", o?.schema],
            ["trust", o?.trust],
            ["sensitivity", o?.sensitivity],
            ["recorded_at", o?.recorded_at],
          ]),
          rawDetails(o),
        ),
      ),
    ),
  )
  root.append(
    group("Claims", p.claims.length, p.claims, (c) =>
      card(
        "claim",
        "CLAIM",
        c?.statement ?? c?.id,
        [tagEl(c?.truth_status), tagEl(c?.sensitivity)],
        h(
          "div",
          null,
          kv([
            ["id", c?.id],
            ["statement", c?.statement],
            ["extraction_method", c?.extraction_method],
            ["truth_status", c?.truth_status],
            ["sensitivity", c?.sensitivity],
          ]),
          rawDetails(c),
        ),
      ),
    ),
  )
  root.append(
    group("Evidence sets", p.evidence_sets.length, p.evidence_sets, (e) => {
      const items = e?.items ?? []
      return card(
        "evidence",
        "EVID",
        `for ${e?.claim_id ?? "?"} — ${items.length} item(s)`,
        items.slice(0, 4).map((it) => tagEl(it?.quality)),
        h(
          "div",
          null,
          kv([
            ["claim_id", e?.claim_id],
            ["items", items.length],
            ["qualities", items.map((it) => it?.quality).filter(Boolean)],
          ]),
          rawDetails(e),
        ),
      )
    }),
  )
  root.append(
    group("Beliefs", p.beliefs.length, p.beliefs, (b) =>
      card(
        "belief",
        "BELIEF",
        b?.statement ?? b?.claim_id ?? b?.id,
        [
          tagEl(b?.truth_status),
          tagEl(b?.retrieval_status),
          tagEl(b?.security_status),
          b?.confidence != null ? tagEl(`conf ${b.confidence}`) : null,
        ],
        h(
          "div",
          null,
          kv([
            ["id", b?.id],
            ["statement", b?.statement],
            ["truth_status", b?.truth_status],
            ["retrieval_status", b?.retrieval_status],
            ["security_status", b?.security_status],
            ["freshness_status", b?.freshness_status],
            ["confidence", b?.confidence],
            ["authority", b?.authority],
            ["calibration_class", b?.calibration_class],
          ]),
          rawDetails(b),
        ),
      ),
    ),
  )
  root.append(
    group("Decisions", p.decisions.length, p.decisions, (d) =>
      card(
        "decision",
        "DECIDE",
        d?.question ?? d?.id,
        [
          d?.belief_dependencies?.length
            ? tagEl(`${d.belief_dependencies.length} belief dep`)
            : null,
        ],
        h(
          "div",
          null,
          kv([
            ["id", d?.id],
            ["question", d?.question],
            ["selected_option_id", d?.selected_option_id],
            ["made_by", d?.made_by],
            ["made_at", d?.made_at],
            ["belief_dependencies", d?.belief_dependencies],
            ["policy_dependencies", d?.policy_dependencies],
          ]),
          rawDetails(d),
        ),
      ),
    ),
  )
  root.append(
    group("Actions", p.actions.length, p.actions, (a) => {
      const act = a?.action
      const contract = act?.contract
      const approval = act?.approval
      return card(
        "action",
        "ACTION",
        `${act?.tool ?? "?"}${act?.intent ? ` — ${act.intent}` : ""}`,
        [
          tagEl(a?.terminal_phase),
          contract?.required_level != null ? tagEl(`L${contract.required_level}`) : null,
          tagEl(contract?.blast_radius),
          a?.outcome?.status ? tagEl(a.outcome.status) : null,
        ],
        h(
          "div",
          null,
          kv([
            ["id", act?.id],
            ["tool", act?.tool],
            ["intent", act?.intent],
            ["phase", a?.terminal_phase],
            ["required_level", contract?.required_level],
            ["blast_radius", contract?.blast_radius],
            ["reversibility", contract?.reversibility],
            ["sandbox_profile", contract?.sandbox_profile],
            ["approved", approval?.approved],
            ["outcome", a?.outcome?.status],
          ]),
          rawDetails(a),
        ),
      )
    }),
  )
  if (p.transitions.length) {
    root.append(
      group("Firewall transitions", p.transitions.length, p.transitions, (t) =>
        card(
          "transition",
          "FW",
          `${t?.kind}${t?.axis ? ` · ${t.axis}` : ""}${t?.from_value ? ` ${t.from_value}→${t.to_value}` : ""}`,
          [tagEl(t?.by_authority)],
          h(
            "div",
            null,
            kv([
              ["kind", t?.kind],
              ["claim_id", t?.claim_id],
              ["belief_id", t?.belief_id],
              ["axis", t?.axis],
              ["from", t?.from_value],
              ["to", t?.to_value],
              ["by_authority", t?.by_authority],
              ["at", t?.at],
            ]),
            rawDetails(t),
          ),
        ),
      ),
    )
  }
  if (p.cognitive_summaries.length) {
    root.append(
      group("Cognitive ingestion", p.cognitive_summaries.length, p.cognitive_summaries, (c) =>
        card(
          "cognitive",
          "COG",
          `obs ${c?.observation_id ?? "?"} — ${c?.claim_count ?? 0} claims / ${c?.belief_count ?? 0} beliefs`,
          [],
          h(
            "div",
            null,
            kv([
              ["observation_id", c?.observation_id],
              ["claim_count", c?.claim_count],
              ["belief_count", c?.belief_count],
              ["world_model_keys", c?.world_model_keys],
            ]),
            rawDetails(c),
          ),
        ),
      ),
    )
  }
  return root
}

// ── Events rendering ───────────────────────────────────────────────────
function eventRow(ev, fresh) {
  const head = h(
    "div",
    { class: "event-row-head" },
    h("span", { class: "seq" }, ev.seq),
    h("span", { class: "etype" }, ev.type),
    h("span", { class: "actor" }, ev.actor_id),
    h("span", { class: "ts" }, fmtTime(ev.timestamp)),
  )
  const row = h(
    "div",
    { class: `event-row${fresh ? " fresh" : ""}` },
    head,
    h("div", { class: "event-body" }, h("pre", { class: "json" }, JSON.stringify(ev, null, 2))),
  )
  head.addEventListener("click", () => row.classList.toggle("open"))
  return row
}

function eventMatches(ev) {
  if (state.eventTypeFilter && ev.type !== state.eventTypeFilter) return false
  if (state.eventTextFilter) {
    const needle = state.eventTextFilter.toLowerCase()
    const hay = `${ev.type} ${ev.actor_id} ${JSON.stringify(ev.payload)}`.toLowerCase()
    if (!hay.includes(needle)) return false
  }
  return true
}

function renderEvents() {
  const body = clear($("events-body"))
  const visible = state.events.filter(eventMatches)
  $("event-count").textContent = `${visible.length} / ${state.events.length}`
  for (const ev of visible) body.append(eventRow(ev, false))

  // Rebuild the type-filter select, preserving the current selection.
  const select = $("event-type-filter")
  const types = [...new Set(state.events.map((e) => e.type))].sort()
  const current = state.eventTypeFilter
  clear(select)
  select.append(h("option", { value: "" }, "all event types"))
  for (const t of types) {
    const opt = h("option", { value: t }, t)
    if (t === current) opt.selected = true
    select.append(opt)
  }
}

// ── Approvals rendering ────────────────────────────────────────────────
function renderApprovals() {
  const panel = clear($("panel-approvals"))
  panel.append(
    h(
      "div",
      { class: "approval-note" },
      h("strong", null, "Read-only. "),
      "Pending approvals are shown for visibility. This viewer never resolves them — ",
      "to grant or deny, use ",
      h("code", null, "lodestar approve grant|deny <request-id>"),
      " (or the separate write-side Governing UI). The proxy stays the sole event-log writer.",
    ),
  )
  const cur = state.current
  const mine = state.approvals.filter(
    (a) => cur && a.project_id === cur.project_id && a.session_id === cur.session_id,
  )
  const others = state.approvals.filter((a) => !mine.includes(a))

  if (state.approvals.length === 0) {
    panel.append(h("div", { class: "muted" }, "No pending approvals in the log."))
    return
  }
  for (const a of mine) panel.append(approvalCard(a, false))
  if (others.length) {
    panel.append(
      h(
        "h2",
        { class: "" },
        h("span", { class: "muted" }, `Pending in other sessions (${others.length})`),
      ),
    )
    for (const a of others) panel.append(approvalCard(a, true))
  }
}

function approvalCard(a, otherSession) {
  return h(
    "div",
    { class: `approval-card${otherSession ? " other-session" : ""}` },
    h("div", { class: "reason" }, a.reason || "(no reason)"),
    kv([
      ["action_id", a.action_id],
      ["request_id", a.request_id],
      ["session", a.session_id],
      ["requested_at", fmtTime(a.requested_at)],
      ["deadline", a.deadline ? fmtTime(a.deadline) : "— (in-process hold)"],
      ["required_authority", JSON.stringify(a.required_authority)],
    ]),
  )
}

// ── Markdown (report tab) ──────────────────────────────────────────────
function inlineMd(text) {
  let s = esc(text)
  s = s.replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`)
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, t, u) => {
    const safe = /^(https?:|mailto:|#)/.test(u) ? u : "#"
    return `<a href="${esc(safe)}" target="_blank" rel="noreferrer noopener">${t}</a>`
  })
  return s
}

function splitRow(line) {
  let t = line.trim()
  if (t.startsWith("|")) t = t.slice(1)
  if (t.endsWith("|")) t = t.slice(0, -1)
  return t.split("|").map((c) => c.trim())
}

function renderMarkdown(md) {
  const lines = md.split("\n")
  let html = ""
  let i = 0
  let inList = false
  const closeList = () => {
    if (inList) {
      html += "</ul>"
      inList = false
    }
  }
  const isBreak = (l) =>
    /^\s*$/.test(l) ||
    /^#{1,6}\s/.test(l) ||
    /^\s*\|/.test(l) ||
    /^```/.test(l) ||
    /^\s*[-*+]\s/.test(l) ||
    /^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(l)

  while (i < lines.length) {
    const line = lines[i]
    if (/^```/.test(line)) {
      closeList()
      i++
      let code = ""
      while (i < lines.length && !/^```/.test(lines[i])) {
        code += `${lines[i]}\n`
        i++
      }
      i++
      html += `<pre><code>${esc(code)}</code></pre>`
      continue
    }
    if (
      /^\s*\|/.test(line) &&
      i + 1 < lines.length &&
      /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1]) &&
      lines[i + 1].includes("-")
    ) {
      closeList()
      const header = splitRow(line)
      i += 2
      let rows = ""
      while (i < lines.length && /^\s*\|/.test(lines[i])) {
        const cells = splitRow(lines[i])
        rows += `<tr>${cells.map((c) => `<td>${inlineMd(c)}</td>`).join("")}</tr>`
        i++
      }
      html += `<table><thead><tr>${header
        .map((c) => `<th>${inlineMd(c)}</th>`)
        .join("")}</tr></thead><tbody>${rows}</tbody></table>`
      continue
    }
    const hm = /^(#{1,6})\s+(.*)$/.exec(line)
    if (hm) {
      closeList()
      const lvl = hm[1].length
      html += `<h${lvl}>${inlineMd(hm[2])}</h${lvl}>`
      i++
      continue
    }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      closeList()
      html += "<hr/>"
      i++
      continue
    }
    const lm = /^\s*[-*+]\s+(.*)$/.exec(line)
    if (lm) {
      if (!inList) {
        html += "<ul>"
        inList = true
      }
      html += `<li>${inlineMd(lm[1])}</li>`
      i++
      continue
    }
    if (/^\s*$/.test(line)) {
      closeList()
      i++
      continue
    }
    closeList()
    let para = line
    i++
    while (i < lines.length && !isBreak(lines[i])) {
      para += ` ${lines[i]}`
      i++
    }
    html += `<p>${inlineMd(para)}</p>`
  }
  closeList()
  return html
}

async function loadReport() {
  const body = $("report-body")
  if (!state.current) return
  const { project_id, session_id } = state.current
  const url = `/api/sessions/${encodeURIComponent(project_id)}/${encodeURIComponent(session_id)}/report`
  $("download-md").setAttribute("href", url)
  $("download-md").setAttribute("download", `${session_id}.report.md`)
  clear(body).append(h("div", { class: "loading" }, "Rendering report…"))
  try {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`${res.status}`)
    const md = await res.text()
    clear(body).append(h("div", { html: renderMarkdown(md) }))
  } catch (err) {
    clear(body).append(h("div", { class: "error" }, `Failed to render report: ${err.message}`))
  }
  state.reportLoaded = true
}

// ── Tabs ───────────────────────────────────────────────────────────────
function setTab(tab) {
  state.tab = tab
  for (const t of document.querySelectorAll(".tab"))
    t.classList.toggle("active", t.dataset.tab === tab)
  $("panel-chain").hidden = tab !== "chain"
  $("panel-report").hidden = tab !== "report"
  $("panel-events").hidden = tab !== "events"
  $("panel-approvals").hidden = tab !== "approvals"
  if (tab === "report" && !state.reportLoaded) loadReport()
  if (tab === "events") renderEvents()
  if (tab === "approvals") renderApprovals()
}

// ── Session loading ────────────────────────────────────────────────────
function renderSessionHeader() {
  const p = state.projection
  $("session-title").textContent = state.current.session_id
  const sub = clear($("session-sub"))
  sub.append(h("span", null, h("b", null, "project "), p.project_id || "—"))
  sub.append(h("span", null, h("b", null, "events "), String(p.event_count)))
  sub.append(h("span", null, h("b", null, "actors "), (p.actor_ids || []).join(", ") || "—"))
  sub.append(
    h(
      "span",
      null,
      h("b", null, "span "),
      `${fmtTime(p.first_event_at)} → ${fmtTime(p.last_event_at)}`,
    ),
  )
}

function updateApprovalBadge() {
  const cur = state.current
  const n = state.approvals.filter(
    (a) => cur && a.project_id === cur.project_id && a.session_id === cur.session_id,
  ).length
  const tab = document.querySelector('.tab[data-tab="approvals"]')
  clear(tab).append(document.createTextNode("Approvals"))
  if (n > 0) tab.append(h("span", { class: "tab-badge" }, `● ${n}`))
}

async function openSession(project_id, session_id, opts = {}) {
  state.current = { project_id, session_id }
  state.reportLoaded = false
  state.eventTypeFilter = ""
  state.eventTextFilter = ""
  $("event-text-filter").value = ""
  for (const li of document.querySelectorAll(".session-item")) {
    li.classList.toggle("active", li.dataset.key === `${project_id}::${session_id}`)
  }
  $("empty").hidden = true
  $("session-view").hidden = false
  $("panel-chain").replaceChildren(h("div", { class: "loading" }, "Loading chain…"))

  if (!opts.silent)
    location.hash = `#p=${encodeURIComponent(project_id)}&s=${encodeURIComponent(session_id)}`

  try {
    const [projection, events, approvals] = await Promise.all([
      api(`/api/sessions/${encodeURIComponent(project_id)}/${encodeURIComponent(session_id)}`),
      api(
        `/api/sessions/${encodeURIComponent(project_id)}/${encodeURIComponent(session_id)}/events`,
      ),
      api("/api/approvals").catch(() => []),
    ])
    state.projection = projection
    state.events = events
    state.maxSeq = events.reduce((m, e) => Math.max(m, e.seq), -1)
    state.approvals = approvals
    renderSessionHeader()
    updateApprovalBadge()
    $("panel-chain").replaceChildren(renderChain(projection))
    setTab(state.tab)
    if (state.live) connectStream()
  } catch (err) {
    $("panel-chain").replaceChildren(
      h("div", { class: "error" }, `Failed to load session: ${err.message}`),
    )
  }
}

// ── Live tail (SSE) ────────────────────────────────────────────────────
function setTailDot(on) {
  const dot = $("tail-dot")
  dot.classList.toggle("on", on)
  dot.classList.toggle("off", !on)
}

function disconnectStream() {
  if (state.es) {
    state.es.close()
    state.es = null
  }
  setTailDot(false)
}

function scheduleChainRefresh() {
  if (state.refreshTimer) return
  state.refreshTimer = setTimeout(async () => {
    state.refreshTimer = null
    if (!state.current) return
    const { project_id, session_id } = state.current
    try {
      const [projection, approvals] = await Promise.all([
        api(`/api/sessions/${encodeURIComponent(project_id)}/${encodeURIComponent(session_id)}`),
        api("/api/approvals").catch(() => state.approvals),
      ])
      state.projection = projection
      state.approvals = approvals
      renderSessionHeader()
      updateApprovalBadge()
      if (state.tab === "chain") $("panel-chain").replaceChildren(renderChain(projection))
      if (state.tab === "approvals") renderApprovals()
    } catch {
      /* keep last good render */
    }
  }, 600)
}

function connectStream() {
  disconnectStream()
  if (!state.current || !state.live) return
  const { project_id, session_id } = state.current
  const url = `/api/sessions/${encodeURIComponent(project_id)}/${encodeURIComponent(
    session_id,
  )}/stream?sinceSeq=${state.maxSeq}`
  const es = new EventSource(url)
  state.es = es
  setTailDot(true)
  es.addEventListener("append", (msg) => {
    let ev
    try {
      ev = JSON.parse(msg.data)
    } catch {
      return
    }
    if (typeof ev.seq !== "number" || ev.seq <= state.maxSeq) return
    state.maxSeq = ev.seq
    state.events.push(ev)
    if (state.tab === "events") {
      if (eventMatches(ev)) $("events-body").prepend(eventRow(ev, true))
      $("event-count").textContent =
        `${state.events.filter(eventMatches).length} / ${state.events.length}`
    }
    scheduleChainRefresh()
  })
  es.onerror = () => {
    // EventSource auto-reconnects; reflect a transient drop in the dot.
    setTailDot(state.es != null && state.es.readyState !== EventSource.CLOSED)
  }
}

// ── Sessions sidebar ───────────────────────────────────────────────────
function renderSessionList() {
  const list = clear($("session-list"))
  const needle = state.sessionFilter.toLowerCase()
  const visible = state.sessions.filter(
    (s) =>
      !needle ||
      s.session_id.toLowerCase().includes(needle) ||
      s.project_id.toLowerCase().includes(needle),
  )
  $("session-count").textContent = String(visible.length)
  for (const s of visible) {
    const item = h(
      "li",
      { class: "session-item", "data-key": `${s.project_id}::${s.session_id}` },
      h("div", { class: "sid" }, s.session_id),
      h(
        "div",
        { class: "meta" },
        h("span", null, s.project_id),
        h("span", null, `${s.event_count} ev`),
        h("span", null, fmtTime(s.last_event_at)),
      ),
    )
    if (
      state.current &&
      state.current.project_id === s.project_id &&
      state.current.session_id === s.session_id
    ) {
      item.classList.add("active")
    }
    item.addEventListener("click", () => openSession(s.project_id, s.session_id))
    list.append(item)
  }
}

async function loadSessions() {
  try {
    state.sessions = await api("/api/sessions")
  } catch (err) {
    state.sessions = []
    $("session-list").replaceChildren(h("li", { class: "error" }, `Failed: ${err.message}`))
    return
  }
  renderSessionList()
}

function parseHash() {
  const m = /#(.*)$/.exec(location.hash)
  if (!m) return {}
  const params = new URLSearchParams(m[1])
  return { project: params.get("p"), session: params.get("s") }
}

async function init() {
  try {
    const health = await api("/api/health")
    $("log-root").textContent = health.log_root || ""
    $("log-root").title = `Event-log root: ${health.log_root}`
  } catch {
    /* non-fatal */
  }

  await loadSessions()

  // Tab clicks
  for (const t of document.querySelectorAll(".tab")) {
    t.addEventListener("click", () => setTab(t.dataset.tab))
  }
  // Filters
  $("session-filter").addEventListener("input", (e) => {
    state.sessionFilter = e.target.value
    renderSessionList()
  })
  $("event-type-filter").addEventListener("change", (e) => {
    state.eventTypeFilter = e.target.value
    renderEvents()
  })
  $("event-text-filter").addEventListener("input", (e) => {
    state.eventTextFilter = e.target.value
    renderEvents()
  })
  // Live tail toggle
  $("tail-toggle").addEventListener("change", (e) => {
    state.live = e.target.checked
    if (state.live && state.current) connectStream()
    else disconnectStream()
  })
  // Refresh
  $("refresh").addEventListener("click", async () => {
    await loadSessions()
    if (state.current)
      await openSession(state.current.project_id, state.current.session_id, { silent: true })
  })

  // Deep-link
  const { project, session } = parseHash()
  if (session) {
    const match =
      state.sessions.find(
        (s) => s.session_id === session && (!project || s.project_id === project),
      ) || (project ? { project_id: project, session_id: session } : null)
    if (match) openSession(match.project_id, match.session_id, { silent: true })
  }
}

init()
