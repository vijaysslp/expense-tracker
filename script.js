// Expense Analyzer — v3.1 (UI+Charts+Import)
// Includes v3 strict parsing + dashboards, filters, CSV/XLSX import.
// Shows "SCRIPT VERSION v3.1" in the logs.

const CLIENT_ID = "263109576837-3iphn0jaf34739hdltpoaeccjlmf1p4j.apps.googleusercontent.com";
const SCOPES   = "https://www.googleapis.com/auth/gmail.readonly";

let tokenClient = null;
let accessToken = null;

const connectBtn   = document.getElementById("connectBtn");
const scanBtn      = document.getElementById("scanBtn");
const exportCsvBtn = document.getElementById("exportCsvBtn");
const backupBtn    = document.getElementById("backupBtn");
const fileInput    = document.getElementById("fileInput");
const logEl        = document.getElementById("log");

// Filters
const fromDateEl = document.getElementById("fromDate");
const toDateEl   = document.getElementById("toDate");
const typeFilter = document.getElementById("typeFilter");
document.getElementById("applyFilterBtn").addEventListener("click", renderDashboard);
document.getElementById("clearFilterBtn").addEventListener("click", () => {
  fromDateEl.value = ""; toDateEl.value = ""; typeFilter.value = "all"; renderDashboard();
});

const state = {
  transactions: []  // canonical list (positive = debit spend, negative = credit/refund)
};

function log(s){
  console.log(s);
  if (logEl) logEl.textContent = (new Date()).toISOString()+" — "+s+"\n"+logEl.textContent;
}

window.addEventListener("load", () => {
  log("SCRIPT VERSION v3.1");

  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CLIENT_ID,
    scope: SCOPES,
    callback: (resp) => {
      if (resp.error) { log("Auth error: "+JSON.stringify(resp)); return; }
      accessToken = resp.access_token;
      log("✅ Connected to Gmail");
      scanBtn.disabled = false; exportCsvBtn.disabled = false; backupBtn.disabled = false;
    }
  });

  connectBtn.addEventListener("click", () => tokenClient.requestAccessToken());
  scanBtn.addEventListener("click", scanGmail);
  exportCsvBtn.addEventListener("click", exportCsv);
  backupBtn.addEventListener("click", exportBackup);
  fileInput.addEventListener("change", handleFileImport);
});

// ------------- Gmail scan (same strict logic as v3) -------------
const ALLOW_SENDERS = ["icicibank","hdfcbank","axisbank","sbi","kotak","idfcfirstbank","paytm","razorpay","billdesk","hdfcbankalerts","icicicards","axisbankalerts","citi","americanexpress","amex","onecard","slice","sbicard","federalbank","yesbank","indusind","upi","gpay","phonepe","amazonpay","flipkart","swiggy","zomato","makemytrip","airindia","irctc","ola","uber"];
const DEBIT_WORDS  = /(spent|debited|purchase|paid|payment|txn|transaction.*(?:done|at|to|of)|swipe|pos|upi)/i;
const CREDIT_WORDS = /(credited|refund|reversal|reversed|cashback)/i;
const MIN_AMT = 1, MAX_AMT = 500000;

async function gmailFetch(path, params = {}) {
  if (!accessToken) throw new Error("No access token yet");
  const url = new URL(`https://gmail.googleapis.com/gmail/v1/${path}`);
  Object.entries(params).forEach(([k,v]) => { if (v!==undefined && v!==null && v!=="") url.searchParams.set(k,v); });
  log("Gmail fetch: " + url.toString());
  const r = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!r.ok) throw new Error(`Gmail API error ${r.status}: ${await r.text()}`);
  return r.json();
}

async function scanGmail(){
  state.transactions = []; // reset
  renderDashboard();

  try {
    log("Starting scan… (last 180 days, up to 200 emails)");
    const q = [
      "newer_than:180d",
      "(subject:(receipt OR transaction OR debited OR credited OR payment OR spent)",
      "OR from:(@icicibank @hdfcbank @axisbank @sbi @paytm @razorpay @kotak @idfcfirstbank @sbicard @americanexpress))"
    ].join(" ");

    let next = undefined, processed = 0, limit = 200, seen = new Set();

    do {
      const params = { q, maxResults: 100 };
      if (typeof next === "string" && next.length>0) params.pageToken = next;
      const list = await gmailFetch("users/me/messages", params);
      next = list.nextPageToken;
      for (const m of (list.messages||[])) {
        if (processed >= limit) break;
        if (seen.has(m.id)) continue; seen.add(m.id);
        const full = await gmailFetch(`users/me/messages/${m.id}`, { format: "full" });
        await processMessage(full); processed++;
      }
    } while (typeof next === "string" && next.length>0 && processed<limit);

    log(`Scan complete. Processed: ${processed}, Kept: ${state.transactions.length}`);
    renderDashboard();
  } catch (e) { log("Scan failed: " + (e.message||e)); console.error(e); }
}

