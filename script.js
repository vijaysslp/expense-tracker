// Expense Analyzer — v3.2
// - Auto-scan after connect
// - Wider query (365d) + fallback query
// - Progress logs, counts, empty-state helper + Demo Data
// - Category tags, search box, totals by category
// - Keeps CSV/XLSX import, charts, filters, exports, ICS

const CLIENT_ID = "263109576837-3iphn0jaf34739hdltpoaeccjlmf1p4j.apps.googleusercontent.com";
const SCOPES   = "https://www.googleapis.com/auth/gmail.readonly";

// ---------- UI handles ----------
const connectBtn   = document.getElementById("connectBtn");
const scanBtn      = document.getElementById("scanBtn");
const exportCsvBtn = document.getElementById("exportCsvBtn");
const backupBtn    = document.getElementById("backupBtn");
const fileInput    = document.getElementById("fileInput");
const logEl        = document.getElementById("log");
const totalAmtEl   = document.getElementById("totalAmt");
const txCountEl    = document.getElementById("txCount");
const byCardEl     = document.getElementById("byCard");
const upcomingEl   = document.getElementById("upcoming");
const topMerchantsEl = document.getElementById("topMerchants");

// Filters
const fromDateEl = document.getElementById("fromDate");
const toDateEl   = document.getElementById("toDate");
const typeFilter = document.getElementById("typeFilter");

// Add a simple search box to the filters row (no HTML change needed)
let searchInput = document.getElementById("searchInput__injected");
if (!searchInput) {
  const filtersCard = document.querySelector(".filters .row");
  const wrap = document.createElement("div");
  wrap.innerHTML = `
    <div>
      <label>Search</label>
      <input id="searchInput__injected" type="text" placeholder="merchant, card, note" style="min-width:220px;background:#0f1722;color:#cfe0ff;border:1px solid #263145;border-radius:10px;padding:8px 10px;">
    </div>`;
  if (filtersCard) filtersCard.insertBefore(wrap.firstElementChild, filtersCard.lastElementChild);
  searchInput = document.getElementById("searchInput__injected");
}
document.getElementById("applyFilterBtn").addEventListener("click", renderDashboard);
document.getElementById("clearFilterBtn").addEventListener("click", () => {
  fromDateEl.value = ""; toDateEl.value = ""; typeFilter.value = "all"; if (searchInput) searchInput.value=""; renderDashboard();
});

// ---------- State ----------
let tokenClient = null;
let accessToken = null;
const state = {
  transactions: [], // canonical list (positive debit/spend, negative credit/refund)
  searched: ""      // search query
};

// ---------- Logging ----------
function log(s){
  console.log(s);
  if (logEl) logEl.textContent = (new Date()).toISOString()+" — "+s+"\n"+logEl.textContent;
}
window.addEventListener("load", () => log("SCRIPT VERSION v3.2"));

// ---------- Auth ----------
window.addEventListener("load", () => {
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CLIENT_ID, scope: SCOPES,
    callback: (resp) => {
      if (resp.error) { log("Auth error: "+JSON.stringify(resp)); return; }
      accessToken = resp.access_token;
      log("✅ Connected to Gmail");
      scanBtn.disabled = false; exportCsvBtn.disabled = false; backupBtn.disabled = false;
      // Auto-scan right away
      scanGmail().catch(e => log("Auto-scan failed: " + (e.message||e)));
    }
  });

  connectBtn.addEventListener("click", () => tokenClient.requestAccessToken());
  scanBtn.addEventListener("click", () => scanGmail().catch(e => log("Scan failed: " + (e.message||e))));
  exportCsvBtn.addEventListener("click", exportCsv);
  backupBtn.addEventListener("click", exportBackup);
  fileInput.addEventListener("change", handleFileImport);
});

// ---------- Gmail scan ----------
async function gmailFetch(path, params = {}) {
  if (!accessToken) throw new Error("No access token yet");
  const url = new URL(`https://gmail.googleapis.com/gmail/v1/${path}`);
  Object.entries(params).forEach(([k,v]) => { if (v!==undefined && v!==null && v!=="") url.searchParams.set(k,v); });
  log("Gmail fetch: " + url.toString());
  const r = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!r.ok) throw new Error(`Gmail API error ${r.status}: ${await r.text()}`);
  return r.json();
}

