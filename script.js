/* ExpensePro v7+ — Gmail + CSV/XLSX + Charts + Dedupe + Private Mappings
   - Import JSON mappings via the same "Import CSV/XLSX" button (filename must end with .json)
   - Mappings saved locally; optional AES-GCM encryption using passphrase in Settings
   - Smarter merchant/category detection incl. Fuel, Electricity, Broadband, Mobile, etc.
*/

// ---------- CONFIG ----------
const CLIENT_ID = window.GOOGLE_CLIENT_ID;
const SCOPES    = "https://www.googleapis.com/auth/gmail.readonly";
const GBASE     = "https://gmail.googleapis.com/gmail/v1";

// issuers/gateways to widen Gmail search
const BANKS = ["icicibank","hdfcbank","axisbank","sbi","kotak","idfcfirstbank",
  "sbicard","americanexpress","amex","onecard","citi","billdesk","razorpay",
  "paytm","phonepe","amazon","flipkart"];

// add this new list
const CARD_SENDERS = [
  "sbicard.com", "alerts.sbicard.com",
  "hdfcbank.com", "hdfcbankcards.com",
  "icicibank.com", "axisbank.com",
  "kotak.com", "kotakcards.com",
  "americanexpress.com", "amex.co.in",
  "rblbank.com", "indusind.com", "yesbank.in"
];


// ---------- DOM HELPERS ----------
const $  = (s, r=document) => r.querySelector(s);
const $$ = (s, r=document) => [...r.querySelectorAll(s)];
const logEl = $("#logs"), statusEl = $("#status");
function log(s){
  const t = new Date().toISOString()+" — "+s+"\n";
  if (logEl) logEl.textContent = t + (logEl.textContent||"");
  if (statusEl) statusEl.textContent = s;
  console.log(s);
}

// ---------- VIEWS ----------
const views=["dashboard","transactions","insights","logs","settings"];
$$(".nav").forEach(b=>b.addEventListener("click",()=>{
  $$(".nav").forEach(x=>x.classList.remove("active"));
  b.classList.add("active");
  views.forEach(v=>$("#view-"+v)?.classList.remove("show"));
  $("#view-"+b.dataset.view)?.classList.add("show");
}));

// ---------- STATE ----------
const state = { tx: [] };

// ---------- FILTERS ----------
const fromEl=$("#fromDate"), toEl=$("#toDate"),
      typeEl=$("#typeFilter"), cardEl=$("#cardFilter"),
      catEl=$("#catFilter"), qEl=$("#search");

$("#apply").addEventListener("click",renderAll);
$("#clear").addEventListener("click",()=>{
  [fromEl,toEl].forEach(i=>i.value=""); typeEl.value="all";
  cardEl.value=""; catEl.value="all"; qEl.value=""; renderAll();
});
qEl.addEventListener("input",renderAll);

// ---------- EXPORT CSV ----------
$("#btn-export").addEventListener("click",()=>{
  const tx=fTx(); if(!tx.length) return alert("No transactions");
  const rows=[["date","amount","type","merchant","card","category","source"]];
  tx.forEach(t=>rows.push([
    new Date(t.date).toISOString(),
    t.amount.toFixed(2), t.type, t.merchant||"", t.card||"",
    t.category||"", t.source
  ]));
  const csv=rows.map(r=>r.map(c=>`"${String(c).replace(/"/g,'""')}"`).join(",")).join("\n");
  const url=URL.createObjectURL(new Blob([csv],{type:"text/csv"}));
  const a=document.createElement("a"); a.href=url; a.download="expenses.csv"; a.click();
  URL.revokeObjectURL(url);
});

// ---------- IMPORT CSV/XLSX or JSON (mappings) ----------
$("#fileInput").addEventListener("change", async e=>{
  const f=e.target.files?.[0]; if(!f) return;
  try{
    const name=f.name.toLowerCase();
    if (name.endsWith(".json")) {
      const text = await f.text();
      await importMappingsJSON(text);
    } else if (name.endsWith(".csv")) {
      mergeCsv(await f.text());
      log(`Imported ${f.name}`);
      renderAll();
    } else {
      const wb=XLSX.read(await f.arrayBuffer(),{type:"array"});
      const sh=wb.Sheets[wb.SheetNames[0]];
      const rows=XLSX.utils.sheet_to_json(sh,{raw:true});
      rows.forEach(ingestRow);
      log(`Imported ${f.name}`);
      renderAll();
    }
  }catch(err){ log("Import failed: "+(err.message||err)); }
  finally{ e.target.value=""; }
});

