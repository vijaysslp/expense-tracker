// ExpensePro v7 — Gmail + CSV/XLSX + Charts + Dedupe (full script)

// ---------- CONFIG ----------
const CLIENT_ID = window.GOOGLE_CLIENT_ID;                       // set in index.html
const SCOPES   = "https://www.googleapis.com/auth/gmail.readonly";
const GBASE    = "https://gmail.googleapis.com/gmail/v1";

// Common Indian issuers / gateways for search widening
const BANKS = [
  "icicibank","hdfcbank","axisbank","sbi","kotak","idfcfirstbank",
  "sbicard","americanexpress","amex","onecard","citi",
  "billdesk","razorpay","paytm","phonepe","amazon","flipkart"
];

// ---------- DOM HELPERS ----------
const $  = (s, r=document) => r.querySelector(s);
const $$ = (s, r=document) => [...r.querySelectorAll(s)];

const logEl = $("#logs");
const statusEl = $("#status");
function log(msg) {
  const line = `${new Date().toISOString()} — ${msg}\n`;
  if (logEl) logEl.textContent = line + (logEl.textContent || "");
  if (statusEl) statusEl.textContent = msg;
  console.log(msg);
}

// ---------- VIEW TABS ----------
const views = ["dashboard","transactions","insights","logs","settings"];
$$(".nav").forEach(btn => {
  btn.addEventListener("click", () => {
    $$(".nav").forEach(x => x.classList.remove("active"));
    btn.classList.add("active");
    views.forEach(v => $("#view-"+v)?.classList.remove("show"));
    $("#view-" + btn.dataset.view)?.classList.add("show");
  });
});

// ---------- STATE & FILTER UI ----------
const state = { tx: [] };

const fromEl = $("#fromDate");
const toEl   = $("#toDate");
const typeEl = $("#typeFilter");
const cardEl = $("#cardFilter");
const catEl  = $("#catFilter");
const qEl    = $("#search");

$("#apply").addEventListener("click", renderAll);
$("#clear").addEventListener("click", () => {
  [fromEl, toEl].forEach(i => i.value = "");
  typeEl.value = "all"; cardEl.value = ""; catEl.value = "all"; qEl.value = "";
  renderAll();
});
qEl?.addEventListener("input", renderAll);

// ---------- CSV EXPORT ----------
$("#btn-export")?.addEventListener("click", () => {
  const tx = filteredTx();
  if (!tx.length) return alert("No transactions to export.");
  const rows = [["date","amount","type","merchant","card","category","source"]];
  tx.forEach(t => rows.push([
    new Date(t.date).toISOString(),
    t.amount.toFixed(2), t.type,
    t.merchant || "", t.card || "",
    t.category || "", t.source
  ]));
  const csv = rows.map(r => r.map(c => `"${String(c).replace(/"/g,'""')}"`).join(",")).join("\n");
  const url = URL.createObjectURL(new Blob([csv], {type:"text/csv"}));
  const a = document.createElement("a");
  a.href = url; a.download = "expenses.csv"; a.click();
  URL.revokeObjectURL(url);
});

// ---------- CSV/XLSX IMPORT ----------
$("#fileInput")?.addEventListener("change", async e => {
  const f = e.target.files?.[0]; if (!f) return;
  try {
    if (f.name.toLowerCase().endsWith(".csv")) {
      mergeCsv(await f.text());
    } else {
      const wb  = XLSX.read(await f.arrayBuffer(), {type:"array"});
      const sh  = wb.Sheets[wb.SheetNames[0]];
      const rows= XLSX.utils.sheet_to_json(sh, {raw:true});
      rows.forEach(ingestRow);
    }
    log(`Imported ${f.name}`);
    renderAll();
  } catch (err) {
    log("Import failed: " + (err.message || err));
  } finally {
    e.target.value = "";
  }
});

