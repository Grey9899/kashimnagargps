// ক্লাউড সিঙ্ক: localStorage-এর ডেটা শিক্ষকের লগইন দিয়ে Firestore-এর সাথে মিলিয়ে রাখে।
// - firebase-config.js-এ কনফিগ না থাকলে কিছুই করে না।
// - লগইন না করলে সাইট আগের মতোই শুধু ওই ডিভাইসে চলে।
// - অন্য ডিভাইসে বদল এলে index.html-এর window.onRemoteData(keys) ডাকা হয়।
import { firebaseConfig, COLLECTION, SYNC_KEYS } from "./firebase-config.js";

const KEYS = new Set(SYNC_KEYS);
const SDK = "https://www.gstatic.com/firebasejs/10.14.1/";
const MOD_KEY = "fbsync_mod"; // কোন কী শেষ কখন এই ডিভাইসে বদলেছে (সিঙ্ক হয় না)
const PUSH_DELAY = 1200;

if (!firebaseConfig.apiKey || !firebaseConfig.appId) {
  console.info("[সিঙ্ক] firebase-config.js-এ কনফিগ বসানো হয়নি, ক্লাউড সিঙ্ক বন্ধ আছে।");
} else {
  start().catch(e => console.error("[সিঙ্ক] চালু করা যায়নি", e));
}