function ingestRow(r){
  const d=new Date(r.date||r.Date||r.DATE).getTime();
  let amt=Number(r.amount??r.Amount??r.AMOUNT);
  let type=(r.type??r.Type??r.TYPE??(amt<0?"credit":"debit"))
    .toString().toLowerCase().includes("credit")?"credit":"debit";
  if(type==="credit") amt=-Math.abs(amt);
  if(!Number.isFinite(amt)) return;
  const tx={
    id:crypto.randomUUID(),
    date:Number.isFinite(d)?d:Date.now(),
    amount:Math.abs(amt), type,
    merchant:r.merchant||r.Merchant||r.MERCHANT||"Imported",
    card:r.card||r.Card||r.CARD||null,
    category:r.category||r.Category||r.CATEGORY||"Other",
    tags:[], note:"", source:"import"
  };
  applyUserMappings(tx); // normalize via mappings
  state.tx.push(tx);
}

function mergeCsv(text){
  const L=text.split(/\r?\n/).filter(Boolean); if(!L.length) return;
  const H=L.shift().split(",").map(x=>x.trim().toLowerCase());
  const idx=n=>H.indexOf(n);
  const iD=idx("date"), iA=idx("amount"), iT=idx("type"),
        iM=idx("merchant"), iC=idx("card"), iCat=idx("category");
  L.forEach(line=>{
    const c=splitCsv(line); const d=new Date(c[iD]).getTime();
    let amt=Number(c[iA]);
    const type=(c[iT]||"debit").toLowerCase().includes("credit")?"credit":"debit";
    if(type==="credit") amt=-Math.abs(amt);
    if(!Number.isFinite(amt)) return;
    const tx={
      id:crypto.randomUUID(),
      date:Number.isFinite(d)?d:Date.now(),
      amount:Math.abs(amt), type,
      merchant:c[iM]||"Imported", card:c[iC]||null,
      category:c[iCat]||"Other", tags:[], note:"", source:"import"
    };
    applyUserMappings(tx);
    state.tx.push(tx);
  });
}
function splitCsv(line){
  const out=[]; let cur="",q=false;
  for(let i=0;i<line.length;i++){
    const ch=line[i];
    if(ch=='"'){ if(q&&line[i+1]=='"'){cur+='"';i++;} else q=!q; }
    else if(ch==','&&!q){ out.push(cur); cur=""; }
    else cur+=ch;
  }
  out.push(cur);
  return out.map(s=>s.trim().replace(/^"|"$|\r|\n/g,""));
}

// ---------- PRIVATE MAPPINGS (LOCAL ONLY) ----------
// Schema:
// {
//   "cards":        [{ "match": "3183", "label": "SBI Credit Card • 3183" }, ...],
//   "accounts":     [{ "match": "A/c\\s*1234|XXXX1234", "label":"HDFC Savings • 1234" }],
//   "merchantRules":[{ "pattern":"HPCL|IOCL|BPCL|FILLING STATION", "merchant":"Fuel Pump", "category":"Fuel" }, ...],
//   "categoryRules":[{ "pattern":"electric|b(es?)c|tata power|adani", "category":"Utilities" }, ...]
// }

const LS_KEY_MAP = "userMappings_v1";
let userMap = loadMappingsFromLocal();