function ingestRow(r) {
  const d = new Date(r.date || r.Date || r.DATE).getTime();
  let amt = Number(r.amount ?? r.Amount ?? r.AMOUNT);
  let type = (r.type ?? r.Type ?? r.TYPE ?? (amt < 0 ? "credit" : "debit"))
              .toString().toLowerCase().includes("credit") ? "credit" : "debit";
  if (type === "credit") amt = -Math.abs(amt);
  if (!Number.isFinite(amt)) return;
  state.tx.push({
    id: crypto.randomUUID(),
    date: Number.isFinite(d) ? d : Date.now(),
    amount: Math.abs(amt), type,
    merchant: r.merchant || r.Merchant || r.MERCHANT || "Imported",
    card: r.card || r.Card || r.CARD || null,
    category: r.category || r.Category || r.CATEGORY || "Other",
    tags: [], note: "", source: "import"
  });
}

function mergeCsv(text) {
  const L = text.split(/\r?\n/).filter(Boolean);
  if (!L.length) return;
  const H = L.shift().split(",").map(s => s.trim().toLowerCase());
  const idx = n => H.indexOf(n);
  const iD = idx("date"), iA = idx("amount"), iT = idx("type"),
        iM = idx("merchant"), iC = idx("card"), iCat = idx("category");
  L.forEach(line => {
    const c = parseCsvLine(line);
    const d = new Date(c[iD]).getTime();
    let amt = Number(c[iA]);
    const type = (c[iT] || "debit").toLowerCase().includes("credit") ? "credit" : "debit";
    if (type === "credit") amt = -Math.abs(amt);
    if (!Number.isFinite(amt)) return;
    state.tx.push({
      id: crypto.randomUUID(),
      date: Number.isFinite(d) ? d : Date.now(),
      amount: Math.abs(amt), type,
      merchant: c[iM] || "Imported", card: c[iC] || null,
      category: c[iCat] || "Other", tags: [], note: "", source: "import"
    });
  });
}
function parseCsvLine(line) {
  const out = []; let cur = "", q = false;
  for (let i=0;i<line.length;i++) {
    const ch = line[i];
    if (ch === '"') {
      if (q && line[i+1] === '"') { cur += '"'; i++; }
      else q = !q;
    } else if (ch === ',' && !q) { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out.map(s => s.trim().replace(/^"|"$|\r|\n/g,""));
}

// ---------- GSI + AUTH ----------
let tokenClient = null, accessToken = null;

function initGsiIfPossible() {
  if (tokenClient || !window.google || !google.accounts?.oauth2) return false;
  if (!CLIENT_ID) { log("Missing CLIENT_ID. Set window.GOOGLE_CLIENT_ID in index.html"); return false; }

  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CLIENT_ID, scope: SCOPES,
    callback: (resp) => {
      if (resp.error) return log("Auth error: " + JSON.stringify(resp));
      accessToken = resp.access_token;
      log("✅ Connected to Gmail");
      $("#btn-scan").disabled = false;
      // optional auto-scan
      scanGmail().catch(e => log("Auto-scan failed: " + (e.message||e)));
    }
  });
  return true;
}

// Works whether your button id is "btnConnect" or "btn-connect"
(function attachConnectHandler() {
  const btn = document.getElementById("btnConnect") || document.getElementById("btn-connect");
  if (!btn) return;
  btn.addEventListener("click", () => {
    if (!tokenClient && !initGsiIfPossible()) {
      alert("Google script not ready. Hard refresh (Ctrl/Cmd+Shift+R) and allow pop-ups.");
      return;
    }
    try { tokenClient.requestAccessToken(); }
    catch (e) {
      log("requestAccessToken failed: " + e.message);
      alert("Allow pop-ups for this site.");
    }
  });
})();

// ---------- GMAIL SCAN + DEDUPE ----------
const STOP_PATTERNS = [
  /otp/i, /one\s*time\s*password/i,
  /declined|failed|failure|unsuccessful|not\s*approved/i,
  /reversed|reversal|charge\s*reversal|chargeback/i,
  /generated mail with reference/i,
  /inform you that/i,
  /test\s*transaction/i,
  /autopay setup|mandate\s*(registered|cancelled)/i,
  /transaction\s+declined/i, /\bnot\s+processed\b/i
];

