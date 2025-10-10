// Expense Analyzer front-end (client-only).
// IMPORTANT: replace CLIENT_ID below with your Google OAuth Client ID if different.
// Repo origin that must be authorized in Google Cloud: https://vijaysslp.github.io

const CLIENT_ID = "263109576837-3iphn0jaf34739hdltpoaeccjlmf1p4j.apps.googleusercontent.com";
const SCOPES = "https://www.googleapis.com/auth/gmail.readonly";

let tokenClient = null;
let accessToken = null;

const connectBtn = document.getElementById("connectBtn");
const scanBtn = document.getElementById("scanBtn");
const exportCsvBtn = document.getElementById("exportCsvBtn");
const backupBtn = document.getElementById("backupBtn");
const logEl = document.getElementById("log");

const state = {
  transactions: [], // {amount, amountPaise, merchant, date, card, messageId, snippet, raw, source}
};

function log(s){ console.log(s); logEl.textContent = (new Date()).toISOString()+" — "+s+"\n"+logEl.textContent }

// Initialize Google Identity Services
window.addEventListener("load", () => {
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

  connectBtn.addEventListener("click", () => {
    tokenClient.requestAccessToken();
  });

  scanBtn.addEventListener("click", scanGmail);
  exportCsvBtn.addEventListener("click", exportCsv);
  backupBtn.addEventListener("click", exportBackup);
});

async function gmailFetch(path, params = {}) {
  if (!accessToken) throw new Error("No access token yet");
  const url = new URL(`https://gmail.googleapis.com/gmail/v1/${path}`);
  Object.entries(params).forEach(([k,v]) => v!==undefined && url.searchParams.set(k, v));
  log("Gmail fetch: " + url.toString());
  const r = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!r.ok) throw new Error(`Gmail API error ${r.status}: ${await r.text()}`);
  return r.json();
}

async function scanGmail(){
  state.transactions = [];
  renderDashboard();

  try {
    log("Starting scan… (up to 200 emails for responsiveness)");
    const q = "subject:(receipt OR transaction OR debited OR credited OR payment OR spent) OR from:(@icicibank @hdfcbank @axisbank @sbi @paytm @razorpay)";
    let nextPageToken = null;
    let processed = 0;
    const limit = 200;

    do {
      const list = await gmailFetch("users/me/messages", { q, maxResults: 100, pageToken: nextPageToken });
      nextPageToken = list.nextPageToken;
      const msgs = list.messages || [];
      for (const m of msgs) {
        if (processed >= limit) break;
        const full = await gmailFetch(`users/me/messages/${m.id}`, { format: "full" });
        await processMessage(full);
        processed++;
      }
    } while (nextPageToken && processed < limit);

    log(`Scan complete. Processed: ${processed}, Transactions: ${state.transactions.length}`);
    renderDashboard();
  } catch (e) {
    log("Scan failed: " + (e.message || e));
    console.error(e);
  }
}

