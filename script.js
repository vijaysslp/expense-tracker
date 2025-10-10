/* Expense Analyzer – Minimal Working Core (v4 core)
   - Google OAuth (token client)
   - Connect Gmail + quick scan
   - Logs to #logs element
   Replace your entire script.js with this content.
*/

const CLIENT_ID = "263109576837-3iphn0jaf34739hdltpoaeccjlmf1p4j.apps.googleusercontent.com";
const SCOPES   = "https://www.googleapis.com/auth/gmail.readonly";

// ---- DOM refs (match IDs in your index.html) ----
const connectBtn = document.getElementById("btn-connect");
const scanBtn    = document.getElementById("btn-scan");
const logEl      = document.getElementById("logs");

// Some builds use different ids; try fallbacks:
const _try = id => document.getElementById(id);
if (!connectBtn && _try("connectGmail")) window.btnConnect = _try("connectGmail");
if (!scanBtn && _try("scanGmail")) window.btnScan = _try("scanGmail");

// small helper
function log(msg) {
  const line = `${new Date().toISOString()} — ${msg}\n`;
  if (logEl) logEl.textContent = line + (logEl.textContent || "");
  console.log(msg);
}

// ---- Google OAuth 2 token client (robust init) ----
let tokenClient = null;
let accessToken = null;

function initGsiIfPossible() {
  if (tokenClient || !window.google || !google.accounts || !google.accounts.oauth2) return false;
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CLIENT_ID,
    scope: SCOPES,
    callback: (resp) => {
      if (resp.error) {
        log("Auth error: " + JSON.stringify(resp));
        alert("Google auth error. See console/logs.");
        return;
      }
      accessToken = resp.access_token;
      log("✅ Connected to Gmail");
      if (scanBtn) scanBtn.disabled = false;
      // auto-scan once connected
      scanGmail().catch(e => log("Auto-scan failed: " + (e.message || e)));
    }
  });
  return true;
}

window.addEventListener("load", () => {
  log("SCRIPT VERSION v4-core");
  // The <script src="https://accounts.google.com/gsi/client" async defer> tag must be in index.html
  let tries = 0;
  const t = setInterval(() => {
    tries++;
    if (initGsiIfPossible() || tries > 30) clearInterval(t);
  }, 300);
});

// Click “Connect Gmail”
(connectBtn || window.btnConnect).addEventListener("click", () => {
  if (!tokenClient && !initGsiIfPossible()) {
    alert("Google Sign-In script not loaded. Hard refresh (Ctrl/Cmd+Shift+R) and try again.");
    log("Google script not ready.");
    return;
  }
  try {
    tokenClient.requestAccessToken();
  } catch (e) {
    log("requestAccessToken failed: " + e.message);
    alert("Could not open Google sign-in. Check pop-up blockers.");
  }
});

// ---- Gmail helpers ----
async function gmailFetch(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: {
      ...(opts.headers || {}),
      Authorization: `Bearer ${accessToken}`
    }
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Gmail API ${res.status}: ${text}`);
  }
  return res.json();
}

const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

// Broad query to catch bank/receipts
const DEFAULT_QUERY =
  "subject:(receipt OR transaction OR debited OR credited OR payment OR spent) " +
  "OR from:(@icicibank @hdfcbank @axisbank @sbi @paytm @phonepe @razorpay @amazon @flipkart)";

// Click “Scan Gmail”
(scanBtn || window.btnScan).addEventListener("click", () => {
  if (!accessToken) {
    alert("Please connect Gmail first.");
    return;
  }
  scanGmail().catch(e => log("Scan failed: " + (e.message || e)));
});

async function scanGmail() {
  if (!accessToken) throw new Error("No access token");
  log("Starting scan… (up to 100 emails for quick test)");
  const listUrl = `${GMAIL_BASE}/messages?q=${encodeURIComponent(DEFAULT_QUERY)}&maxResults=100`;
  log("Gmail fetch: " + listUrl);

  const list = await gmailFetch(listUrl);
  const ids = (list.messages || []).map(m => m.id);
  log(`Found ${ids.length} candidates.`);

  // Fetch a few details to prove it works
  let count = 0;
  for (const id of ids.slice(0, 10)) {
    const msg = await gmailFetch(`${GMAIL_BASE}/messages/${id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`);
    const headers = Object.fromEntries((msg.payload.headers || []).map(h => [h.name, h.value]));
    log(`• ${headers.Date || "?"} — ${headers.From || "?"} — ${headers.Subject || "?"}`);
    count++;
  }
  log(`Scan complete. Displayed ${count} messages in logs (showing 10 for brevity).`);
}