/* encryption helpers (AES-GCM) when passphrase is provided in Settings */
async function aesKeyFromPassphrase(pass){
  const enc=new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey("raw", enc.encode(pass), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name:"PBKDF2", salt:enc.encode("expensepro.salt"), iterations:100000, hash:"SHA-256" },
    keyMaterial, { name:"AES-GCM", length:256 }, false, ["encrypt","decrypt"]
  );
}
async function encSave(pass, obj){
  const enc=new TextEncoder(); const iv=crypto.getRandomValues(new Uint8Array(12));
  const key=await aesKeyFromPassphrase(pass);
  const data=enc.encode(JSON.stringify(obj));
  const ct=await crypto.subtle.encrypt({name:"AES-GCM", iv}, key, data);
  localStorage.setItem(LS_KEY_MAP, JSON.stringify({iv:Array.from(iv), ct:Array.from(new Uint8Array(ct)), enc:true}));
}
async function decLoad(pass){
  const raw=localStorage.getItem(LS_KEY_MAP); if(!raw) return null;
  const parsed=JSON.parse(raw); if(!parsed.enc) return parsed;
  const iv=new Uint8Array(parsed.iv); const ct=new Uint8Array(parsed.ct);
  const key=await aesKeyFromPassphrase(pass);
  const pt=await crypto.subtle.decrypt({name:"AES-GCM", iv}, key, ct);
  return JSON.parse(new TextDecoder().decode(pt));
}

function loadMappingsFromLocal(){
  try{
    const raw=localStorage.getItem(LS_KEY_MAP);
    if(!raw) return {cards:[],accounts:[],merchantRules:[],categoryRules:[]};
    const obj=JSON.parse(raw);
    if(obj.enc) { // encrypted — will be loaded lazily on import if passphrase present
      return {cards:[],accounts:[],merchantRules:[],categoryRules:[], _encrypted:true};
    }
    return Object.assign({cards:[],accounts:[],merchantRules:[],categoryRules:[]}, obj);
  }catch{ return {cards:[],accounts:[],merchantRules:[],categoryRules:[]}; }
}

async function importMappingsJSON(text){
  let obj=JSON.parse(text);
  // normalize arrays
  obj.cards = obj.cards||[];
  obj.accounts = obj.accounts||[];
  obj.merchantRules = obj.merchantRules||[];
  obj.categoryRules = obj.categoryRules||[];

  // merge (replace for simplicity)
  userMap = obj;

  // save (optionally encrypt if passphrase provided)
  const pass = $("#passphrase")?.value?.trim();
  if (pass) await encSave(pass, obj);
  else localStorage.setItem(LS_KEY_MAP, JSON.stringify(obj));

  log(`Imported mappings: ${obj.cards.length} card rules, ${obj.accounts.length} account rules, ${obj.merchantRules.length} merchant rules, ${obj.categoryRules.length} category rules`);
}

// apply mappings to a transaction object (in-place)
function applyUserMappings(tx){
  const text = (tx.raw || `${tx.merchant||""} ${tx.card||""}`).toUpperCase();

  // card rules
  for (const r of (userMap.cards||[])) {
    const re = new RegExp(r.match, "i");
    if (re.test(text) || re.test(String(tx.card||""))) { tx.card = r.label; break; }
  }

  // account rules (for bank account debits, A/c XXXX etc.)
  for (const r of (userMap.accounts||[])) {
    const re = new RegExp(r.match, "i");
    if (re.test(text)) { tx.card = r.label; break; }
  }

  // merchant overrides
  for (const r of (userMap.merchantRules||[])) {
    const re = new RegExp(r.pattern, "i");
    if (re.test(text) || re.test(tx.merchant||"")) {
      if (r.merchant) tx.merchant = r.merchant;
      if (r.category) tx.category = r.category;
      break;
    }
  }

  // category-only rules
  for (const r of (userMap.categoryRules||[])) {
    const re = new RegExp(r.pattern, "i");
    if (re.test(text)) { tx.category = r.category; break; }
  }
}

