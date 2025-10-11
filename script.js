// ExpensePro v7 (enhanced): Gmail + CSV/XLSX + Charts

// FIX 1: read the Client ID from the global you set in index.html
const CLIENT_ID = window.GOOGLE_CLIENT_ID;
const SCOPES = "https://www.googleapis.com/auth/gmail.readonly";

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const logEl = $("#logs"), statusEl = $("#status");
function log(s) {
  const t = new Date().toISOString() + " — " + s + "\n";
  if (logEl) logEl.textContent = t + (logEl.textContent || "");
  console.log(s);
  if (statusEl) statusEl.textContent = s;
}

// ---- Dedupe + filters ----
const STOP_PATTERNS = [
  /otp/i,
  /one\s*time\s*password/i,
  /declined|failed|failure|not\s*approved/i,
  /reversed|reversal|charge\s*reversal|chargeback/i,
  /generated mail with reference/i,
  /inform you that/i,
  /test\s*transaction/i,
  /autopay setup|mandate\s*(registered|cancelled)/i
];

// 10-minute bucket for dedupe window
const DEDUPE_WINDOW_MS = 10 * 60 * 1000;

// Keep track of Gmail message IDs we've already processed this session
const processedMsgIds = new Set();

// Persisted fingerprints to avoid duplicates across rescans
const fpSeen = new Set(JSON.parse(localStorage.getItem("fpSeen") || "[]"));

function saveFp(fp) {
  fpSeen.add(fp);
  // keep the stored set size under control
  const arr = [...fpSeen];
  if (arr.length > 5000) arr.splice(0, arr.length - 5000);
  localStorage.setItem("fpSeen", JSON.stringify(arr));
}

// Build a stable fingerprint for a transaction
function makeFingerprint(tx) {
  const bucket = Math.floor(tx.date / DEDUPE_WINDOW_MS);                // time bucket
  const amt = Math.round(Number(tx.amount));                            // rupees precision
  const card = (tx.card || "unk").toString().slice(-6);                 // last digits/brand
  const merch = (tx.merchant || "unk").toLowerCase().replace(/\s+/g," ").slice(0,24);
  return `${bucket}|${amt}|${card}|${merch}`;
}

// Views
const views = ["dashboard","transactions","insights","logs","settings"];
$$(".nav").forEach(b => b.addEventListener("click", () => {
  $$(".nav").forEach(x => x.classList.remove("active"));
  b.classList.add("active");
  views.forEach(v => $("#view-" + v)?.classList.remove("show"));
  $("#view-" + b.dataset.view)?.classList.add("show");
}));

// State + filters
const state = { tx: [] };
const fromEl = $("#fromDate"), toEl = $("#toDate"),
      typeEl = $("#typeFilter"), cardEl = $("#cardFilter"),
      catEl = $("#catFilter"), qEl = $("#search");

$("#apply").addEventListener("click", renderAll);
$("#clear").addEventListener("click", () => {
  [fromEl, toEl].forEach(i => i.value = "");
  typeEl.value = "all"; cardEl.value = ""; catEl.value = "all"; qEl.value = "";
  renderAll();
});
qEl.addEventListener("input", renderAll);