const BANK_HINTS = ["icicibank","hdfcbank","axisbank","sbi","kotak","idfcfirstbank","sbicard","americanexpress","amex","onecard","citi","billdesk","razorpay"];
const DEBIT_WORDS  = /(spent|debited|purchase|paid|payment|txn|transaction.*(?:done|at|to|of)|swipe|pos|upi)/i;
const CREDIT_WORDS = /(credited|refund|reversal|reversed|cashback)/i;
const MIN_AMT = 1, MAX_AMT = 800000;

async function scanGmail(){
  state.transactions = [];
  renderDashboard();

  // 1) Primary query: last 365 days and typical financial keywords/senders
  const queryMain = [
    "newer_than:365d",
    "(subject:(receipt OR transaction OR debited OR credited OR payment OR spent)",
    "OR from:(" + BANK_HINTS.map(s=>"@"+s).join(" ") + "))"
  ].join(" ");

  const processed = await scanWithQuery(queryMain, 250);
  if (processed === 0) {
    // 2) Fallback query: last 365d ANYTHING with currency formats
    log("Primary query returned 0, trying broader fallback…");
    const queryFallback = "newer_than:365d (₹ OR Rs OR INR)";
    await scanWithQuery(queryFallback, 150);
  }

  if (state.transactions.length === 0) {
    log("No transactions found. If your statements are older than 1 year, edit the query window in script, or import CSV/XLSX.");
    injectDemoButton();
  }

  renderDashboard();
}

async function scanWithQuery(q, limit=200){
  log(`Starting scan… (${q})`);
  let next = undefined, processed = 0, kept = 0, seen = new Set();

  try {
    do {
      const params = { q, maxResults: 100 };
      if (typeof next === "string" && next.length>0) params.pageToken = next; // NEVER pass null/undefined
      const list = await gmailFetch("users/me/messages", params);
      next = list.nextPageToken;

      const batch = list.messages || [];
      log(`Page: ${batch.length} messages`);
      for (const m of batch) {
        if (processed >= limit) break;
        if (seen.has(m.id)) continue; seen.add(m.id);
        const full = await gmailFetch(`users/me/messages/${m.id}`, { format: "full" });
        await processMessage(full) && kept++;
        processed++;
      }
    } while (typeof next === "string" && next.length>0 && processed<limit);

    log(`Scan complete. Processed: ${processed}, Parsed tx: ${kept}, Total kept: ${state.transactions.length}`);
  } catch (e) {
    log("Scan failed: " + (e.message||e));
  }
  return processed;
}