function getMessageBody(message) {
  try {
    if (message.payload?.parts) {
      for (const p of message.payload.parts) {
        if (p.mimeType === "text/plain" && p.body?.data) return decodeBase64Url(p.body.data);
        if (p.mimeType === "text/html" && p.body?.data) return stripHtml(decodeBase64Url(p.body.data));
      }
    }
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

function parseTransactionFromText(text) {
  if (!text) return null;
  if (!/(INR|Rs\.?|₹|spent|debited|transaction|payment)/i.test(text)) return null;

  const amtMatch = text.match(/(?:INR|Rs\.?|₹)\s*([0-9,]+(?:\.[0-9]{1,2})?)/i)
                 || text.match(/([0-9,]+\.[0-9]{2})\s*(?:INR|Rs\.?|₹)?/i);
  const amount = amtMatch ? parseFloat(amtMatch[1].replace(/,/g,'')) : null;

  const merchantMatch = text.match(/(?:at|to|via|merchant[:\s])\s*([A-Z0-9 &._-]{2,60})/i)
                      || text.match(/(?:from|merchant)\s*[:\-]\s*([A-Z0-9 &._-]{2,60})/i);
  const merchant = merchantMatch ? merchantMatch[1].trim().replace(/\s+/g,' ') : null;

  let card = null;
  const cardMatch = text.match(/(card(?:\s*ending)?\s*[:\s]?(\d{2,4}[-\d]*\d{2,4})|VISA|MASTERCARD|MASTER|AMEX|AMERICAN EXPRESS|DISCOVER|RUPAY|RuPay)/i);
  if (cardMatch) card = (cardMatch[2] || cardMatch[1]).toString();

  const dateMatch = text.match(/(20\d{2}-\d{2}-\d{2})/) || text.match(/(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/);
  const when = dateMatch ? new Date(dateMatch[1]).getTime() : Date.now();

  if (!amount) return null;
  return { amount, merchant, when, card };
}

async function processMessage(msg) {
  const body = getMessageBody(msg);
  const headersStr = (msg.payload?.headers || []).map(h=>h.name+': '+h.value).join('\n');
  const parsed = parseTransactionFromText(body + "\n" + headersStr);
  if (parsed) {
    state.transactions.push({
      amount: parsed.amount,
      amountPaise: Math.round(parsed.amount * 100),
      merchant: parsed.merchant,
      date: parsed.when || Date.now(),
      card: parsed.card || detectCardFromHeaders(msg.payload?.headers),
      messageId: msg.id,
      snippet: msg.snippet,
      raw: body,
      source: "gmail"
    });
  }
}

function detectCardFromHeaders(headers) {
  if (!headers) return null;
  const h = headers.map(h=>h.name+':'+h.value).join('\n');
  const brand = h.match(/(Visa|Mastercard|MasterCard|Amex|American Express|Discover|Rupay|RuPay)/i);
  if (brand) return brand[1];
  const tail = h.match(/card(?:\s*ending)?\s*[:\s]?(\d{2,4}[-\d]*\d{2,4})/i);
  return tail ? tail[1] : null;
}

function renderDashboard() {
  const total = state.transactions.reduce((s,t)=>s+(t.amount||0),0);
  document.getElementById("totalAmt").textContent = `₹ ${total.toFixed(2)}`;
  document.getElementById("txCount").textContent = `${state.transactions.length} transactions`;

  const byCardAgg = {};
  state.transactions.forEach(t => {
    const k = t.card || "Unknown";
    byCardAgg[k] = byCardAgg[k] || {count:0,sum:0};
    byCardAgg[k].count++; byCardAgg[k].sum += t.amount;
  });
  const byCardEl = document.getElementById("byCard");
  byCardEl.innerHTML = Object.entries(byCardAgg).map(([k,v])=>`<div>${escapeHtml(k)}: ${v.count} tx • ₹${v.sum.toFixed(2)}</div>`).join('') || "—";

  const upcoming = state.transactions.filter(t => /due|statement|minimum due|payment due/i.test(t.raw||t.snippet||''));
  const upcomingEl = document.getElementById("upcoming");
  upcomingEl.innerHTML = upcoming.length ? upcoming.slice(0,6).map(u=>{
    const d = new Date(u.date);
    return `<div style="cursor:pointer" onclick="createIcs(${u.date}, ${u.amountPaise}, '${escapeHtml(u.merchant||'Unknown')}')">• ${escapeHtml(u.merchant||'Unknown')} — ₹${u.amount.toFixed(2)} — ${d.toLocaleDateString()}</div>`
  }).join('') : "No obvious upcoming bills found";

  const tbody = document.querySelector("#txTable tbody");
  tbody.innerHTML = state.transactions.map(t=>`<tr>
    <td>${new Date(t.date).toLocaleString()}</td>
    <td>₹${t.amount.toFixed(2)}</td>
    <td>${escapeHtml(t.merchant||'Unknown')}</td>
    <td>${escapeHtml(t.card||'Unknown')}</td>
    <td>${escapeHtml(t.source)}</td>
  </tr>`).join('');
}

function escapeHtml(s){ return (s||'').toString().replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

function exportCsv(){
  if (!state.transactions.length) { alert("No transactions"); return; }
  const rows = [["date","amount","merchant","card","source"]];
  state.transactions.forEach(t => rows.push([ new Date(t.date).toISOString(), t.amount.toFixed(2), t.merchant||'', t.card||'', t.source ]));
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

// Create ICS reminders for 7/3/2/0 days before a due date
window.createIcs = (whenMillis, amountPaise, merchantEsc) => {
  const deltas = [7,3,2,0];
  deltas.forEach(delta => {
    const dt = new Date(whenMillis - delta*24*60*60*1000);
    const dtStr = dt.toISOString().replace(/[-:]/g,'').split('.')[0] + 'Z';
    const uid = 'exp-'+whenMillis+'-'+delta+'@local';
    const summary = `Pay ${merchantEsc} — ₹${(amountPaise/100).toFixed(2)} (due ${new Date(whenMillis).toLocaleDateString()})`;
    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//ExpenseAnalyzer//EN',
      'BEGIN:VEVENT',
      `UID:${uid}`,
      `DTSTAMP:${new Date().toISOString().replace(/[-:]/g,'').split('.')[0]}Z`,
      `DTSTART:${dtStr}`,
      `SUMMARY:${summary}`,
      `DESCRIPTION:Auto-generated reminder`,
      'END:VEVENT',
      'END:VCALENDAR'
    ].join('\r\n');
    const blob = new Blob([ics], {type:'text/calendar'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href=url; a.download=`reminder-${uid}.ics`; a.click();
    URL.revokeObjectURL(url);
  });
  alert("Downloaded .ics reminders for that bill. Import them to your calendar.");
};
