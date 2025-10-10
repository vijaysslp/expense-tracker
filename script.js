// Expense Analyzer (Gmail) — v3 (stricter parsing)
// Shows "SCRIPT VERSION v3" on load.

const CLIENT_ID = "263109576837-3iphn0jaf34739hdltpoaeccjlmf1p4j.apps.googleusercontent.com";
const SCOPES   = "https://www.googleapis.com/auth/gmail.readonly";

let tokenClient = null;
let accessToken = null;

const connectBtn   = document.getElementById("connectBtn");
const scanBtn      = document.getElementById("scanBtn");
const exportCsvBtn = document.getElementById("exportCsvBtn");
const backupBtn    = document.getElementById("backupBtn");
const logEl        = document.getElementById("log");

const state = {
  transactions: []  // {date, amount, type, merchant, card, messageId, source, snippet, raw}
};

// Known senders and hints (India-heavy list; add yours below)
const ALLOW_SENDERS = [
  "icicibank", "hdfcbank", "axisbank", "sbi", "kotak", "idfcfirstbank",
  "paytm", "razorpay", "billdesk", "hdfcbankalerts", "icicisecure", "icicicards",
  "axisbankalerts", "citi", "americanexpress", "amex", "onecard", "slice", "sbicard",
  "federalbank", "yesbank", "indusind", "upi", "gpay", "phonepe", "amazonpay",
  "flipkart", "swiggy", "zomato", "makemytrip", "airindia", "irctc", "ola", "uber"
];

// Debits vs credits words
const DEBIT_WORDS  = /(spent|debited|purchase|paid|payment|txn|transaction.*(?:done|at|to|of)|swipe|pos|upi)/i;
const CREDIT_WORDS = /(credited|refund|reversal|reversed|cashback)/i;

// Amount sanity (INR)
const MIN_AMT = 1;
const MAX_AMT = 500000;

// Helper logging
function log(s){
  console.log(s);
  if (logEl) logEl.textContent = (new Date()).toISOString()+" — "+s+"\n"+logEl.textContent;
}

window.addEventListener("load", () => {
  log("SCRIPT VERSION v3");

  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CLIENT_ID,
    scope: SCOPES,
    callback: (resp) => {
      if (resp.error) { log("Auth error: "+JSON.stringify(resp)); return; }
      accessToken = resp.access_token;
      log("✅ Connected to Gmail");
      scanBtn.disabled = false;
      exportCsvBtn.disabled = false;
      backupBtn.disabled = false;
    }
  });

  connectBtn.addEventListener("click", () => tokenClient.requestAccessToken());
  scanBtn.addEventListener("click", scanGmail);
  exportCsvBtn.addEventListener("click", exportCsv);
  backupBtn.addEventListener("click", exportBackup);
});

// Gmail fetch helper — skip null/empty params
async function gmailFetch(path, params = {}) {
  if (!accessToken) throw new Error("No access token yet");
  const url = new URL(`https://gmail.googleapis.com/gmail/v1/${path}`);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, v);
  });
  log("Gmail fetch: " + url.toString());
  const r = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!r.ok) throw new Error(`Gmail API error ${r.status}: ${await r.text()}`);
  return r.json();
}

async function scanGmail(){
  state.transactions = [];
  renderDashboard();

  try {
    log("Starting scan… (last 180 days, up to 200 emails)");
    // Narrow the search window to reduce noise
    const q = [
      "newer_than:180d",
      "(subject:(receipt OR transaction OR debited OR credited OR payment OR spent)",
      "OR from:(@icicibank @hdfcbank @axisbank @sbi @paytm @razorpay @kotak @idfcfirstbank @sbicard @americanexpress))"
    ].join(" ");

    let nextPageToken = undefined;
    let processed = 0;
    const limit = 200;
    const seen = new Set(); // de-dupe by message id

    do {
      const params = { q, maxResults: 100 };
      if (typeof nextPageToken === "string" && nextPageToken.length > 0) {
        params.pageToken = nextPageToken;
      }
      const list = await gmailFetch("users/me/messages", params);

      nextPageToken = list.nextPageToken;
      const msgs = list.messages || [];
      for (const m of msgs) {
        if (processed >= limit) break;
        if (seen.has(m.id)) continue;
        seen.add(m.id);

        const full = await gmailFetch(`users/me/messages/${m.id}`, { format: "full" });
        await processMessage(full);
        processed++;
      }
    } while (typeof nextPageToken === "string" && nextPageToken.length > 0 && processed < limit);

    log(`Scan complete. Processed: ${processed}, Kept: ${state.transactions.length}`);
    renderDashboard();
  } catch (e) {
    log("Scan failed: " + (e.message || e));
    console.error(e);
  }
}