// Export CSV
$("#btn-export").addEventListener("click", () => {
  const tx = fTx(); if (!tx.length) return alert("No transactions");
  const rows = [["date","amount","type","merchant","card","category","source"]];
  tx.forEach(t => rows.push([
    new Date(t.date).toISOString(),
    t.amount.toFixed(2), t.type, t.merchant || "", t.card || "",
    t.category || "", t.source
  ]));
  const csv = rows.map(r => r.map(c => `"${String(c).replace(/"/g,'""')}"`).join(",")).join("\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  const a = document.createElement("a"); a.href = url; a.download = "expenses.csv"; a.click();
  URL.revokeObjectURL(url);
});

// Import CSV/XLSX
$("#fileInput").addEventListener("change", async e => {
  const f = e.target.files?.[0]; if (!f) return;
  try {
    if (f.name.toLowerCase().endsWith(".csv")) {
      mergeCsv(await f.text());
    } else {
      const wb = XLSX.read(await f.arrayBuffer(), { type: "array" });
      const sh = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(sh, { raw: true });
      rows.forEach(ingestRow);
    }
    log(`Imported ${f.name}`); renderAll();
  } catch (err) {
    log("Import failed: " + (err.message || err));
  } finally { e.target.value = ""; }
});

function ingestRow(r) {
  const d = new Date(r.date || r.Date || r.DATE).getTime();
  let amt = Number(r.amount ?? r.Amount ?? r.AMOUNT);
  let type =
    (r.type ?? r.Type ?? r.TYPE ?? (amt < 0 ? "credit" : "debit"))
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
  const H = L.shift().split(",").map(x => x.trim().toLowerCase());
  const idx = n => H.indexOf(n);
  const iD = idx("date"), iA = idx("amount"), iT = idx("type"),
        iM = idx("merchant"), iC = idx("card"), iCat = idx("category");
  L.forEach(line => {
    const c = splitCsv(line);
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

function splitCsv(line) {
  const out = []; let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch == '"') { if (q && line[i+1]=='"') { cur += '"'; i++; } else q = !q; }
    else if (ch == ',' && !q) { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out.map(s => s.trim().replace(/^"|"$|\r|\n/g, ""));
}

// Google Identity
let tokenClient = null, accessToken = null;

function initGsiIfPossible() {
  if (tokenClient || !window.google || !google.accounts || !google.accounts.oauth2) return false;
  if (!CLIENT_ID) { log("Missing CLIENT_ID. Set window.GOOGLE_CLIENT_ID in index.html."); return false; }

  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CLIENT_ID,
    scope: SCOPES,
    callback: (resp) => {
      if (resp.error) return log("Auth error: " + JSON.stringify(resp));
      accessToken = resp.access_token;
      log("✅ Connected to Gmail");
      $("#btn-scan").disabled = false;
      scanGmail().catch(e => log("Auto-scan failed: " + (e.message || e)));
    }
  });
  return true;
}

addEventListener("load", () => {
  log("SCRIPT VERSION v7");
  if ('serviceWorker' in navigator) try { navigator.serviceWorker.register('sw.js'); } catch {}
  let tries = 0;
  const t = setInterval(() => { tries++; if (initGsiIfPossible() || tries > 40) clearInterval(t); }, 250);
});

// FIX 2: listen to the actual button id from HTML: #btnConnect
$("#btnConnect").addEventListener("click", () => {
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

// Gmail scan
const GBASE = "https://gmail.googleapis.com/gmail/v1";
const BANKS = ["icicibank","hdfcbank","axisbank","sbi","kotak","idfcfirstbank","sbicard","americanexpress","amex","onecard","citi","billdesk","razorpay","paytm","phonepe","amazon","flipkart"];

async function gfetch(p, params = {}) {
  if (!accessToken) throw new Error("No access token");
  const u = new URL(`${GBASE}/${p}`);
  Object.entries(params).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, v); });
  log("Gmail fetch: " + u);
  const r = await fetch(u, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!r.ok) throw new Error(`Gmail API ${r.status}: ${await r.text()}`);
  return r.json();
}

$("#btn-scan").addEventListener("click", () => scanGmail().catch(e => log("Scan failed: " + (e.message || e))));

async function scanGmail() {
  state.tx.length = 0; renderAll();
  const exclude = '-subject:(otp OR "one time password" OR declined OR failure OR failed OR reversal)';
  const q = `newer_than:365d ${exclude} (subject:(receipt OR transaction OR debited OR credited OR payment OR spent OR txn) OR from:(${BANKS.map(x=>'@'+x).join(' ')}))`;
  await scanQuery(q, 200);
  if (state.tx.length === 0) log("No results. Try CSV import.");
  renderAll();
}

// Prevent processing the same Gmail message twice
const seenMsgs = new Set();

async function scanQuery(q, limit) {
  let next = undefined, processed = 0;
  try {
    do {
      const params = { q, maxResults: 100 };
      if (next) params.pageToken = next;

      const list = await gfetch("users/me/messages", params);
      next = list.nextPageToken;
      const msgs = list.messages || [];

      for (const m of msgs) {
        if (processed >= limit) break;
        if (seenMsgs.has(m.id)) continue; // ✅ skip duplicates
        seenMsgs.add(m.id);

        const full = await gfetch(`users/me/messages/${m.id}`, { format: "full" });
        if (processMsg(full)) processed++;
      }
    } while (next && processed < limit);

    log(`Processed ${processed} messages — ${state.tx.length} unique transactions`);
  } catch (e) {
    log("Scan failed: " + (e.message || e));
  }
}


function hVal(h, n) { return (h || []).find(x => x.name?.toLowerCase() === n.toLowerCase())?.value || ""; }

function getBody(m) {
  try {
    if (m.payload?.parts) {
      for (const p of m.payload.parts) {
        if (p.mimeType === "text/plain" && p.body?.data)
          return atob(p.body.data.replace(/-/g,'+').replace(/_/g,'/'));
        if (p.mimeType === "text/html" && p.body?.data)
          return (new DOMParser()).parseFromString(
            atob(p.body.data.replace(/-/g,'+').replace(/_/g,'/')),
            'text/html').body.textContent || "";
      }
    }
    if (m.payload?.body?.data)
      return atob(m.payload.body.data.replace(/-/g,'+').replace(/_/g,'/'));
  } catch {}
  return m.snippet || "";
}

function detectType(text) {
  if (/(credited|refund(ed)?|cashback|reversal)/i.test(text)) return "credit";
  if (/(debited|spent|purchase|payment\s+made|txn\s*[:# ]?\s*approved)/i.test(text)) return "debit";
  return "debit"; // default bias
}

function detectMerchant(text) {
  // Try common “at … / towards … / at merchant …” shapes
  const m =
    text.match(/(?:at|towards|merchant\s*[:\-])\s*([A-Z0-9& ._\-]{2,50})/i) ||
    text.match(/(?:at\s+([A-Z][A-Z0-9& ._\-]{2,50}))\s+on\s+\d{1,2}\s\w{3}/i);
  if (m) return m[1].trim();
  // fallbacks
  const rx = /(amazon|flipkart|myntra|swiggy|zomato|ola|uber|irctc|indigo|jio\s*mart|paytm|phonepe)/i;
  const g = text.match(rx);
  return g ? g[1].toUpperCase() : null;
}

function processMsg(msg) {
  if (processedMsgIds.has(msg.id)) return false;              // already handled in this run
  processedMsgIds.add(msg.id);

  const h = msg.payload?.headers || [];
  const from = hVal(h, "From");
  const subject = hVal(h, "Subject") || "";
  const date = new Date(hVal(h, "Date")).getTime() || Date.now();

  // Extract text (subject + body)
  const body = getBody(msg);
  const text = (subject + "\n" + body).replace(/\s+/g, " ");

  // 1) Skip obvious non-transactions
  if (STOP_PATTERNS.some(rx => rx.test(text))) return false;

  // Must look like a transaction
  if (!/(receipt|transaction|debited|credited|payment|spent|paid|txn)/i.test(text)) return false;

  // 2) Amount
  const a = amt(text);
  if (!a || a <= 0) return false;

  // 3) Type, merchant, card, category
  const type = detectType(text);
  const merch = (detectMerchant(text) || from.replace(/<.*?>/g, "") || "Unknown").trim();
  const card = detectCard(text);
  const category = categorize({ merchant: merch, raw: text });

  // 4) Build potential transaction
  const tx = {
    id: msg.id,
    date,
    amount: a,
    type,
    merchant: merch,
    card,
    category,
    source: "gmail",
    raw: text
  };

  // 5) Fingerprint-based dedupe (amount+card+merchant+time-bucket)
  const fp = makeFingerprint(tx);
  if (fpSeen.has(fp)) return false;     // duplicate of a previously stored txn
  saveFp(fp);

  state.tx.push(tx);
  return true;
}


function renderAll(){
  const tx=fTx().sort((a,b)=>b.date-a.date);
  const total=tx.reduce((s,t)=>s+(t.type==='debit'?t.amount:0),0);
  kpiTotal.textContent='₹ '+total.toFixed(2);
  kpiCount.textContent=tx.length+' tx';

  const byCard={}; tx.forEach(t=>{const k=t.card||'Unknown'; byCard[k]=(byCard[k]||0)+(t.type==='debit'?t.amount:0);});
  kpiCard.innerHTML=Object.keys(byCard).length?Object.entries(byCard).map(([k,v])=>`<div>${k}: ₹${v.toFixed(2)}`).join(''):'—';

  const byMerch={}; tx.forEach(t=>{const k=t.merchant||'Unknown'; byMerch[k]=(byMerch[k]||0)+(t.type==='debit'?t.amount:0);});
  const tops=Object.entries(byMerch).sort((a,b)=>b[1]-a[1]).slice(0,6);
  kpiMerch.innerHTML=tops.length?tops.map(([m,v])=>`<div>${m} — ₹${v.toFixed(2)}`).join(''):'—';

  const bills=tx.filter(t=>/due|statement|minimum due|payment due|last date|bill due/i.test(t.raw||"")).sort((a,b)=>a.date-b.date).slice(0,6);
  kpiBills.innerHTML=bills.length?bills.map(u=>`<div>• ${u.merchant||'Unknown'} — ₹${u.amount.toFixed(2)} — ${new Date(u.date).toLocaleDateString()}`).join(''):'—';

  txTable.innerHTML = tx.slice(0,200).map(t=>{
    const sign = t.type==='credit' ? '-' : '';
    return `<tr><td>${new Date(t.date).toLocaleString()}</td><td>${sign}₹${Math.abs(t.amount).toFixed(2)}</td><td>${t.type}</td><td>${t.merchant||'Unknown'}</td><td>${t.card||'Unknown'}</td><td>${t.category||'Other'}</td><td>${t.source}</td></tr>`;
  }).join('');

  txTable2.innerHTML = tx.slice(0,400).map(t=>{
    const sign = t.type==='credit' ? '-' : '';
    return `<tr><td>${new Date(t.date).toLocaleString()}</td><td>${sign}₹${Math.abs(t.amount).toFixed(2)}</td><td>${t.type}</td><td>${t.merchant||'Unknown'}</td><td>${t.card||'Unknown'}</td><td>${t.category||'Other'}</td><td contenteditable>${(t.tags||[]).join(' ')}</td><td contenteditable>${t.note||''}</td></tr>`;
  }).join('');

  drawCharts(tx);
}

function drawCharts(tx){
  const now=new Date(); const months=[];
  for(let i=11;i>=0;i--){const d=new Date(now.getFullYear(),now.getMonth()-i,1); months.push({label:d.toLocaleString(undefined,{month:'short'}), s:+new Date(d.getFullYear(),d.getMonth(),1), e:+new Date(d.getFullYear(),d.getMonth()+1,1)-1});}
  const mVals=months.map(m=>tx.filter(t=>t.type==='debit'&&t.date>=m.s&&t.date<=m.e).reduce((a,b)=>a+b.amount,0));

  const byCard={}, byCat={}, byMerch={};
  tx.forEach(t=>{
    if(t.type==='debit'){
      byCard[t.card||'Unknown']=(byCard[t.card||'Unknown']||0)+t.amount;
      byCat[t.category||'Other']=(byCat[t.category||'Other']||0)+t.amount;
    }
    byMerch[t.merchant||'Unknown']=(byMerch[t.merchant||'Unknown']||0)+t.amount;
  });

  const cum=[]; let run=0;
  tx.slice().sort((a,b)=>a.date-b.date).forEach(t=>{ run+=(t.type==='debit'?t.amount:0); cum.push({label:new Date(t.date).toLocaleDateString(undefined,{month:'short',day:'2-digit'}),value:run}); });

  // destroy any old Charts
  ["cMonthly","cByCard","cCumulative","cCategory","cWeekday","cTopMerch"].forEach(id=>{
    try { window[id]?.destroy?.(); } catch {}
  });

  window.cMonthly = new Chart($("#cMonthly").getContext("2d"), { type:"bar",
    data:{ labels:months.map(m=>m.label), datasets:[{ label:"₹", data:mVals.map(v=>Math.abs(v)) }]},
    options:{ plugins:{ legend:{ display:false } } }
  });

  window.cByCard = new Chart($("#cByCard").getContext("2d"), { type:"doughnut",
    data:{ labels:Object.keys(byCard), datasets:[{ data:Object.values(byCard).map(v=>Math.abs(v)) }]},
    options:{ plugins:{ legend:{ position:"bottom" } } }
  });

  window.cCumulative = new Chart($("#cCumulative").getContext("2d"), { type:"line",
    data:{ labels:cum.map(x=>x.label), datasets:[{ data:cum.map(x=>x.value), fill:false, tension:.25 }]},
    options:{ plugins:{ legend:{ display:false } } }
  });

  window.cCategory = new Chart($("#cCategory").getContext("2d"), { type:"doughnut",
    data:{ labels:Object.keys(byCat), datasets:[{ data:Object.values(byCat).map(v=>Math.abs(v)) }]},
    options:{ plugins:{ legend:{ position:"bottom" } } }
  });

  const weekday=[0,0,0,0,0,0,0];
  tx.forEach(t=>{ weekday[new Date(t.date).getDay()] += t.type==='debit' ? t.amount : 0; });
  window.cWeekday = new Chart($("#cWeekday").getContext("2d"), { type:"bar",
    data:{ labels:["Sun","Mon","Tue","Wed","Thu","Fri","Sat"], datasets:[{ label:"₹", data:weekday.map(v=>Math.abs(v)) }]},
    options:{ plugins:{ legend:{ display:false } } }
  });

  const top = Object.entries(byMerch).sort((a,b)=>b[1]-a[1]).slice(0,10);
  window.cTopMerch = new Chart($("#cTopMerch").getContext("2d"), { type:"bar",
    data:{ labels:top.map(x=>x[0]), datasets:[{ label:"₹", data:top.map(x=>Math.abs(x[1])) }]},
    options:{ plugins:{ legend:{ display:false } } }
  });
}

// boot
addEventListener("load", () => {
  renderAll();
  $("#btn-sw").addEventListener("click", async () => {
    try { await navigator.serviceWorker.register("sw.js"); log("✅ Service worker registered"); }
    catch(e){ log("SW failed: " + e.message); }
  });
});