const DEDUPE_WINDOW_MS = 10 * 60 * 1000;       // 10 minutes
const processedMsgIds = new Set();             // in-memory for this run
const fpSeen = new Set(JSON.parse(localStorage.getItem("fpSeen") || "[]")); // persisted

function saveFp(fp) {
  fpSeen.add(fp);
  const arr = [...fpSeen];
  if (arr.length > 5000) arr.splice(0, arr.length - 5000);
  localStorage.setItem("fpSeen", JSON.stringify(arr));
}

function makeFingerprint(tx) {
  const bucket = Math.floor(tx.date / DEDUPE_WINDOW_MS);
  const amt    = Math.round(Number(tx.amount));
  const card   = (tx.card || "unk").toString().slice(-6);
  const merch  = (tx.merchant || "unk").toLowerCase().replace(/\s+/g," ").slice(0,24);
  return `${bucket}|${amt}|${card}|${merch}`;
}

async function gfetch(path, params={}) {
  if (!accessToken) throw new Error("No access token");
  const url = new URL(`${GBASE}/${path}`);
  Object.entries(params).forEach(([k,v]) => { if(v!==undefined&&v!==null&&v!=='') url.searchParams.set(k,v);});
  log("Gmail fetch: " + url.toString());
  const r = await fetch(url, { headers:{ Authorization:`Bearer ${accessToken}` } });
  if (!r.ok) throw new Error(`Gmail API ${r.status}: ${await r.text()}`);
  return r.json();
}

$("#btn-scan")?.addEventListener("click", () => scanGmail().catch(e => log("Scan failed: " + (e.message||e))));

async function scanGmail() {
  state.tx.length = 0;  // fresh list
  renderAll();
  const exclude = '-subject:(otp OR "one time password" OR declined OR failure OR failed OR reversal OR unsuccessful)';
  const q = `newer_than:365d ${exclude} (subject:(receipt OR transaction OR debited OR credited OR payment OR spent OR txn) OR from:(${BANKS.map(x=>'@'+x).join(' ')}))`;
  await scanQuery(q, 200);
  if (!state.tx.length) log("No results. Try CSV import.");
  renderAll();
}

const seenMsgs = new Set();

async function scanQuery(q, limit) {
  let next, processed = 0;
  try {
    do {
      const params = { q, maxResults: 100 };
      if (next) params.pageToken = next;
      const list = await gfetch("users/me/messages", params);
      next = list.nextPageToken;
      const msgs = list.messages || [];

      for (const m of msgs) {
        if (processed >= limit) break;
        if (seenMsgs.has(m.id)) continue; // skip duplicates across pages
        seenMsgs.add(m.id);

        const full = await gfetch(`users/me/messages/${m.id}`, { format:"full" });
        if (processMsg(full)) processed++;
      }
    } while (next && processed < limit);

    log(`Processed ${processed} messages — ${state.tx.length} unique transactions`);
  } catch (e) {
    log("Scan failed: " + (e.message || e));
  }
}

function hVal(headers, name) {
  return (headers || []).find(x => x.name?.toLowerCase() === name.toLowerCase())?.value || "";
}

function getBody(m) {
  try {
    if (m.payload?.parts) {
      for (const p of m.payload.parts) {
        if (p.mimeType === "text/plain" && p.body?.data)
          return atob(p.body.data.replace(/-/g,'+').replace(/_/g,'/'));
        if (p.mimeType === "text/html" && p.body?.data) {
          const html = atob(p.body.data.replace(/-/g,'+').replace(/_/g,'/'));
          return (new DOMParser()).parseFromString(html, "text/html").body.textContent || "";
        }
      }
    }
    if (m.payload?.body?.data)
      return atob(m.payload.body.data.replace(/-/g,'+').replace(/_/g,'/'));
  } catch {}
  return m.snippet || "";
}

function amt(text) {
  // INR / Rs / ₹  e.g., "Rs. 2,240.00" or "INR 55353.00"
  const m = text.match(/(?:INR|Rs\.?|₹)\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/i);
  if (!m) return null;
  return parseFloat(m[1].replace(/,/g, ""));
}