// ---------- Message parsing ----------
function headerVal(headers, name){
  return (headers || []).find(h => h.name?.toLowerCase()===name.toLowerCase())?.value || "";
}
function bodyText(message){
  try{
    if (message.payload?.parts){
      for (const p of message.payload.parts){
        if (p.mimeType==="text/plain" && p.body?.data) return decodeB64(p.body.data);
        if (p.mimeType==="text/html"  && p.body?.data) return stripHtml(decodeB64(p.body.data));
      }
    }
    if (message.payload?.body?.data) return stripHtml(decodeB64(message.payload.body.data));
    if (message.snippet) return message.snippet;
  }catch{} return "";
}
function decodeB64(b64){ b64=b64.replace(/-/g,'+').replace(/_/g,'/'); while(b64.length%4)b64+='='; try{return decodeURIComponent(escape(atob(b64)));}catch{return atob(b64);} }
function stripHtml(html){ const d=document.createElement("div"); d.innerHTML=html; return d.textContent||d.innerText||""; }
function looksLikeFinance(from, subject){
  const f = (from||"").toLowerCase(), s=(subject||"").toLowerCase();
  return BANK_HINTS.some(k => f.includes(k) || s.includes(k));
}
function extractAmount(text){
  if(!text) return null;
  const re = /(?:INR|Rs\.?|₹)\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)|([0-9][0-9,]*(?:\.[0-9]{1,2})?)\s*(?:INR|Rs\.?|₹)/i;
  const m = text.match(re); if(!m) return null;
  const raw = (m[1]||m[2]).replace(/,/g,""); const amt = parseFloat(raw);
  if(isNaN(amt)||amt<MIN_AMT||amt>MAX_AMT) return null; return amt;
}
function detectType(text){ if(CREDIT_WORDS.test(text)) return "credit"; if(DEBIT_WORDS.test(text)) return "debit"; return "debit"; }
function detectMerchant(text){
  const at = text.match(/(?:at|to|via|merchant[:\s])\s*([A-Z0-9 &._-]{2,60})/i);
  if (at) return at[1].trim().replace(/\s+/g,' ');
  const near = text.match(/(?:INR|Rs\.?|₹)\s*[0-9,]+(?:\.[0-9]{1,2})?\s*(?:at|to)?\s*([A-Za-z][A-Za-z0-9 &._-]{2,40})?/i);
  if (near && near[1]) return near[1].trim().replace(/\s+/g,' ');
  return null;
}
function detectCard(text, headers){
  const tail = text.match(/(?:card|xx|ending)\s*[:#-]?\s*([0-9]{3,6}|[0-9]{4})/i);
  if (tail) return tail[1];
  const brands = (text.match(/(Visa|Mastercard|MasterCard|Amex|American Express|Rupay|RuPay|Discover)/i)||[])[1];
  if (brands) return brands;
  const hs=(headers||[]).map(h=>`${h.name}:${h.value}`).join("\n");
  const hb=(hs.match(/(Visa|Mastercard|Amex|Rupay|RuPay|Discover)/i)||[])[1];
  if(hb) return hb;
  return null;
}
function classifyCategory(t){
  const X = (t.merchant||"" + " " + (t.raw||"")).toLowerCase();
  if (/swiggy|zomato|pizza|restaurant|kfc|mcdonald|domino/i.test(X)) return "Food";
  if (/uber|ola|irctc|air|indigo|makemytrip|train|flight|fuel|petrol/i.test(X)) return "Travel";
  if (/amazon|flipkart|myntra|ajio|store|mall|shop|fashion/i.test(X)) return "Shopping";
  if (/electric|power|water|gas|dish|broadband|internet|mobile bill|postpaid|prepaid/i.test(X)) return "Utilities";
  if (/netflix|prime|spotify|subscription|invoice/i.test(X)) return "Subscriptions";
  if (/upi|transfer|imps|neft|rent/i.test(X)) return "Transfers";
  return "Other";
}
async function processMessage(msg){
  const headers = msg.payload?.headers || [];
  const from = headerVal(headers, "From");
  const subject = headerVal(headers, "Subject");
  const body = bodyText(msg);
  const text = (subject + "\n" + body).replace(/\s+/g,' ').trim();

  // Must look like finance OR include txn keywords
  const looksFinance = looksLikeFinance(from, subject) || DEBIT_WORDS.test(text) || CREDIT_WORDS.test(text);
  if (!looksFinance) return false;

  const amount = extractAmount(text);
  if (!amount) return false;

  const type = detectType(text);
  const sign = type === "credit" ? -1 : 1;
  const merchant = detectMerchant(text) || (from?.split(/[<@>]/)[1] ?? "Unknown");
  const card = detectCard(text, headers);
  const when = Number(msg.internalDate) || Date.now();

  const t = {
    date: when, amount: sign*amount, type, merchant, card,
    messageId: msg.id, source:"gmail", snippet: msg.snippet, raw: body
  };
  t.category = classifyCategory(t);
  state.transactions.push(t);
  return true;
}

// ---------- Import CSV / Excel ----------
async function handleFileImport(e){
  const file = e.target.files?.[0]; if(!file) return;
  try{
    if (file.name.toLowerCase().endsWith(".csv")) {
      const text = await file.text(); mergeCsv(text);
    } else {
      const data = await file.arrayBuffer();
      const wb = XLSX.read(data, {type:"array"});
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const json = XLSX.utils.sheet_to_json(sheet, {raw:true});
      json.forEach(r=>{
        const d = new Date(r.date || r.Date || r.DATE).getTime();
        let amt = Number(r.amount ?? r.Amount ?? r.AMOUNT);
        const type = (r.type ?? r.Type ?? r.TYPE ?? "debit").toString().toLowerCase().includes("credit") ? "credit" : "debit";
        if (type==="credit") amt = -Math.abs(amt);
        if (!Number.isFinite(amt)) return;
        const t = {
          date: Number.isFinite(d) ? d : Date.now(),
          amount: amt, type,
          merchant: r.merchant ?? r.Merchant ?? r.MERCHANT ?? "Imported",
          card: r.card ?? r.Card ?? r.CARD ?? null,
          source: "import", snippet: "", raw: JSON.stringify(r)
        };
        t.category = classifyCategory(t);
        state.transactions.push(t);
      });
    }
    log(`Imported: ${file.name}. Total tx: ${state.transactions.length}`);
    renderDashboard();
  }catch(err){
    log("Import failed: " + (err.message||err));
  }finally{
    e.target.value = "";
  }
}
function mergeCsv(text){
  const lines = text.split(/\r?\n/).filter(Boolean);
  const headers = lines.shift().split(",").map(h => h.trim().toLowerCase());
  const idx = (n)=>headers.indexOf(n);
  const iDate=idx("date"), iAmount=idx("amount"), iType=idx("type"), iMerch=idx("merchant"), iCard=idx("card");
  lines.forEach(line=>{
    const cols = splitCsv(line);
    const d = new Date(cols[iDate]).getTime();
    let amt = Number(cols[iAmount]);
    const type = (cols[iType]||"debit").toLowerCase().includes("credit") ? "credit" : "debit";
    if (type==="credit") amt = -Math.abs(amt);
    if (!Number.isFinite(amt)) return;
    const t = {
      date: Number.isFinite(d) ? d : Date.now(),
      amount: amt, type,
      merchant: cols[iMerch] || "Imported", card: cols[iCard] || null,
      source:"import", snippet:"", raw: line
    };
    t.category = classifyCategory(t);
    state.transactions.push(t);
  });
}
function splitCsv(line){
  const out=[]; let cur="", inQ=false;
  for(let i=0;i<line.length;i++){
    const ch=line[i];
    if(ch==='\"'){ if(inQ && line[i+1]==='\"'){ cur+='\"'; i++; } else inQ=!inQ; }
    else if(ch===',' && !inQ){ out.push(cur); cur=""; }
    else cur+=ch;
  }
  out.push(cur); return out.map(s=>s.trim().replace(/^"|"$/g,""));
}

// ---------- Dashboard, filters, charts ----------
let chartBar, chartPie, chartLine;

function filteredTx(){
  const from = fromDateEl.value ? new Date(fromDateEl.value).getTime() : -Infinity;
  const to   = toDateEl.value   ? new Date(toDateEl.value).getTime() + 24*60*60*1000 - 1 : Infinity;
  const type = typeFilter.value;
  const q    = (document.getElementById("searchInput__injected")?.value||"").toLowerCase();

  return state.transactions.filter(t=>{
    if (t.date < from || t.date > to) return false;
    if (type!=="all" && t.type!==type) return false;
    if (q && !( (t.merchant||"").toLowerCase().includes(q) || (t.card||"").toLowerCase().includes(q) || (t.category||"").toLowerCase().includes(q) )) return false;
    return true;
  });
}

function renderDashboard(){
  const tx = filteredTx().sort((a,b)=>b.date-a.date);

  const total = tx.reduce((s,t)=>s+(t.amount||0),0);
  totalAmtEl.textContent = `₹ ${Math.abs(total).toFixed(2)}`;
  txCountEl.textContent  = `${tx.length} transactions`;

  // By card
  const byCard = {};
  tx.forEach(t=>{
    const k = t.card || "Unknown";
    byCard[k] = byCard[k] || {count:0,sum:0};
    byCard[k].count++; byCard[k].sum += t.amount;
  });
  byCardEl.innerHTML = Object.entries(byCard)
    .map(([k,v])=>`<div>${escapeHtml(k)}: ${v.count} tx • ₹${Math.abs(v.sum).toFixed(2)}</div>`)
    .join('') || "—";

  // Top merchants
  const merch = {};
  tx.forEach(t=>{ const k=t.merchant||"Unknown"; merch[k]=(merch[k]||0)+Math.max(0,t.amount); });
  const top = Object.entries(merch).sort((a,b)=>b[1]-a[1]).slice(0,6);
  topMerchantsEl.innerHTML = top.length ? top.map(([m,v])=>`<div>${escapeHtml(m)} — ₹${v.toFixed(2)}</div>`).join("") : "—";

  // Upcoming (simple heuristic)
  const upcoming = tx.filter(t => /due|statement|minimum due|payment due|bill due|last date/i.test(t.raw||t.snippet||''))
                     .sort((a,b)=>a.date-b.date).slice(0,6);
  upcomingEl.innerHTML = upcoming.length
    ? upcoming.map(u=>{
        const d = new Date(u.date);
        return `<div style="cursor:pointer" onclick="createIcs(${u.date}, ${Math.round(Math.abs(u.amount)*100)}, '${escapeHtml(u.merchant||'Unknown')}')">
          • ${escapeHtml(u.merchant||'Unknown')} — ₹${Math.abs(u.amount).toFixed(2)} — ${d.toLocaleDateString()}
        </div>`;
      }).join('')
    : "No obvious upcoming bills found";

  // Table
  const tbody = document.querySelector("#txTable tbody");
  tbody.innerHTML = tx.slice(0,200).map(t=>`<tr>
    <td>${new Date(t.date).toLocaleString()}</td>
    <td>${t.type==="credit"?"-":""}₹${Math.abs(t.amount).toFixed(2)}</td>
    <td>${escapeHtml(t.merchant||'Unknown')} <span style="opacity:.7">· ${escapeHtml(t.category||'Other')}</span></td>
    <td>${escapeHtml(t.card||'Unknown')}</td>
    <td>${escapeHtml(t.source)}</td>
  </tr>`).join('');

  renderCharts(tx);
}

function renderCharts(tx){
  // Monthly spend (debits only, last 12 months)
  const now = new Date();
  const months = [];
  for(let i=11;i>=0;i--){
    const d = new Date(now.getFullYear(), now.getMonth()-i, 1);
    months.push({ label: d.toLocaleString(undefined,{month:"short", year:"2-digit"}), key: d.getFullYear()+"-"+(d.getMonth()+1) });
  }
  const monthSums = months.map(m=>{
    const [y,mo] = m.key.split("-").map(Number);
    const start = new Date(y, mo-1, 1).getTime();
    const end   = new Date(y, mo, 1).getTime()-1;
    return tx.filter(t=>t.type==="debit" && t.date>=start && t.date<=end)
             .reduce((s,t)=>s+(t.amount||0),0);
  });

  const byCard = {};
  tx.filter(t=>t.type==="debit").forEach(t=>{
    const k=t.card||"Unknown"; byCard[k]=(byCard[k]||0)+t.amount;
  });

  const cumulative = [];
  let run=0;
  tx.slice().sort((a,b)=>a.date-b.date).forEach(t=>{
    run += t.amount;
    cumulative.push({x:new Date(t.date), y: Math.max(0, run)});
  });

  if (chartBar) chartBar.destroy();
  chartBar = new Chart(document.getElementById("barMonthly"), {
    type: "bar",
    data: { labels: months.map(m=>m.label), datasets: [{ label:"₹ spend", data: monthSums.map(v=>Math.abs(v)) }] },
    options: { responsive: true, plugins:{legend:{display:false}} }
  });

  if (chartPie) chartPie.destroy();
  const pieLabels = Object.keys(byCard), pieData = Object.values(byCard).map(v=>Math.abs(v));
  chartPie = new Chart(document.getElementById("pieByCard"), {
    type: "doughnut",
    data: { labels: pieLabels, datasets:[{ data: pieData }] },
    options: { responsive:true, plugins:{ legend:{ position:'bottom' } } }
  });

  if (chartLine) chartLine.destroy();
  chartLine = new Chart(document.getElementById("lineCumulative"), {
    type: "line",
    data: { datasets:[{ data: cumulative, parsing:false }] },
    options: {
      responsive:true, plugins:{legend:{display:false}},
      scales:{ x:{ type:'time', time:{ unit:'month'} } }
    }
  });
}

function escapeHtml(s){
  return (s||'').toString()
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ---------- Exports ----------
function exportCsv(){
  const tx = filteredTx();
  if (!tx.length) { alert("No transactions"); return; }
  const rows = [["date","amount","type","merchant","card","category","source"]];
  tx.forEach(t => rows.push([
    new Date(t.date).toISOString(), t.amount.toFixed(2), t.type, t.merchant||'', t.card||'', t.category||'', t.source
  ]));
  const csv = rows.map(r=>r.map(c=>`"${(c||'').toString().replace(/"/g,'""')}"`).join(",")).join("\n");
  const blob = new Blob([csv], {type:"text/csv"});
  const url = URL.createObjectURL(blob); const a = document.createElement("a");
  a.href=url; a.download="expenses.csv"; a.click(); URL.revokeObjectURL(url);
}
function exportBackup(){
  const data = { exportedAt: new Date().toISOString(), transactions: state.transactions };
  const blob = new Blob([JSON.stringify(data,null,2)], {type:"application/json"});
  const url = URL.createObjectURL(blob); const a=document.createElement("a");
  a.href=url; a.download="expenses-backup.json"; a.click(); URL.revokeObjectURL(url);
}

// ---------- ICS reminders ----------
window.createIcs = (whenMillis, amountPaise, merchantEsc) => {
  const deltas=[7,3,2,0];
  deltas.forEach(delta=>{
    const dt=new Date(whenMillis - delta*24*60*60*1000);
    const dtStr=dt.toISOString().replace(/[-:]/g,'').split('.')[0]+'Z';
    const uid='exp-'+whenMillis+'-'+delta+'@local';
    const summary=`Pay ${merchantEsc} — ₹${(amountPaise/100).toFixed(2)} (due ${new Date(whenMillis).toLocaleDateString()})`;
    const ics=['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//ExpenseAnalyzer//EN','BEGIN:VEVENT',`UID:${uid}`,`DTSTAMP:${new Date().toISOString().replace(/[-:]/g,'').split('.')[0]}Z`,`DTSTART:${dtStr}`,`SUMMARY:${summary}`,'DESCRIPTION:Auto-generated reminder','END:VEVENT','END:VCALENDAR'].join('\r\n');
    const blob=new Blob([ics],{type:'text/calendar'}); const url=URL.createObjectURL(blob);
    const a=document.createElement('a'); a.href=url; a.download=`reminder-${uid}.ics`; a.click(); URL.revokeObjectURL(url);
  });
  alert("Downloaded .ics reminders. Import them into your calendar.");
};

// ---------- Demo data (for empty state) ----------
function injectDemoButton(){
  const btnId = "loadDemo__injected";
  if (document.getElementById(btnId)) return;
  const actions = document.querySelector(".actions");
  const b = document.createElement("button");
  b.id = btnId; b.className = "btn ghost"; b.textContent = "Load Demo Data";
  b.onclick = () => {
    const base = Date.now();
    const demo = [
      {d: -3, amt: 3499, m:"Jio Mart",  card:"3183", cat:"Shopping"},
      {d: -5, amt: 220,  m:"Swiggy",    card:"8675", cat:"Food"},
      {d: -10,amt: 799,  m:"Netflix",   card:"3183", cat:"Subscriptions"},
      {d: -15,amt: 1500, m:"IRCTC",     card:"Visa", cat:"Travel"},
      {d: -18,amt:-500,  m:"Refund - Amazon", card:"3183", cat:"Shopping"},
      {d: -22,amt: 899,  m:"Airtel Postpaid", card:"8675", cat:"Utilities"},
    ];
    demo.forEach(x=>{
      state.transactions.push({
        date: base + x.d*24*60*60*1000,
        amount: x.amt<0 ? x.amt : Number(x.amt),
        type: x.amt<0 ? "credit" : "debit",
        merchant: x.m, card: x.card, category: x.cat,
        source:"demo", snippet:"", raw:""
      });
    });
    renderDashboard();
    log("Demo data loaded");
  };
  actions?.appendChild(b);
}