function headerVal(headers, name){
  return (headers || []).find(h => h.name?.toLowerCase()===name.toLowerCase())?.value || "";
}
function looksLikeAllowedSender(fromHeader){
  const h = (fromHeader||"").toLowerCase(); return ALLOW_SENDERS.some(k => h.includes(k));
}
function getMessageBody(message){
  try{
    if (message.payload?.parts){
      for (const p of message.payload.parts){
        if (p.mimeType==="text/plain" && p.body?.data) return decodeBase64Url(p.body.data);
        if (p.mimeType==="text/html"  && p.body?.data) return stripHtml(decodeBase64Url(p.body.data));
      }
    }
    if (message.payload?.body?.data) return stripHtml(decodeBase64Url(message.payload.body.data));
    if (message.snippet) return message.snippet;
  }catch{} return "";
}
function decodeBase64Url(b64){ b64=b64.replace(/-/g,'+').replace(/_/g,'/'); while(b64.length%4)b64+='='; try{return decodeURIComponent(escape(atob(b64)));}catch{return atob(b64);} }
function stripHtml(html){ const d=document.createElement("div"); d.innerHTML=html; return d.textContent||d.innerText||""; }
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
async function processMessage(msg){
  const headers = msg.payload?.headers || [];
  const from = headerVal(headers, "From");
  const subject = headerVal(headers, "Subject");
  const body = getMessageBody(msg);
  const text = (subject + "\n" + body).replace(/\s+/g,' ').trim();

  const allowedSender = looksLikeAllowedSender(from);
  const looksTxn = DEBIT_WORDS.test(text) || CREDIT_WORDS.test(text);
  if (!allowedSender && !looksTxn) return;

  const amount = extractAmount(text);
  if (!amount) return;

  const type = detectType(text);
  const sign = type === "credit" ? -1 : 1;
  const merchant = detectMerchant(text) || (allowedSender ? (from.split(/[<@>]/)[1] || "Unknown") : "Unknown");
  const card = detectCard(text, headers);
  const when = Number(msg.internalDate) || Date.now();

  state.transactions.push({
    date: when, amount: sign*amount, type, merchant, card,
    messageId: msg.id, source:"gmail", snippet: msg.snippet, raw: body
  });
}

// ------------- Import CSV / Excel -------------
async function handleFileImport(e){
  const file = e.target.files?.[0]; if(!file) return;
  const name = file.name.toLowerCase();

  try{
    if(name.endsWith(".csv")){
      const text = await file.text();
      mergeCsv(text);
    }else{
      // Excel via SheetJS
      const data = await file.arrayBuffer();
      const wb = XLSX.read(data, {type:"array"});
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const json = XLSX.utils.sheet_to_json(sheet, {raw:true});
      // Expect headers like: date, amount, type (debit/credit), merchant, card
      json.forEach(r=>{
        const d = new Date(r.date || r.Date || r.DATE).getTime();
        let amt = Number(r.amount ?? r.Amount ?? r.AMOUNT);
        const type = (r.type ?? r.Type ?? r.TYPE ?? "debit").toString().toLowerCase().includes("credit") ? "credit" : "debit";
        if (type==="credit") amt = -Math.abs(amt);
        if (!Number.isFinite(amt)) return;
        state.transactions.push({
          date: Number.isFinite(d) ? d : Date.now(),
          amount: amt,
          type,
          merchant: r.merchant ?? r.Merchant ?? r.MERCHANT ?? "Imported",
          card: r.card ?? r.Card ?? r.CARD ?? null,
          source: "import",
          snippet: "",
          raw: JSON.stringify(r)
        });
      });
    }
    log(`Imported from ${file.name}. Total tx now: ${state.transactions.length}`);
    renderDashboard();
  }catch(err){
    log("Import failed: " + (err.message||err));
  }finally{
    e.target.value = "";
  }
}