// ---------- AUTH (GSI) ----------
let tokenClient=null, accessToken=null;
function initGsiIfPossible(){
  if(tokenClient||!window.google||!google.accounts?.oauth2) return false;
  if(!CLIENT_ID){ log("Missing CLIENT_ID — set window.GOOGLE_CLIENT_ID in index.html"); return false; }
  tokenClient=google.accounts.oauth2.initTokenClient({
    client_id:CLIENT_ID, scope:SCOPES,
    callback:(resp)=>{
      if(resp.error){ log("Auth error: "+JSON.stringify(resp)); return; }
      accessToken=resp.access_token; log("✅ Connected to Gmail");
      $("#btn-scan").disabled=false;
      scanGmail().catch(e=>log("Auto-scan failed: "+(e.message||e)));
    }
  });
  return true;
}
(function attachConnect(){
  const btn=document.getElementById("btnConnect")||document.getElementById("btn-connect");
  if(!btn) return;
  btn.addEventListener("click", async ()=>{
    // if mappings were encrypted, try to decrypt now using passphrase
    if (userMap._encrypted) {
      const pass = $("#passphrase")?.value?.trim();
      if (!pass) log("Mappings are encrypted; enter passphrase in Settings to unlock.");
      else {
        try { userMap = await decLoad(pass) || userMap; log("🔐 Mappings unlocked"); }
        catch { log("Failed to decrypt mappings with this passphrase"); }
      }
    }
    if(!tokenClient && !initGsiIfPossible()){
      alert("Google script not ready. Hard refresh (Ctrl/Cmd+Shift+R) and allow pop-ups.");
      return;
    }
    try{ tokenClient.requestAccessToken(); }
    catch(e){ log("requestAccessToken failed: "+e.message); alert("Allow pop-ups for this site."); }
  });
})();

// ---------- GMAIL SCAN + DEDUPE ----------
// was: const STOP_PATTERNS = [ ... "inform you that" ... ]
const STOP_PATTERNS = [
  /otp/i,
  /one\s*time\s*password/i,
  /declined|failed|failure|unsuccessful|not\s*approved/i,
  /reversed|reversal|charge\s*reversal|chargeback/i,
  /generated mail with reference/i,
  /test\s*transaction/i,
  /autopay setup|mandate\s*(registered|cancelled)/i,
  /transaction\s+declined/i,
  /\bnot\s+processed\b/i
];

const DEDUPE_WINDOW_MS=10*60*1000;
const processedMsgIds=new Set();
const fpSeen=new Set(JSON.parse(localStorage.getItem("fpSeen")||"[]"));
function saveFp(fp){ fpSeen.add(fp); const arr=[...fpSeen]; if(arr.length>5000) arr.splice(0,arr.length-5000); localStorage.setItem("fpSeen",JSON.stringify(arr)); }
function makeFingerprint(tx){
  const bucket=Math.floor(tx.date/DEDUPE_WINDOW_MS);
  const amt=Math.round(Number(tx.amount));
  const card=(tx.card||"unk").toString().slice(-6);
  const merch=(tx.merchant||"unk").toLowerCase().replace(/\s+/g," ").slice(0,24);
  return `${bucket}|${amt}|${card}|${merch}`;
}

async function gfetch(p,params={}){
  if(!accessToken) throw new Error("No access token");
  const u=new URL(`${GBASE}/${p}`);
  Object.entries(params).forEach(([k,v])=>{ if(v!==undefined&&v!==null&&v!=='') u.searchParams.set(k,v); });
  log("Gmail fetch: "+u);
  const r=await fetch(u,{headers:{Authorization:`Bearer ${accessToken}`}});
  if(!r.ok) throw new Error(`Gmail API ${r.status}: ${await r.text()}`);
  return r.json();
}

$("#btn-scan").addEventListener("click",()=>scanGmail().catch(e=>log("Scan failed: "+(e.message||e))));
async function scanGmail(){
  state.tx.length = 0; renderAll();

  const exclude = '-subject:(otp OR "one time password" OR declined OR failure OR failed OR reversal OR unsuccessful)';
  const base = 'subject:(transaction OR spent OR debited OR credited OR payment OR purchase OR txn)';

  // 1) generic query (banks + gateways)
  const q1 = `newer_than:365d ${exclude} (${base} OR from:(${BANKS.map(x=>'@'+x).join(' ')}))`;
  await scanQuery(q1, 200);

  // 2) issuer-specific queries: some issuers only show with strict from:
  for (const d of CARD_SENDERS) {
    const q = `newer_than:365d ${exclude} (from:${d} ${base})`;
    await scanQuery(q, 200);              // dedupe prevents repeats
  }

  if (state.tx.length === 0) log("No results. Try CSV import or check Gmail search access.");
  renderAll();
}