// --------- Parsing helpers (stricter) ----------

function headerVal(headers, name){
  return (headers || []).find(h => h.name?.toLowerCase() === name.toLowerCase())?.value || "";
}

function looksLikeAllowedSender(fromHeader){
  const h = (fromHeader || "").toLowerCase();
  return ALLOW_SENDERS.some(k => h.includes(k));
}

function getMessageBody(message) {
  try {
    if (message.payload?.parts) {
      for (const p of message.payload.parts) {
        if (p.mimeType === "text/plain" && p.body?.data) return decodeBase64Url(p.body.data);
        if (p.mimeType === "text/html"  && p.body?.data) return stripHtml(decodeBase64Url(p.body.data));
      }
    }
    if (message.payload?.body?.data) return stripHtml(decodeBase64Url(message.payload.body.data));
    if (message.snippet) return message.snippet;
  } catch {}
  return "";
}

function decodeBase64Url(b64) {
  b64 = b64.replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4) b64 += '=';
  try { return decodeURIComponent(escape(atob(b64))); } catch { return atob(b64); }
}

function stripHtml(html) {
  const div = document.createElement("div");
  div.innerHTML = html;
  return div.textContent || div.innerText || "";
}

// Stricter amount capture: require currency token within 12 chars of number
function extractAmount(text){
  if (!text) return null;
  // e.g., "INR 1,234.56", "Rs. 1234", "₹ 999.99"
  const re = new RegExp(
    "(?:INR|Rs\\.?|₹)\\s*([0-9][0-9,]*(?:\\.[0-9]{1,2})?)"  // currency before number
    +"|"
    +"([0-9][0-9,]*(?:\\.[0-9]{1,2})?)\\s*(?:INR|Rs\\.?|₹)", // number before currency
    "i"
  );
  const m = text.match(re);
  if (!m) return null;
  const raw = (m[1] || m[2]).replace(/,/g, "");
  const amt = parseFloat(raw);
  if (isNaN(amt) || amt < MIN_AMT || amt > MAX_AMT) return null;
  return amt;
}

function detectType(text){
  if (CREDIT_WORDS.test(text)) return "credit";
  if (DEBIT_WORDS.test(text))  return "debit";
  // default to debit to avoid inflating refunds
  return "debit";
}

function detectMerchant(text){
  // Pull short readable merchant names
  const at = text.match(/(?:at|to|via|merchant[:\s])\s*([A-Z0-9 &._-]{2,60})/i);
  if (at) return at[1].trim().replace(/\s+/g,' ');
  // fallback to a capitalized token near currency
  const near = text.match(/(?:INR|Rs\.?|₹)\s*[0-9,]+(?:\.[0-9]{1,2})?\s*(?:at|to)?\s*([A-Za-z][A-Za-z0-9 &._-]{2,40})?/i);
  if (near && near[1]) return near[1].trim().replace(/\s+/g,' ');
  return null;
}