function mergeCsv(text){
  // naive CSV (expects header row)
  const lines = text.split(/\r?\n/).filter(Boolean);
  const headers = lines.shift().split(",").map(h => h.trim().toLowerCase());
  const idx = (name) => headers.indexOf(name);

  const iDate = idx("date"), iAmount = idx("amount"), iType = idx("type"), iMerch = idx("merchant"), iCard = idx("card");
  lines.forEach(line=>{
    const cols = splitCsv(line);
    const d = new Date(cols[iDate]).getTime();
    let amt = Number(cols[iAmount]);
    const type = (cols[iType]||"debit").toLowerCase().includes("credit") ? "credit" : "debit";
    if (type==="credit") amt = -Math.abs(amt);
    if (!Number.isFinite(amt)) return;

    state.transactions.push({
      date: Number.isFinite(d) ? d : Date.now(),
      amount: amt, type,
      merchant: cols[iMerch] || "Imported", card: cols[iCard] || null,
      source:"import", snippet:"", raw: line
    });
  });
}
function splitCsv(line){
  // handle "a,b","c" style
  const out=[]; let cur="", inQ=false;
  for(let i=0;i<line.length;i++){
    const ch=line[i];
    if(ch==='\"'){ if(inQ && line[i+1]==='\"'){ cur+='\"'; i++; } else inQ=!inQ; }
    else if(ch===',' && !inQ){ out.push(cur); cur=""; }
    else cur+=ch;
  }
  out.push(cur); return out.map(s=>s.trim().replace(/^"|"$/g,""));
}

// ------------- Dashboard, filters, charts -------------
let chartBar, chartPie, chartLine;

function filteredTx(){
  const from = fromDateEl.value ? new Date(fromDateEl.value).getTime() : -Infinity;
  const to   = toDateEl.value   ? new Date(toDateEl.value).getTime() + 24*60*60*1000 - 1 : Infinity;
  const type = typeFilter.value;

  return state.transactions.filter(t=>{
    if (t.date < from || t.date > to) return false;
    if (type!=="all" && t.type!==type) return false;
    return true;
  });
}

function renderDashboard(){
  const tx = filteredTx().sort((a,b)=>b.date-a.date);

  const total = tx.reduce((s,t)=>s+(t.amount||0),0);
  document.getElementById("totalAmt").textContent = `₹ ${Math.abs(total).toFixed(2)}`;
  document.getElementById("txCount").textContent  = `${tx.length} transactions`;

  // By card
  const byCard = {};
  tx.forEach(t=>{
    const k = t.card || "Unknown";
    byCard[k] = byCard[k] || {count:0,sum:0};
    byCard[k].count++; byCard[k].sum += t.amount;
  });
  document.getElementById("byCard").innerHTML =
    Object.entries(byCard).map(([k,v])=>`<div>${escapeHtml(k)}: ${v.count} tx • ₹${Math.abs(v.sum).toFixed(2)}</div>`).join('') || "—";

  // Top merchants
  const merch = {};
  tx.forEach(t=>{ const k=t.merchant||"Unknown"; merch[k]=(merch[k]||0)+Math.max(0,t.amount); });
  const top = Object.entries(merch).sort((a,b)=>b[1]-a[1]).slice(0,6);
  document.getElementById("topMerchants").innerHTML =
    top.length ? top.map(([m,v])=>`<div>${escapeHtml(m)} — ₹${v.toFixed(2)}</div>`).join("") : "—";

  // Upcoming (simple heuristic)
  const upcoming = tx.filter(t => /due|statement|minimum due|payment due/i.test(t.raw||t.snippet||''))
                     .sort((a,b)=>a.date-b.date).slice(0,6);
  document.getElementById("upcoming").innerHTML = upcoming.length
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
    <td>${escapeHtml(t.merchant||'Unknown')}</td>
    <td>${escapeHtml(t.card||'Unknown')}</td>
    <td>${escapeHtml(t.source)}</td>
  </tr>`).join('');

  renderCharts(tx);
}

function renderCharts(tx){
  // Monthly Spend (debits only, last 12 months)
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
    if (t.type==="debit") run += t.amount;
    if (t.type==="credit") run += t.amount; // credits negative
    cumulative.push({x:new Date(t.date), y: Math.max(0, run)});
  });

  // Bar
  if (chartBar) chartBar.destroy();
  chartBar = new Chart(document.getElementById("barMonthly"), {
    type: "bar",
    data: { labels: months.map(m=>m.label), datasets: [{ label:"₹ spend", data: monthSums.map(v=>Math.abs(v)) }] },
    options: { responsive: true, plugins:{legend:{display:false}} }
  });

  // Pie
  if (chartPie) chartPie.destroy();
  const pieLabels = Object.keys(byCard), pieData = Object.values(byCard).map(v=>Math.abs(v));
  chartPie = new Chart(document.getElementById("pieByCard"), {
    type: "doughnut",
    data: { labels: pieLabels, datasets:[{ data: pieData }] },
    options: { responsive:true, plugins:{ legend:{ position:'bottom' } } }
  });

  // Line
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

function exportCsv(){
  const tx = filteredTx();
  if (!tx.length) { alert("No transactions"); return; }
  const rows = [["date","amount","type","merchant","card","source"]];
  tx.forEach(t => rows.push([
    new Date(t.date).toISOString(), t.amount.toFixed(2), t.type, t.merchant||'', t.card||'', t.source
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

// ICS reminders (7/3/2/0)
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