function detectType(text) {
  if (/(credited|refund(ed)?|cashback|reversal)/i.test(text)) return "credit";
  if (/(debited|spent|purchase|payment\s+made|txn\s*[:# ]?\s*approved)/i.test(text)) return "debit";
  return "debit"; // default bias
}

function detectMerchant(text) {
  // formats like: "... is debited ... towards SHYAM FILLING STATION on ..."
  let m = text.match(/(?:towards|at|merchant\s*[:\-])\s*([A-Z0-9& ._\-]{2,50})/i);
  if (m) return m[1].trim();
  // fallback brand guesses
  const rx = /(amazon|flipkart|myntra|swiggy|zomato|ola|uber|irctc|indigo|jio\s*mart|paytm|phonepe)/i;
  const g = text.match(rx);
  return g ? g[1].toUpperCase() : null;
}

function detectCard(text) {
  const t = text.match(/(?:xx|ending|card)\s*[:#-]?\s*([0-9]{3,6}|[0-9]{4})/i);
  if (t) return t[1];
  const b = (text.match(/(Visa|Mastercard|Amex|Rupay|RuPay|Discover)/i) || [])[1];
  return b || null;
}

function categorize(t) {
  const x = ((t.merchant||"") + " " + (t.raw||"")).toLowerCase();
  if (/swiggy|zomato|pizza|restaurant|kfc|mcdonald|domino/.test(x)) return "Food";
  if (/uber|ola|irctc|air|indigo|train|flight|fuel|petrol|bus/.test(x)) return "Travel";
  if (/amazon|flipkart|myntra|ajio|store|mall|shop|fashion/.test(x)) return "Shopping";
  if (/electric|power|water|gas|broadband|internet|mobile bill|postpaid|prepaid/.test(x)) return "Utilities";
  if (/netflix|prime|spotify|subscription|invoice/.test(x)) return "Subscriptions";
  if (/upi|transfer|neft|imps/.test(x)) return "Transfers";
  return "Other";
}

function processMsg(msg) {
  if (processedMsgIds.has(msg.id)) return false;
  processedMsgIds.add(msg.id);

  const h = msg.payload?.headers || [];
  const from = hVal(h, "From");
  const subject = hVal(h, "Subject") || "";
  const date = new Date(hVal(h, "Date")).getTime() || Date.now();
  const body = getBody(msg);
  const text = (subject + "\n" + body).replace(/\s+/g, " ");

  // Skip obvious non-transactions / noise
  if (STOP_PATTERNS.some(rx => rx.test(text))) return false;
  if (!/(receipt|transaction|debited|credited|payment|spent|paid|txn)/i.test(text)) return false;

  const a = amt(text);
  if (!a || a <= 0) return false;

  const type  = detectType(text);
  const merch = (detectMerchant(text) || from.replace(/<.*?>/g,"") || "Unknown").trim();
  const card  = detectCard(text);
  const cat   = categorize({ merchant: merch, raw: text });

  const tx = { id: msg.id, date, amount: a, type, merchant: merch, card, category: cat, source: "gmail", raw: text };

  // fingerprint-based dedupe
  const fp = makeFingerprint(tx);
  if (fpSeen.has(fp)) return false;
  saveFp(fp);

  state.tx.push(tx);
  return true;
}

// ---------- RENDER + CHARTS ----------
const kpiTotal = $("#kpi-total");
const kpiCount = $("#kpi-count");
const kpiCard  = $("#kpi-card");
const kpiMerch = $("#kpi-merchants");
const kpiBills = $("#kpi-bills");

const txTable  = $("#txTable");
const txTable2 = $("#txTable2");

function filteredTx() {
  const from = fromEl?.value ? new Date(fromEl.value).getTime() : -Infinity;
  const to   = toEl?.value   ? new Date(toEl.value).getTime() + 86400000 - 1 : Infinity;
  const typ  = typeEl?.value || "all";
  const card = (cardEl?.value || "").toLowerCase();
  const cat  = catEl?.value || "all";
  const q    = (qEl?.value || "").toLowerCase();

  return state.tx.filter(x => {
    if (x.date < from || x.date > to) return false;
    if (typ !== "all" && x.type !== typ) return false;
    if (cat !== "all" && (x.category||"Other") !== cat) return false;
    if (card && !String(x.card||"").toLowerCase().includes(card)) return false;
    if (q && !((x.merchant||"").toLowerCase().includes(q) ||
               (x.card||"").toLowerCase().includes(q) ||
               (x.category||"").toLowerCase().includes(q))) return false;
    return true;
  });
}

function renderAll() {
  const tx = filteredTx().sort((a,b)=>b.date-a.date);

  // KPIs
  const total = tx.reduce((s,t)=>s+(t.type==='debit'?t.amount:0),0);
  if (kpiTotal) kpiTotal.textContent = '₹ ' + total.toFixed(2);
  if (kpiCount) kpiCount.textContent = tx.length + ' tx';

  const byCard = {};
  tx.forEach(t => { const k = t.card || 'Unknown'; byCard[k] = (byCard[k]||0) + (t.type==='debit'?t.amount:0); });
  if (kpiCard) kpiCard.innerHTML = Object.keys(byCard).length ?
      Object.entries(byCard).map(([k,v])=>`<div>${k}: ₹${v.toFixed(2)}`).join('') : '—';

  const byMerch = {};
  tx.forEach(t => { const k = t.merchant || 'Unknown'; byMerch[k] = (byMerch[k]||0) + (t.type==='debit'?t.amount:0); });
  const tops = Object.entries(byMerch).sort((a,b)=>b[1]-a[1]).slice(0,6);
  if (kpiMerch) kpiMerch.innerHTML = tops.length ? tops.map(([m,v])=>`<div>${m} — ₹${v.toFixed(2)}`).join('') : '—';

  const bills = tx.filter(t => /due|statement|minimum due|payment due|last date|bill due/i.test(t.raw||""))
                  .sort((a,b)=>a.date-b.date).slice(0,6);
  if (kpiBills) kpiBills.innerHTML = bills.length ?
      bills.map(u=>`<div>• ${u.merchant||'Unknown'} — ₹${u.amount.toFixed(2)} — ${new Date(u.date).toLocaleDateString()}`).join('') : '—';

  // Tables
  if (txTable) {
    txTable.innerHTML = tx.slice(0,200).map(t=>{
      const sign = t.type==='credit' ? '-' : '';
      return `<tr><td>${new Date(t.date).toLocaleString()}</td>
                  <td>${sign}₹${Math.abs(t.amount).toFixed(2)}</td>
                  <td>${t.type}</td><td>${t.merchant||'Unknown'}</td>
                  <td>${t.card||'Unknown'}</td><td>${t.category||'Other'}</td>
                  <td>${t.source}</td></tr>`;
    }).join('');
  }
  if (txTable2) {
    txTable2.innerHTML = tx.slice(0,400).map(t=>{
      const sign = t.type==='credit' ? '-' : '';
      return `<tr><td>${new Date(t.date).toLocaleString()}</td>
                  <td>${sign}₹${Math.abs(t.amount).toFixed(2)}</td>
                  <td>${t.type}</td><td>${t.merchant||'Unknown'}</td>
                  <td>${t.card||'Unknown'}</td><td>${t.category||'Other'}</td>
                  <td contenteditable>${(t.tags||[]).join(' ')}</td>
                  <td contenteditable>${t.note||''}</td></tr>`;
    }).join('');
  }

  drawCharts(tx);
}

function destroyChart(id) {
  try { window[id]?.destroy?.(); } catch {}
}

function drawCharts(tx) {
  const now = new Date(); const months = [];
  for (let i=11;i>=0;i--) {
    const d = new Date(now.getFullYear(), now.getMonth()-i, 1);
    months.push({
      label: d.toLocaleString(undefined,{month:'short'}),
      s: +new Date(d.getFullYear(), d.getMonth(),   1),
      e: +new Date(d.getFullYear(), d.getMonth()+1, 1) - 1
    });
  }
  const mVals = months.map(m => tx.filter(t => t.type==='debit' && t.date>=m.s && t.date<=m.e)
                                  .reduce((a,b)=>a+b.amount,0));

  const byCard = {}, byCat = {}, byMerch = {};
  tx.forEach(t => {
    if (t.type==='debit') {
      byCard[t.card||'Unknown'] = (byCard[t.card||'Unknown']||0) + t.amount;
      byCat[t.category||'Other'] = (byCat[t.category||'Other']||0) + t.amount;
    }
    byMerch[t.merchant||'Unknown'] = (byMerch[t.merchant||'Unknown']||0) + t.amount;
  });

  const cum = []; let run = 0;
  tx.slice().sort((a,b)=>a.date-b.date).forEach(t => {
    run += (t.type==='debit' ? t.amount : 0);
    cum.push({ label: new Date(t.date).toLocaleDateString(undefined,{month:'short',day:'2-digit'}), value: run });
  });

  ["cMonthly","cByCard","cCumulative","cCategory","cWeekday","cTopMerch"].forEach(destroyChart);

  const cm = $("#cMonthly")?.getContext("2d");
  if (cm) window.cMonthly = new Chart(cm, {
    type:"bar",
    data:{ labels: months.map(m=>m.label), datasets:[{ label:"₹", data:mVals.map(Math.abs) }]},
    options:{ plugins:{ legend:{ display:false } } }
  });

  const cb = $("#cByCard")?.getContext("2d");
  if (cb) window.cByCard = new Chart(cb, {
    type:"doughnut",
    data:{ labels:Object.keys(byCard), datasets:[{ data:Object.values(byCard).map(Math.abs) }]},
    options:{ plugins:{ legend:{ position:"bottom" } } }
  });

  const cc = $("#cCumulative")?.getContext("2d");
  if (cc) window.cCumulative = new Chart(cc, {
    type:"line",
    data:{ labels:cum.map(x=>x.label), datasets:[{ data:cum.map(x=>x.value), fill:false, tension:.25 }]},
    options:{ plugins:{ legend:{ display:false } } }
  });

  const ca = $("#cCategory")?.getContext("2d");
  if (ca) window.cCategory = new Chart(ca, {
    type:"doughnut",
    data:{ labels:Object.keys(byCat), datasets:[{ data:Object.values(byCat).map(Math.abs) }]},
    options:{ plugins:{ legend:{ position:"bottom" } } }
  });

  const weekday = [0,0,0,0,0,0,0];
  tx.forEach(t => { weekday[new Date(t.date).getDay()] += (t.type==='debit' ? t.amount : 0); });

  const cw = $("#cWeekday")?.getContext("2d");
  if (cw) window.cWeekday = new Chart(cw, {
    type:"bar",
    data:{ labels:["Sun","Mon","Tue","Wed","Thu","Fri","Sat"], datasets:[{ label:"₹", data:weekday.map(Math.abs) }]},
    options:{ plugins:{ legend:{ display:false } } }
  });

  const top = Object.entries(byMerch).sort((a,b)=>b[1]-a[1]).slice(0,10);
  const ct = $("#cTopMerch")?.getContext("2d");
  if (ct) window.cTopMerch = new Chart(ct, {
    type:"bar",
    data:{ labels:top.map(x=>x[0]), datasets:[{ label:"₹", data:top.map(x=>Math.abs(x[1])) }]},
    options:{ plugins:{ legend:{ display:false } } }
  });
}

// ---------- BOOT ----------
addEventListener("load", () => {
  log("SCRIPT VERSION v7");
  if ("serviceWorker" in navigator) {
    try { navigator.serviceWorker.register("sw.js"); } catch {}
  }
  // poll GSI until available (some browsers are slow to load gsi/client)
  let tries = 0;
  const iv = setInterval(() => { tries++; if (initGsiIfPossible() || tries > 40) clearInterval(iv); }, 250);
  renderAll();
});
