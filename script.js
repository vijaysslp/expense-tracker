/* Expense Pro — v5 robust core
   - Finds buttons by id OR label text
   - Hardens Google GSI init
   - Connect + quick scan with logs
*/

const CLIENT_ID = "263109576837-3iphn0jaf34739hdltpoaeccjlmf1p4j.apps.googleusercontent.com";
const SCOPES   = "https://www.googleapis.com/auth/gmail.readonly";

// ===== helpers =====
const $ = (sel, root=document) => root.querySelector(sel);
const $$ = (sel, root=document) => [...root.querySelectorAll(sel)];
const byText = (rx) => $$("button,a").find(el => rx.test((el.textContent||"").trim()));
const logEl = document.getElementById("logs");
function log(s){ const line = `${new Date().toISOString()} — ${s}\n`; if (logEl) logEl.textContent = line + (logEl.textContent||""); console.log(s); }

// Try to find the buttons by ID or label text (case-insensitive)
function getButtons() {
  const connect = document.getElementById("btn-connect")
              || document.getElementById("connectGmail")
              || byText(/connect\s+gmail/i);
  const scan    = document.getElementById("btn-scan")
              || document.getElementById("scanGmail")
              || byText(/^scan$/i)
              || byText(/scan\s+gmail/i);
  return {connectBtn: connect, scanBtn: scan};
}

// ===== Google OAuth (robust init) =====
let tokenClient = null, accessToken = null;

function initGsiIfPossible() {
  if (tokenClient || !window.google || !google.accounts || !google.accounts.oauth2) return false;
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CLIENT_ID,
    scope: SCOPES,
    callback: (resp) => {
      if (resp.error) { log("Auth error: " + JSON.stringify(resp)); alert("Google auth error."); return; }
      accessToken = resp.access_token;
      log("✅ Connected to Gmail");
      const {scanBtn} = getButtons();
      if (scanBtn) scanBtn.disabled = false;
      scanGmail().catch(e => log("Auto-scan failed: " + (e.message||e)));
    }
  });
  return true;
}

window.addEventListener("load", () => {
  log("SCRIPT VERSION v5");
  // Retry for late-loading GSI
  let tries = 0;
  const t = setInterval(() => {
    tries++;
    if (initGsiIfPossible() || tries > 40) clearInterval(t);
  }, 250);

  // Bind buttons (in case DOM was late)
  bindButtons();
  setTimeout(bindButtons, 500);
  setTimeout(bindButtons, 1500);
});

function bindButtons() {
  const {connectBtn, scanBtn} = getButtons();
  if (connectBtn && !connectBtn._wired) {
    connectBtn._wired = true;
    connectBtn.addEventListener("click", () => {
      if (!tokenClient && !initGsiIfPossible()) {
        alert("Google script not ready. Hard refresh (Ctrl/Cmd+Shift+R) and try again.");
        log("Google GSI not ready on click.");
        return;
      }
      try { tokenClient.requestAccessToken(); }
      catch(e){ log("requestAccessToken failed: " + e.message); alert("Pop-up blocked? Allow pop-ups and try again."); }
    });
    log("Connect button wired.");
  }
  if (scanBtn && !scanBtn._wired) {
    scanBtn._wired = true;
    scanBtn.addEventListener("click", () => {
      if (!accessToken) { alert("Please connect Gmail first."); return; }
      scanGmail().catch(e => log("Scan failed: " + (e.message||e)));
    });
    log("Scan button wired.");
  }
}

// ===== Gmail helpers =====
async function gmailFetch(url, opts={}) {
  if (!accessToken) throw new Error("No access token");
  const res = await fetch(url, {
    ...opts,
    headers: { ...(opts.headers||{}), Authorization: `Bearer ${accessToken}` }
  });
  if (!res.ok) throw new Error(`Gmail API ${res.status}: ${await res.text()}`);
  return res.json();
}

const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
const DEFAULT_QUERY =
  "subject:(receipt OR transaction OR debited OR credited OR payment OR spent) " +
  "OR from:(@icicibank @hdfcbank @axisbank @sbi @paytm @phonepe @razorpay @amazon @flipkart)";

async function scanGmail() {
  log("Starting scan… (quick sample: 100 messages)");
  const listUrl = `${GMAIL_BASE}/messages?q=${encodeURIComponent(DEFAULT_QUERY)}&maxResults=100`;
  log("Gmail fetch: " + listUrl);
  const list = await gmailFetch(listUrl);
  const ids = (list.messages || []).map(m => m.id);
  log(`Found ${ids.length} candidates.`);
  let shown = 0;
  for (const id of ids.slice(0, 10)) {
    const msg = await gmailFetch(`${GMAIL_BASE}/messages/${id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`);
    const headers = Object.fromEntries((msg.payload.headers||[]).map(h => [h.name, h.value]));
    log(`• ${headers.Date || "?"} — ${headers.From || "?"} — ${headers.Subject || "?"}`);
    shown++;
  }
  log(`Scan complete. Displayed ${shown} examples in logs.`);
}