function detectCard(text, headers){
  // Look for last-4 or brand
  const tail = text.match(/(?:card|xx|ending)\s*[:#-]?\s*([0-9]{3,6}|[0-9]{4})/i);
  if (tail) return tail[1];
  const brands = (text.match(/(Visa|Mastercard|MasterCard|Amex|American Express|Rupay|RuPay|Discover)/i) || [])[1];
  if (brands) return brands;
  // headers clue
  const hs = (headers||[]).map(h=>`${h.name}:${h.value}`).join("\n");
  const hb = (hs.match(/(Visa|Mastercard|Amex|Rupay|RuPay|Discover)/i) || [])[1];
  if (hb) return hb;
  return null;
}

async function processMessage(msg){
  const headers = msg.payload?.headers || [];
  const from = headerVal(headers, "From");
  const subject = headerVal(headers, "Subject");
  const body = getMessageBody(msg);
  const text = (subject + "\n" + body).replace(/\s+/g,' ').trim();

  // Keep only strong signals to reduce noise
  const allowedSender = looksLikeAllowedSender(from);
  const looksTxn = DEBIT_WORDS.test(text) || CREDIT_WORDS.test(text);
  if (!allowedSender && !looksTxn) return;

  const amount = extractAmount(text);
  if (!amount) return;

  const type = detectType(text);
  const sign = type === "credit" ? -1 : 1;  // credits reduce total spend
  const merchant = detectMerchant(text) || (allowedSender ? (from.split(/[<@>]/)[1] || "Unknown") : "Unknown");
  const card = detectCard(text, headers);

  // Use Gmail's internalDate (server receive time) for correctness
  const when = Number(msg.internalDate) || Date.now();

  state.transactions.push({
    date: when,
    amount: sign * amount,
    type, merchant, card,
    messageId: msg.id,
    source: "gmail",
    snippet: msg.snippet,
    raw: body
  });
}

// --------------- UI & exports -----------------

function renderDashboard(){
  // Totals: spend = sum of amounts (credits are negative)
  const total = state.transactions.reduce((s,t)=>s+(t.amount||0),0);
  document.getElementById("totalAmt").textContent = `₹ ${Math.abs(total).toFixed(2)}`;
  document.getElementById("txCount").textContent  = `${state.transactions.length} transactions`;

  // By card
  const byCard = {};
  state.transactions.forEach(t=>{
    const k = t.card || "Unknown";
    byCard[k] = byCard[k] || {count:0,sum:0};
    byCard[k].count++; byCard[k].sum += t.amount;
  });
  document.getElementById("byCard").innerHTML =
    Object.entries(byCard).map(([k,v])=>`<div>${escapeHtml(k)}: ${v.count} tx • ₹${Math.abs(v.sum).toFixed(2)}</div>`).join('') || "—";

  // Upcoming (very simple: lines with “due/statement” near currency)
  const upcoming = state.transactions
    .filter(t => /due|statement|minimum due|payment due/i.test(t.raw||t.snippet||''))
    .sort((a,b)=>a.date-b.date)
    .slice(0,6);

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
  tbody.innerHTML = state.transactions
    .sort((a,b)=>b.date-a.date)
    .map(t=>`<tr>
      <td>${new Date(t.date).toLocaleString()}</td>
      <td>${t.type === "credit" ? "-" : ""}₹${Math.abs(t.amount).toFixed(2)}</td>
      <td>${escapeHtml(t.merchant||'Unknown')}</td>
      <td>${escapeHtml(t.card||'Unknown')}</td>
      <td>${escapeHtml(t.source)}</td>
    </tr>`).join('');
}

function escapeHtml(s){
  return (s||'').toString()
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function exportCsv(){
  if (!state.transactions.length) { alert("No transactions"); return; }
  const rows = [["date","amount","type","merchant","card","source"]];
  state.transactions.forEach(t => rows.push([
    new Date(t.date).toISOString(),
    t.amount.toFixed(2),
    t.type,
    t.merchant||'',
    t.card||'',
    t.source
  ]));
  const csv = rows.map(r=>r.map(c=>`"${(c||'').toString().replace(/"/g,'""')}"`).join(",")).join("\n");
  const blob = new Blob([csv], {type:"text/csv"});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href=url; a.download="expenses.csv"; a.click();
  URL.revokeObjectURL(url);
}

function exportBackup(){
  const data = { exportedAt: new Date().toISOString(), transactions: state.transactions };
  const blob = new Blob([JSON.stringify(data, null, 2)], {type:"application/json"});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href=url; a.download="expenses-backup.json"; a.click();
  URL.revokeObjectURL(url);
}

// .ics reminders (7/3/2/0 days before)
window.createIcs = (whenMillis, amountPaise, merchantEsc) => {
  const deltas = [7,3,2,0];
  deltas.forEach(delta => {
    const dt = new Date(whenMillis - delta*24*60*60*1000);
    const dtStr = dt.toISOString().replace(/[-:]/g,'').split('.')[0] + 'Z';
    const uid = 'exp-'+whenMillis+'-'+delta+'@local';
    const summary = `Pay ${merchantEsc} — ₹${(amountPaise/100).toFixed(2)} (due ${new Date(whenMillis).toLocaleDateString()})`;
    const ics = [
      'BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//ExpenseAnalyzer//EN','BEGIN:VEVENT',
      `UID:${uid}`,
      `DTSTAMP:${new Date().toISOString().replace(/[-:]/g,'').split('.')[0]}Z`,
      `DTSTART:${dtStr}`,
      `SUMMARY:${summary}`,
      'DESCRIPTION:Auto-generated reminder',
      'END:VEVENT','END:VCALENDAR'
    ].join('\r\n');
    const blob = new Blob([ics], {type:'text/calendar'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href=url; a.download=`reminder-${uid}.ics`; a.click();
    URL.revokeObjectURL(url);
  });
  alert("Downloaded .ics reminders. Import them into your calendar.");
};