function hVal(h,n){ return (h||[]).find(x=>x.name?.toLowerCase()===n.toLowerCase())?.value||""; }
function getBody(m){
  try{
    if(m.payload?.parts){
      for(const p of m.payload.parts){
        if(p.mimeType==="text/plain"&&p.body?.data) return atob(p.body.data.replace(/-/g,'+').replace(/_/g,'/'));
        if(p.mimeType==="text/html" && p.body?.data){
          const html = atob(p.body.data.replace(/-/g,'+').replace(/_/g,'/'));
          return (new DOMParser()).parseFromString(html,'text/html').body.textContent||"";
        }
      }
    }
    if(m.payload?.body?.data) return atob(m.payload.body.data.replace(/-/g,'+').replace(/_/g,'/'));
  }catch{}
  return m.snippet||"";
}

function amt(text){
  const m=text.match(/(?:INR|Rs\.?|₹)\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/i);
  return m ? parseFloat(m[1].replace(/,/g,'')) : null;
}
function detectType(text){
  if(/(credited|refund(ed)?|cashback|reversal)/i.test(text)) return "credit";
  if(/(debited|spent|purchase|payment\s+made|txn\s*[:# ]?\s*approved)/i.test(text)) return "debit";
  return "debit";
}
function detectMerchant(text){
  let m = text.match(/(?:towards|at|merchant\s*[:\-])\s*([A-Z0-9& ._\-]{2,50})\b/i);
  if(m) return m[1].trim();
  const rx=/(amazon|flipkart|myntra|swiggy|zomato|ola|uber|irctc|indigo|jio\s*mart|paytm|phonepe)/i;
  const g=text.match(rx); return g?g[1].toUpperCase():null;
}
function detectCard(text){
  const acct=text.match(/(?:A\/c|A\/C|Ac|Account)\s*(?:No\.?|number|:)?\s*[Xx*]*\s*([0-9]{3,6})/i);
  if(acct) return `Account • ${acct[1]}`;
  const t=text.match(/(?:xx|ending|card)\s*[:#-]?\s*([0-9]{3,6}|[0-9]{4})/i);
  if(t) return t[1];
  const b=(text.match(/(Visa|Mastercard|Amex|RuPay|Rupay|Discover)/i)||[])[1];
  return b||null;
}
function categorize(t){
  const x=((t.merchant||"")+" "+(t.raw||"")).toLowerCase();

  // fuel / petrol
  if(/(fuel|petrol|diesel|filling\s*station|hpcl|iocl|bpcl|shell)/.test(x)) return "Fuel";

  // utilities
  if(/(electric|bijli|tata\s*power|adani|b(es?)c|cesc|mseb|kseb|pspcl|apdcl)/.test(x)) return "Utilities"; // electricity
  if(/(broadband|fiber|fibrenet|airtel\s*xstream|jiofiber|hathway|act\s*fiber)/.test(x)) return "Utilities"; // broadband
  if(/(mobile\s*(bill|recharge)|postpaid|prepaid|vi|vodafone|airtel|jio)/.test(x)) return "Utilities"; // mobile
  if(/(gas\s*(bill|cylinder|png)|mahanagar\s*gas|gail|igL)/.test(x)) return "Utilities"; // gas
  if(/(water\s*(bill)?|bwssb|djB|phed|hmws&sb)/.test(x)) return "Utilities"; // water
  if(/(fastag)/.test(x)) return "Tolls";

  if(/(uber|ola|irctc|air|indigo|train|flight|bus|rapido)/.test(x)) return "Travel";
  if(/(amazon|flipkart|myntra|ajio|store|mall|shop|fashion|jiomart)/.test(x)) return "Shopping";
  if(/(netflix|prime|spotify|hotstar|sony\s*liv|subscription|invoice)/.test(x)) return "Subscriptions";
  if(/(upi|transfer|neft|imps|paytm|phonepe|gpay|google\s*pay)/.test(x)) return "Transfers";
  return "Other";
}

function parseSbiCard(text) {
  // Example: “Transaction Alert from SBI Card - Rs. 55353.00 spent on your SBI Credit Card ending 3183 at PAYUFLIPKART …”
  const m = text.match(/(?:SBI\s*Card).*?(?:INR|Rs\.?|₹)\s*([0-9][0-9,]*(?:\.\d{1,2})?).*?(?:spent|debited).*?Credit\s*Card.*?(?:ending|xx|xxxx)\s*([0-9]{3,6}|[0-9]{4}).*?(?:at|towards)\s+([A-Z0-9& ._\-]{2,60})/i);
  if (!m) return null;
  return {
    amount: parseFloat(m[1].replace(/,/g,'')),
    card: m[2],
    merchant: m[3].trim(),
    type: /credited|refund/i.test(text) ? "credit" : "debit"
  };
}

function parseHdfcCard(text) {
  // Example: “Rs.2240.00 is debited from your HDFC Bank Credit Card ending 8675 towards SHYAM FILLING STATION …”
  const m = text.match(/(?:INR|Rs\.?|₹)\s*([0-9][0-9,]*(?:\.\d{1,2})?).*?(?:is\s+)?(?:debited|spent|credited).*?HDFC.*?Credit\s*Card.*?(?:ending|xx|xxxx)\s*([0-9]{3,6}|[0-9]{4}).*?(?:towards|at)\s+([A-Z0-9& ._\-]{2,60})/i);
  if (!m) return null;
  return {
    amount: parseFloat(m[1].replace(/,/g,'')),
    card: m[2],
    merchant: m[3].trim(),
    type: /credited|refund/i.test(text) ? "credit" : "debit"
  };
}

function parseAxisCard(text) {
  const m = text.match(/(?:INR|Rs\.?|₹)\s*([0-9][0-9,]*(?:\.\d{1,2})?).*?(?:spent|debited|credited).*?Axis.*?Credit\s*Card.*?(?:ending|xx|xxxx)\s*([0-9]{3,6}|[0-9]{4}).*?(?:at|towards)\s+([A-Z0-9& ._\-]{2,60})/i);
  if (!m) return null;
  return {
    amount: parseFloat(m[1].replace(/,/g,'')),
    card: m[2],
    merchant: m[3].trim(),
    type: /credited|refund/i.test(text) ? "credit" : "debit"
  };
}

function parseIciciCard(text) {
  const m = text.match(/(?:INR|Rs\.?|₹)\s*([0-9][0-9,]*(?:\.\d{1,2})?).*?(?:spent|debited|credited).*?ICICI.*?Credit\s*Card.*?(?:ending|xx|xxxx)\s*([0-9]{3,6}|[0-9]{4}).*?(?:at|towards)\s+([A-Z0-9& ._\-]{2,60})/i);
  if (!m) return null;
  return {
    amount: parseFloat(m[1].replace(/,/g,'')),
    card: m[2],
    merchant: m[3].trim(),
    type: /credited|refund/i.test(text) ? "credit" : "debit"
  };
}

function parseCardAlert(text) {
  // try issuer-specific templates first
  return (
    parseSbiCard(text)   ||
    parseHdfcCard(text)  ||
    parseAxisCard(text)  ||
    parseIciciCard(text) ||
    null
  );
}

function processMsg(msg){
  if(processedMsgIds.has(msg.id)) return false;
  processedMsgIds.add(msg.id);

  const h = msg.payload?.headers || [];
  const from = hVal(h,"From");
  const subject = hVal(h,"Subject") || "";
  const date = new Date(hVal(h,"Date")).getTime() || Date.now();
  const body = getBody(msg);
  const text = (subject + "\n" + body).replace(/\s+/g,' ');

  // 1) skip obvious non-transactions
  if (STOP_PATTERNS.some(rx => rx.test(text))) return false;

  // 2) try strong issuer-specific parsers first
  const cardHit = parseCardAlert(text);
  if (cardHit && cardHit.amount > 0) {
    const tx = {
      id: msg.id,
      date,
      amount: cardHit.amount,
      type: cardHit.type,
      merchant: cardHit.merchant || (from.replace(/<.*?>/g,'') || "Unknown"),
      card: cardHit.card || detectCard(text),
      category: categorize({ merchant: cardHit.merchant, raw: text }),
      source: "gmail",
      raw: text
    };
    applyUserMappings(tx);
    const fp = makeFingerprint(tx);
    if (fpSeen.has(fp)) return false;
    saveFp(fp);
    state.tx.push(tx);
    return true;
  }

  // 3) fallback generic detection (old behavior)
  if (!/(receipt|transaction|debited|credited|payment|spent|paid|txn)/i.test(text)) return false;
  const a = amt(text); if (!a || a <= 0) return false;

  const type = detectType(text);
  let merchant = (detectMerchant(text) || from.replace(/<.*?>/g,'') || "Unknown").trim();
  let card = detectCard(text);
  const category = categorize({ merchant, raw: text });

  const tx = { id: msg.id, date, amount:a, type, merchant, card, category, source:"gmail", raw:text };
  applyUserMappings(tx);

  const fp = makeFingerprint(tx);
  if (fpSeen.has(fp)) return false;
  saveFp(fp);

  state.tx.push(tx);
  return true;
}


// ---------- RENDER & CHARTS ----------
const kpiTotal=$("#kpi-total"), kpiCount=$("#kpi-count"),
      kpiCard=$("#kpi-card"), kpiMerch=$("#kpi-merchants"),
      kpiBills=$("#kpi-bills");
const txTable=$("#txTable"), txTable2=$("#txTable2");

function fTx(){
  const from=fromEl.value?new Date(fromEl.value).getTime():-Infinity;
  const to=toEl.value?new Date(toEl.value).getTime()+86400000-1:Infinity;
  const typ=typeEl.value; const card=(cardEl.value||"").toLowerCase();
  const cat=catEl.value; const q=(qEl.value||"").toLowerCase();
  return state.tx.filter(x=>{
    if(x.date<from||x.date>to) return false;
    if(typ!=="all"&&x.type!==typ) return false;
    if(cat!=="all"&&(x.category||"Other")!==cat) return false;
    if(card && !String(x.card||"").toLowerCase().includes(card)) return false;
    if(q && !((x.merchant||"").toLowerCase().includes(q)||
              (x.card||"").toLowerCase().includes(q)||
              (x.category||"").toLowerCase().includes(q))) return false;
    return true;
  });
}

function renderAll(){
  const tx=fTx().sort((a,b)=>b.date-a.date);
  const total=tx.reduce((s,t)=>s+(t.type==='debit'?t.amount:0),0);
  kpiTotal.textContent='₹ '+total.toFixed(2); kpiCount.textContent=tx.length+' tx';

  const byCard={}; tx.forEach(t=>{const k=t.card||'Unknown'; byCard[k]=(byCard[k]||0)+(t.type==='debit'?t.amount:0);});
  kpiCard.innerHTML=Object.keys(byCard).length?Object.entries(byCard).map(([k,v])=>`<div>${k}: ₹${v.toFixed(2)}`).join(''):'—';

  const byMerch={}; tx.forEach(t=>{const k=t.merchant||'Unknown'; byMerch[k]=(byMerch[k]||0)+(t.type==='debit'?t.amount:0);});
  const tops=Object.entries(byMerch).sort((a,b)=>b[1]-a[1]).slice(0,6);
  kpiMerch.innerHTML=tops.length?tops.map(([m,v])=>`<div>${m} — ₹${v.toFixed(2)}`).join(''):'—';

  const bills=tx.filter(t=>/due|statement|minimum due|payment due|last date|bill due/i.test(t.raw||"")).sort((a,b)=>a.date-b.date).slice(0,6);
  kpiBills.innerHTML=bills.length?bills.map(u=>`<div>• ${u.merchant||'Unknown'} — ₹${u.amount.toFixed(2)} — ${new Date(u.date).toLocaleDateString()}`).join(''):'—';

  txTable.innerHTML=tx.slice(0,200).map(t=>{
    const sign=t.type==='credit'?'-':'';
    return `<tr><td>${new Date(t.date).toLocaleString()}</td><td>${sign}₹${Math.abs(t.amount).toFixed(2)}</td><td>${t.type}</td><td>${t.merchant||'Unknown'}</td><td>${t.card||'Unknown'}</td><td>${t.category||'Other'}</td><td>${t.source}</td></tr>`;
  }).join('');
  txTable2.innerHTML=tx.slice(0,400).map(t=>{
    const sign=t.type==='credit'?'-':'';
    return `<tr><td>${new Date(t.date).toLocaleString()}</td><td>${sign}₹${Math.abs(t.amount).toFixed(2)}</td><td>${t.type}</td><td>${t.merchant||'Unknown'}</td><td>${t.card||'Unknown'}</td><td>${t.category||'Other'}</td><td contenteditable>${(t.tags||[]).join(' ')}</td><td contenteditable>${t.note||''}</td></tr>`;
  }).join('');

  drawCharts(tx);
}

function destroyChart(id){ try{ window[id]?.destroy?.(); }catch{} }
function drawCharts(tx){
  const now=new Date(), months=[];
  for(let i=11;i>=0;i--){
    const d=new Date(now.getFullYear(), now.getMonth()-i, 1);
    months.push({label:d.toLocaleString(undefined,{month:'short'}),
      s:+new Date(d.getFullYear(),d.getMonth(),1),
      e:+new Date(d.getFullYear(),d.getMonth()+1,1)-1});
  }
  const mVals=months.map(m=>tx.filter(t=>t.type==='debit'&&t.date>=m.s&&t.date<=m.e).reduce((a,b)=>a+b.amount,0));
  const byCard={}, byCat={}, byMerch={};
  tx.forEach(t=>{
    if(t.type==='debit'){ byCard[t.card||'Unknown']=(byCard[t.card||'Unknown']||0)+t.amount;
                          byCat[t.category||'Other']=(byCat[t.category||'Other']||0)+t.amount; }
    byMerch[t.merchant||'Unknown']=(byMerch[t.merchant||'Unknown']||0)+t.amount;
  });
  const cum=[]; let run=0;
  tx.slice().sort((a,b)=>a.date-b.date).forEach(t=>{ run+=(t.type==='debit'?t.amount:0);
    cum.push({label:new Date(t.date).toLocaleDateString(undefined,{month:'short',day:'2-digit'}), value:run}); });

  ["cMonthly","cByCard","cCumulative","cCategory","cWeekday","cTopMerch"].forEach(destroyChart);

  const cm=$("#cMonthly")?.getContext("2d");
  if(cm) window.cMonthly=new Chart(cm,{type:"bar",data:{labels:months.map(m=>m.label),datasets:[{label:"₹",data:mVals.map(Math.abs)}]},options:{plugins:{legend:{display:false}}}});

  const cb=$("#cByCard")?.getContext("2d");
  if(cb) window.cByCard=new Chart(cb,{type:"doughnut",data:{labels:Object.keys(byCard),datasets:[{data:Object.values(byCard).map(Math.abs)}]},options:{plugins:{legend:{position:"bottom"}}}});

  const cc=$("#cCumulative")?.getContext("2d");
  if(cc) window.cCumulative=new Chart(cc,{type:"line",data:{labels:cum.map(x=>x.label),datasets:[{data:cum.map(x=>x.value),fill:false,tension:.25}]},options:{plugins:{legend:{display:false}}}});

  const ca=$("#cCategory")?.getContext("2d");
  if(ca) window.cCategory=new Chart(ca,{type:"doughnut",data:{labels:Object.keys(byCat),datasets:[{data:Object.values(byCat).map(Math.abs)}]},options:{plugins:{legend:{position:"bottom"}}}});

  const weekday=[0,0,0,0,0,0,0]; tx.forEach(t=>{ weekday[new Date(t.date).getDay()]+=t.type==='debit'?t.amount:0; });
  const cw=$("#cWeekday")?.getContext("2d");
  if(cw) window.cWeekday=new Chart(cw,{type:"bar",data:{labels:["Sun","Mon","Tue","Wed","Thu","Fri","Sat"],datasets:[{label:"₹",data:weekday.map(Math.abs)}]},options:{plugins:{legend:{display:false}}}});

  const top=Object.entries(byMerch).sort((a,b)=>b[1]-a[1]).slice(0,10);
  const ct=$("#cTopMerch")?.getContext("2d");
  if(ct) window.cTopMerch=new Chart(ct,{type:"bar",data:{labels:top.map(x=>x[0]),datasets:[{label:"₹",data:top.map(x=>Math.abs(x[1]))}]},options:{plugins:{legend:{display:false}}}});
}

// ---------- BOOT ----------
addEventListener("load",()=>{
  log("SCRIPT VERSION v7+");
  if('serviceWorker' in navigator) try{navigator.serviceWorker.register('sw.js');}catch{}
  // lazy init GSI
  let tries=0; const t=setInterval(()=>{tries++; if(initGsiIfPossible()||tries>40) clearInterval(t);},250);
  renderAll();
});