async function start() {
  const [appM, authM, fsM] = await Promise.all([
    import(SDK + "firebase-app.js"),
    import(SDK + "firebase-auth.js"),
    import(SDK + "firebase-firestore.js")
  ]);
  const { initializeApp } = appM;
  const { getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut, sendPasswordResetEmail } = authM;
  const { initializeFirestore, persistentLocalCache, persistentMultipleTabManager, getFirestore,
          collection, doc, setDoc, onSnapshot } = fsM;

  const app = initializeApp(firebaseConfig);
  const auth = getAuth(app);
  let db;
  try {
    db = initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });
  } catch (e) {
    db = getFirestore(app);
  }

  // ---------- localStorage পাহারা ----------
  const proto = Storage.prototype;
  const origSet = proto.setItem, origRemove = proto.removeItem, origGet = proto.getItem;
  const rawGet = k => { try { return origGet.call(localStorage, k); } catch (e) { return null; } };
  const readMods = () => { try { return JSON.parse(rawGet(MOD_KEY)) || {}; } catch (e) { return {}; } };
  const getMod = k => readMods()[k] || 0;
  const setMod = k => { const m = readMods(); m[k] = Date.now(); try { origSet.call(localStorage, MOD_KEY, JSON.stringify(m)); } catch (e) {} };

  let user = null;
  const timers = new Map();
  let inflight = 0;
  let firstSnapshot = true;
  let unsub = null;

  proto.setItem = function (k, v) {
    origSet.call(this, k, v);
    if (this === localStorage && KEYS.has(k)) onLocalChange(k);
  };
  proto.removeItem = function (k) {
    origRemove.call(this, k);
    if (this === localStorage && KEYS.has(k)) onLocalChange(k);
  };

  function onLocalChange(k) {
    setMod(k);
    if (user) schedulePush(k);
  }

  function schedulePush(k) {
    clearTimeout(timers.get(k));
    timers.set(k, setTimeout(() => pushKey(k), PUSH_DELAY));
    setStatus("syncing");
  }

  async function pushKey(k) {
    timers.delete(k);
    if (!user) return;
    inflight++;
    setStatus("syncing");
    try {
      await setDoc(doc(db, COLLECTION, k), { value: rawGet(k), updatedAt: Date.now(), by: user.email || "" });
    } catch (e) {
      console.error("[সিঙ্ক] পাঠানো যায়নি:", k, e);
      inflight--;
      setStatus(e && e.code === "permission-denied" ? "denied" : "error");
      return;
    }
    inflight--;
    refreshStatus();
  }

  function flushAll() { [...timers.keys()].forEach(k => { clearTimeout(timers.get(k)); pushKey(k); }); }
  window.addEventListener("pagehide", flushAll);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flushAll(); });

  // ---------- তালিকা মেলানোর নিয়ম ----------
  function mergeAttendance(a, b) {
    const pa = JSON.parse(a), pb = JSON.parse(b);
    if (!Array.isArray(pa) || !Array.isArray(pb)) return null;
    const byId = new Map();
    pa.concat(pb).forEach(r => {
      if (!r || r.id === undefined) return;
      const o = byId.get(r.id);
      if (!o) { byId.set(r.id, Object.assign({}, r)); return; }
      if (r.del || o.del) o.del = Math.max(r.del || 0, o.del || 0);
      if (r.inAt && (!o.inAt || r.inAt < o.inAt)) { o.inAt = r.inAt; if (r.inGeo !== undefined) o.inGeo = r.inGeo; }
      if (r.outAt && (!o.outAt || r.outAt > o.outAt)) { o.outAt = r.outAt; if (r.outGeo !== undefined) o.outGeo = r.outGeo; }
    });
    const list = [...byId.values()].sort((x, y) => (x.id > y.id) - (x.id < y.id));
    const seen = new Map();
    list.forEach(r => {
      if (r.del) return;
      const key = r.name + "|" + r.date;
      if (seen.has(key)) r.del = r.del || 1; else seen.set(key, r);
    });
    return JSON.stringify(list);
  }
  const MERGERS = { kashimnagar_attendance: mergeAttendance };

  // ---------- ক্লাউড থেকে আসা বদল ----------
  function listen() {
    stopListening();
    firstSnapshot = true;
    unsub = onSnapshot(collection(db, COLLECTION), snap => {
      const changed = new Set();
      snap.docChanges().forEach(ch => {
        if (ch.doc.metadata.hasPendingWrites || ch.type === "removed") return;
        const k = ch.doc.id;
        if (!KEYS.has(k)) return;
        const d = ch.doc.data();
        const remoteVal = d.value === undefined ? null : d.value;
        const localVal = rawGet(k);
        if (remoteVal === localVal) return;

        // হাজিরার মতো তালিকা: দুই দিকের তথ্য মিলিয়ে নেওয়া হয়, যেন একসাথে দেওয়া হাজিরা হারিয়ে না যায়
        if (MERGERS[k] && localVal !== null && remoteVal !== null) {
          let merged;
          try { merged = MERGERS[k](localVal, remoteVal); } catch (e) { merged = null; }
          if (merged !== null) {
            if (merged !== localVal) { try { origSet.call(localStorage, k, merged); changed.add(k); } catch (e) { console.error(e); } }
            if (merged !== remoteVal) schedulePush(k);
            return;
          }
        }

        // এই ডিভাইসের বদল ক্লাউডের চেয়ে নতুন হলে ক্লাউডকে এটাই পাঠানো হবে
        if (timers.has(k) || getMod(k) > (d.updatedAt || 0)) { schedulePush(k); return; }

        // ক্লাউডের তথ্য জেতে। প্রথমবার মেলানোর সময় ডিভাইসের পুরনো তথ্য ব্যাকআপ হিসেবে রাখা হয়
        if (localVal !== null && !getMod(k)) { try { origSet.call(localStorage, "fbsync_backup_" + k, localVal); } catch (e) {} }
        try {
          if (remoteVal === null) origRemove.call(localStorage, k);
          else origSet.call(localStorage, k, remoteVal);
          changed.add(k);
        } catch (e) { console.error("[সিঙ্ক] ডিভাইসে রাখা যায়নি:", k, e); }
      });

      if (firstSnapshot) {
        firstSnapshot = false;
        // ক্লাউডে যে কীগুলো এখনো নেই, ডিভাইসে থাকলে সেগুলো ওপরে পাঠানো হয়
        const have = new Set(snap.docs.map(x => x.id));
        KEYS.forEach(k => { if (!have.has(k) && rawGet(k) !== null) schedulePush(k); });
      }
      if (changed.size && typeof window.onRemoteData === "function") {
        try { window.onRemoteData(changed); } catch (e) { console.error(e); }
      }
      refreshStatus();
    }, err => {
      console.error("[সিঙ্ক] শোনা যায়নি", err);
      setStatus(err && err.code === "permission-denied" ? "denied" : "error");
    });
  }
  function stopListening() { if (unsub) { unsub(); unsub = null; } }

  // ---------- লগইন ----------
  // index.html-এর হাজিরা অংশ এখান থেকে লগইনের খবর পায়
  window.fbsAuth = { get user() { return user; }, openPanel: () => openPanel() };
  onAuthStateChanged(auth, u => {
    user = u;
    try { window.dispatchEvent(new CustomEvent("fbs-auth", { detail: { email: u ? u.email : null } })); } catch (e) {}
    if (u) { listen(); setStatus("syncing"); closePanel(); }
    else { stopListening(); timers.forEach(clearTimeout); timers.clear(); setStatus("out"); }
  });
  window.addEventListener("online", refreshStatus);
  window.addEventListener("offline", refreshStatus);

  function refreshStatus() {
    if (!user) return setStatus("out");
    if (!navigator.onLine) return setStatus("offline");
    setStatus(inflight > 0 || timers.size > 0 ? "syncing" : "ok");
  }

  // ---------- ছোট ইন্টারফেস ----------
  const css = document.createElement("style");
  css.textContent = `
    #fbs-badge{position:fixed;left:12px;bottom:12px;z-index:9998;font:600 13px/1 system-ui,sans-serif;
      padding:9px 13px;border-radius:999px;border:0;cursor:pointer;color:#fff;box-shadow:0 2px 10px rgba(0,0,0,.25)}
    #fbs-badge.out{background:#475569}#fbs-badge.ok{background:#059669}#fbs-badge.syncing{background:#2563eb}
    #fbs-badge.offline{background:#b45309}#fbs-badge.error,#fbs-badge.denied{background:#dc2626}
    #fbs-overlay{position:fixed;inset:0;z-index:9999;background:rgba(15,23,42,.55);display:flex;align-items:center;justify-content:center;padding:16px}
    #fbs-panel{background:#fff;color:#0f172a;width:100%;max-width:360px;border-radius:14px;padding:20px;font:15px/1.5 system-ui,sans-serif;box-shadow:0 10px 40px rgba(0,0,0,.35)}
    #fbs-panel h3{margin:0 0 4px;font-size:18px}#fbs-panel p{margin:0 0 12px;color:#475569;font-size:13px}
    #fbs-panel input{width:100%;box-sizing:border-box;margin:0 0 10px;padding:10px 12px;border:1px solid #cbd5e1;border-radius:8px;font-size:15px}
    #fbs-panel button{width:100%;padding:10px;border:0;border-radius:8px;font-size:15px;font-weight:600;cursor:pointer;margin-top:2px}
    #fbs-panel .p{background:#047857;color:#fff}#fbs-panel .s{background:#e2e8f0;color:#0f172a}
    #fbs-panel .l{background:none;color:#2563eb;font-size:13px;font-weight:500;padding:6px}
    #fbs-msg{min-height:18px;font-size:13px;color:#dc2626;margin:0 0 6px}
    @media print{#fbs-badge,#fbs-overlay{display:none!important}}`;
  document.head.appendChild(css);

  const badge = document.createElement("button");
  badge.id = "fbs-badge";
  badge.type = "button";
  badge.className = "no-print out";
  badge.addEventListener("click", openPanel);
  document.body.appendChild(badge);

  const LABELS = {
    out: "☁ লগইন করে সিঙ্ক চালু করুন",
    syncing: "☁ সিঙ্ক হচ্ছে…",
    ok: "☁ সিঙ্ক চালু",
    offline: "☁ অফলাইন (নেট এলে সিঙ্ক হবে)",
    error: "☁ সিঙ্কে সমস্যা, আবার চেষ্টা হবে",
    denied: "☁ এই ইমেইলের অনুমতি নেই"
  };
  function setStatus(s) { badge.className = "no-print " + s; badge.textContent = LABELS[s] || ""; }
  setStatus("out");

  let overlay = null;
  function closePanel() { if (overlay) { overlay.remove(); overlay = null; } }
  function openPanel() {
    closePanel();
    overlay = document.createElement("div");
    overlay.id = "fbs-overlay";
    overlay.addEventListener("click", e => { if (e.target === overlay) closePanel(); });
    const panel = document.createElement("div");
    panel.id = "fbs-panel";
    overlay.appendChild(panel);
    document.body.appendChild(overlay);

    if (user) {
      panel.innerHTML = `<h3>ক্লাউড সিঙ্ক চালু</h3><p></p>
        <button class="s" id="fbs-close">বন্ধ করুন</button>
        <button class="p" id="fbs-out" style="background:#dc2626;margin-top:8px">লগআউট</button>`;
      panel.querySelector("p").textContent = "লগইন: " + (user.email || "");
      panel.querySelector("#fbs-close").onclick = closePanel;
      panel.querySelector("#fbs-out").onclick = async () => { await signOut(auth); closePanel(); };
      return;
    }
    panel.innerHTML = `<h3>শিক্ষক লগইন</h3>
      <p>লগইন করলে তথ্য সব ডিভাইসে মিলে থাকবে। অ্যাকাউন্ট প্রধান শিক্ষক তৈরি করে দেন।</p>
      <input id="fbs-email" type="email" autocomplete="username" placeholder="ইমেইল">
      <input id="fbs-pass" type="password" autocomplete="current-password" placeholder="পাসওয়ার্ড">
      <div id="fbs-msg"></div>
      <button class="p" id="fbs-go">লগইন</button>
      <button class="l" id="fbs-reset" type="button">পাসওয়ার্ড ভুলে গেছেন?</button>
      <button class="s" id="fbs-close">এখন নয়</button>`;
    const $ = id => panel.querySelector(id);
    const msg = t => { $("#fbs-msg").textContent = t; };
    const go = async () => {
      const email = $("#fbs-email").value.trim(), pass = $("#fbs-pass").value;
      if (!email || !pass) return msg("ইমেইল ও পাসওয়ার্ড দিন।");
      msg(""); $("#fbs-go").disabled = true;
      try { await signInWithEmailAndPassword(auth, email, pass); }
      catch (e) { msg(authError(e)); $("#fbs-go").disabled = false; }
    };
    $("#fbs-go").onclick = go;
    $("#fbs-pass").addEventListener("keydown", e => { if (e.key === "Enter") go(); });
    $("#fbs-close").onclick = closePanel;
    $("#fbs-reset").onclick = async () => {
      const email = $("#fbs-email").value.trim();
      if (!email) return msg("আগে ইমেইল ঘরে ইমেইল লিখুন।");
      try { await sendPasswordResetEmail(auth, email); msg(""); alert("পাসওয়ার্ড বদলানোর লিংক ইমেইলে পাঠানো হয়েছে।"); }
      catch (e) { msg(authError(e)); }
    };
    $("#fbs-email").focus();
  }

  function authError(e) {
    const c = (e && e.code) || "";
    if (c.includes("invalid-credential") || c.includes("wrong-password") || c.includes("user-not-found")) return "ইমেইল বা পাসওয়ার্ড ভুল।";
    if (c.includes("invalid-email")) return "ইমেইলটি সঠিক নয়।";
    if (c.includes("too-many-requests")) return "অনেকবার ভুল হয়েছে। কিছুক্ষণ পর চেষ্টা করুন।";
    if (c.includes("network")) return "ইন্টারনেট সংযোগ পাওয়া যায়নি।";
    return "লগইন করা যায়নি (" + c + ")";
  }
}
