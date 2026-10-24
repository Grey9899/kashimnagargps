// ============================================================
//  firebase-sync.js  —  লগইন + ক্লাউড সিঙ্ক (Firebase Auth + Firestore)
//  পেজে যেভাবে যুক্ত: <script type="module" src="firebase-sync.js"></script>
//  পেজের সাথে চুক্তি:
//    window.fbsAuth = { user, openPanel(), signOut() }   → লগইনের অবস্থা
//    window 'fbs-auth' ইভেন্ট                            → লগইন বদলালে
//    window.onRemoteData(Set<key>)                       → অন্য ডিভাইসের বদল এলে
//  localStorage-এ নিচের কী লেখা হলে (শুধু অ্যাডমিন হলে) নিজে ক্লাউডে যায়।
//  সবাই (লগইন ছাড়াও) সব তথ্য দেখতে পায়; লেখা যায় শুধু অ্যাডমিনের; শিক্ষক শুধু নিজের হাজিরা (att) লিখতে পারেন।
//    window.fbsAuth.role = 'admin' | 'teacher' | 'viewer'
// ============================================================
const SDK_VERSION = '10.12.2';
const PUBLIC_KEYS = ['kashimnagar_school_holidays', 'kashimnagar_exam_routine', 'kashimnagar_school_profile', 'kashimnagar_social_links', 'kashimnagar_gps_auto'];
const PRIVATE_KEYS = ['students', 'lessonPlans', 'kashimnagar_glance_data', 'kashimnagar_senior_officers', 'kashimnagar_evaluation',
    'kashimnagar_stu_attendance', 'kashimnagar_report_extra', 'kashimnagar_teachers','kashimnagar_class_routine', 'kashimnagar_home_visits', 'kashimnagar_links', 'kashimnagar_stu_section', 'kashimnagar_teacher_leaves',
    'kashimnagar_school_geo', 'kashimnagar_school_radius', 'kashimnagar_last_visit_geo', 'kashimnagar_last_visit_date',
    'kashimnagar_last_visit_officer', 'kashimnagar_last_visit_desig', 'kashimnagar_visit_desig_options'];
const MERGE_BY_ID = {};
const ATT_KEY = 'kashimnagar_attendance';           // হাজিরা: প্রতিটি রেকর্ড আলাদা ডকুমেন্ট (schools/{id}/att/{রেকর্ড-আইডি})
const MAX_BYTES = 900000;                              // Firestore-এর প্রতি ডকুমেন্ট ১ MiB সীমার নিচে
const META_KEY = 'kashimnagar_fbs_meta';

const KEYCOL = {}; PUBLIC_KEYS.forEach(k => KEYCOL[k] = 'pub'); PRIVATE_KEYS.forEach(k => KEYCOL[k] = 'priv');
const nativeSet = Storage.prototype.setItem;
const state = { user: null, admin: false, role: 'viewer', applying: false, flushing: false, status: 'প্রস্তুত নয়', lastSync: null, errors: {}, big: {}, ready: false };
const first = { pub: null, priv: null };
let cfg = null, T = null, db = null, auth = null, unsubPriv = null, timer = null, retry = null;

// ---------- ছোট সহায়ক ----------
const meta = () => { try { const m = JSON.parse(localStorage.getItem(META_KEY)) || {}; m.rv = m.rv || {}; m.dirty = m.dirty || {}; return m; } catch (e) { return { rv: {}, dirty: {} }; } };
const saveMeta = m => { try { nativeSet.call(localStorage, META_KEY, JSON.stringify(m)); } catch (e) {} };
const bytes = s => new TextEncoder().encode(s).length;
const emit = (n, d) => { try { window.dispatchEvent(new CustomEvent(n, { detail: d })); } catch (e) {} };
const setStatus = (t) => { state.status = t; renderPanel(); };
const notify = keys => { if (!keys.size) return; try { if (typeof window.onRemoteData === 'function') window.onRemoteData(keys); } catch (e) { console.error('[fbs] onRemoteData', e); } emit('fbs-sync', { keys: Array.from(keys) }); };
const ERR = {
    'auth/invalid-credential': 'ইমেইল বা পাসওয়ার্ড ভুল।', 'auth/wrong-password': 'পাসওয়ার্ড ভুল।', 'auth/user-not-found': 'এই ইমেইলে কোনো অ্যাকাউন্ট নেই।',
    'auth/invalid-email': 'ইমেইলের ঠিকানা সঠিক নয়।', 'auth/too-many-requests': 'অনেকবার ভুল হয়েছে, কিছুক্ষণ পরে চেষ্টা করুন।',
    'auth/network-request-failed': 'ইন্টারনেট সংযোগ নেই।', 'permission-denied': 'এই ইমেইলের ডেটা লেখার/পড়ার অনুমতি নেই (firestore.rules দেখুন)।',
    'auth/missing-password': 'পাসওয়ার্ড লিখুন।', 'auth/user-disabled': 'অ্যাকাউন্টটি বন্ধ করা আছে।'
};
const errTxt = e => ERR[e && e.code] || ('ত্রুটি: ' + ((e && (e.code || e.message)) || e));

// ---------- কনফিগ ও SDK লোড ----------
try { cfg = await import('./firebase-config.js'); } catch (e) { console.info('[fbs] firebase-config.js পাওয়া যায়নি — ক্লাউড সিঙ্ক বন্ধ আছে।'); }
const okCfg = !!(cfg && cfg.firebaseConfig && cfg.firebaseConfig.apiKey && cfg.firebaseConfig.projectId && !/^YOUR_/i.test(cfg.firebaseConfig.apiKey) && !/^YOUR_/i.test(cfg.firebaseConfig.projectId));
const ADMINS = ((cfg && cfg.ADMIN_EMAILS) || ['grey.ru9899@gmail.com']).map(x => String(x).trim().toLowerCase());
const SID = String((cfg && cfg.SCHOOL_ID) || 'school').replace(/[^\w-]/g, '') || 'school';

async function loadSdk() {
    if (window.__FBS_SDK__) return window.__FBS_SDK__;
    const base = 'https://www.gstatic.com/firebasejs/' + SDK_VERSION + '/';
    const [a, au, fs] = await Promise.all([import(base + 'firebase-app.js'), import(base + 'firebase-auth.js'), import(base + 'firebase-firestore.js')]);
    return Object.assign({}, a, au, fs);
}

// ---------- ক্লাউড থেকে আসা তথ্য ----------
function applyDocs(snap, col) {
    const m = meta(), changed = new Set();
    snap.docChanges().forEach(ch => {
        if (ch.type === 'removed') return;
        const k = ch.doc.id, d = ch.doc.data();
        if (KEYCOL[k] !== col || !d || typeof d.v !== 'string') return;
        const ver = Number(d.ver) || 0;
        if (ver <= (m.rv[k] || 0)) return;          // নিজের পাঠানো/পুরনো তথ্য
        m.rv[k] = ver;
        if (m.dirty[k]) return;                     // এই ডিভাইসের অপ্রেরিত বদল আছে — সেটাই পরে যাবে
        try { JSON.parse(d.v); } catch (e) { return; }
        if (localStorage.getItem(k) === d.v) return;
        state.applying = true; try { nativeSet.call(localStorage, k, d.v); } finally { state.applying = false; }
        changed.add(k);
    });
    saveMeta(m);
    if (!first[col]) first[col] = new Set(snap.docs.map(x => x.id));
    trySeed(col);
    state.lastSync = new Date(); setStatus('সিঙ্ক চালু');
    notify(changed);
}
// ক্লাউডে যে কী নেই, এই ডিভাইসে থাকলে সেটা প্রথমবার ক্লাউডে তোলা হয়
function trySeed(col) {
    if (!state.admin || !first[col]) return;
    const m = meta(); let any = false;
    Object.keys(KEYCOL).filter(k => KEYCOL[k] === col).forEach(k => {
        if (!first[col].has(k) && !m.rv[k] && !m.dirty[k] && localStorage.getItem(k) != null) { m.dirty[k] = 1; any = true; }
    });
    if (any) { saveMeta(m); schedule(300); }
}

// ---------- ক্লাউডে পাঠানো ----------
function mergeById(remStr, locStr) {
    let r, l; try { r = JSON.parse(remStr); l = JSON.parse(locStr); } catch (e) { return locStr; }
    if (!Array.isArray(r) || !Array.isArray(l)) return locStr;
    const map = new Map(), out = [];
    r.forEach(x => { if (x && x.id != null) { map.set(String(x.id), x); out.push(x); } else out.push(x); });
    l.forEach(x => {
        if (!x || x.id == null) { out.push(x); return; }
        const id = String(x.id), ex = map.get(id);
        if (!ex) { map.set(id, x); out.push(x); return; }
        if (ex.del && !x.del) return;               // মোছা হয়ে থাকলে মোছাই থাকবে
        out[out.indexOf(ex)] = x; map.set(id, x);
    });
    return JSON.stringify(out);
}
async function pushKey(k) {
    const val = localStorage.getItem(k), m0 = meta();
    if (val == null) { delete m0.dirty[k]; saveMeta(m0); return; }
    if (bytes(val) > MAX_BYTES) { state.big[k] = bytes(val); delete m0.dirty[k]; saveMeta(m0); setStatus('কিছু তথ্য বড় হওয়ায় ক্লাউডে যায়নি'); return; }
    delete state.big[k];
    const ref = T.doc(db, 'schools', SID, KEYCOL[k], k);
    const res = await T.runTransaction(db, async tx => {
        const s = await tx.get(ref), rem = s.exists() ? s.data() : null;
        let out = val;
        if (MERGE_BY_ID[k] && rem && typeof rem.v === 'string') out = mergeById(rem.v, val);
        const nv = ((rem && Number(rem.ver)) || 0) + 1;
        tx.set(ref, { v: out, ver: nv, t: T.serverTimestamp(), by: state.user ? state.user.email : '' });
        return { nv, out };
    });
    const m = meta(); m.rv[k] = res.nv;
    if (res.out !== val) {                          // মিলিয়ে নেওয়া তথ্য এই ডিভাইসেও বসানো
        state.applying = true; try { nativeSet.call(localStorage, k, res.out); } finally { state.applying = false; }
        notify(new Set([k]));
    }
    if (localStorage.getItem(k) === res.out || res.out !== val) delete m.dirty[k]; else schedule(500);
    saveMeta(m);
}
function schedule(ms) { clearTimeout(timer); timer = setTimeout(flush, ms == null ? 1200 : ms); }
async function flush() {
    if (!state.admin || !db || state.flushing) return;
    if (!navigator.onLine) { setStatus('ইন্টারনেট নেই — সংযোগ এলে পাঠানো হবে'); return; }
    state.flushing = true; let failed = false;
    try {
        for (const k of Object.keys(meta().dirty)) {
            if (!KEYCOL[k]) continue;
            try { setStatus('পাঠানো হচ্ছে…'); await pushKey(k); delete state.errors[k]; }
            catch (e) { failed = true; state.errors[k] = errTxt(e); console.warn('[fbs] push', k, e); }
        }
    } finally { state.flushing = false; }
    if (failed) { setStatus('কিছু তথ্য পাঠানো যায়নি — আবার চেষ্টা হবে'); clearTimeout(retry); retry = setTimeout(flush, 20000); }
    else { state.lastSync = new Date(); setStatus('সিঙ্ক চালু — সব তথ্য ক্লাউডে'); }
}
// localStorage-এ যেকোনো লেখা ধরা (পেজের মূল কোড অপরিবর্তিত থাকে)
Storage.prototype.setItem = function (k, v) {
    let old = null; try { old = this.getItem(k); } catch (e) {}
    nativeSet.call(this, k, v);
    if (this === window.localStorage && !state.applying && KEYCOL[k] && state.admin && old !== String(v)) {
        const m = meta(); m.dirty[k] = 1; saveMeta(m); schedule();
        if (k === 'kashimnagar_teachers') setTimeout(syncRoles, 1500);
    }
    if (this === window.localStorage && !state.applying && k === ATT_KEY && state.user && old !== String(v)) setTimeout(pushAttDiff, 50);
};
window.addEventListener('online', () => schedule(500));


// ---------- হাজিরা (att): প্রতিটি রেকর্ড আলাদা ডকুমেন্ট; শিক্ষক শুধু নিজের রেকর্ড লিখতে পারেন ----------
const canon = o => JSON.stringify(o, (k, v) => (v && typeof v === 'object' && !Array.isArray(v)) ? Object.keys(v).sort().reduce((a, x) => (a[x] = v[x], a), {}) : v);
const attRemote = new Map(), attPending = new Map(); let attFirst = false;
const attClean = r => { const o = Object.assign({}, r); delete o.t; delete o.by; return o; };
function buildAtt() { const out = []; attRemote.forEach(v => out.push(v)); attPending.forEach((v, id) => { if (!attRemote.has(id) || canon(attRemote.get(id)) !== canon(v)) { const i = out.findIndex(x => String(x.id) === id); if (i >= 0) out[i] = v; else out.push(v); } }); return out; }
function writeAttLocal() {
    const arr = buildAtt(), cur = (() => { try { return JSON.parse(localStorage.getItem(ATT_KEY) || '[]'); } catch (e) { return []; } })();
    if (canon(arr) === canon(cur)) return;
    state.applying = true; try { nativeSet.call(localStorage, ATT_KEY, JSON.stringify(arr)); } finally { state.applying = false; }
    notify(new Set([ATT_KEY]));
}
function applyAtt(snap) {
    snap.docChanges().forEach(ch => { const id = ch.doc.id; if (ch.type === 'removed') attRemote.delete(id); else { const d = attClean(ch.doc.data()); d.id = d.id != null ? d.id : id; attRemote.set(id, d); if (attPending.has(id) && canon(attPending.get(id)) === canon(d)) attPending.delete(id); } });
    if (!attFirst) { attFirst = true; if (state.admin) migrateAtt(); }
    writeAttLocal(); state.lastSync = new Date(); setStatus('সিঙ্ক চালু');
}
function migrateAtt() {   // পুরনো (একটি ডকুমেন্টে রাখা) হাজিরা থাকলে একবার att-তে তোলা
    let loc = []; try { loc = JSON.parse(localStorage.getItem(ATT_KEY) || '[]'); } catch (e) {}
    loc.forEach(r => { if (r && r.id != null && !attRemote.has(String(r.id))) { attPending.set(String(r.id), r); pushAtt(r); } });
}
async function pushAtt(r) {
    if (!state.user || !db) return; const id = String(r.id);
    try {
        const body = Object.assign(attClean(r), { id: id, email: String(r.email || state.user.email).toLowerCase(), t: T.serverTimestamp(), by: state.user.email });
        await T.setDoc(T.doc(db, 'schools', SID, 'att', id), body); delete state.errors.att;
    } catch (e) { state.errors.att = errTxt(e); console.warn('[fbs] att', e); setStatus('হাজিরা পাঠানো যায়নি'); }
}
function pushAttDiff() {
    if (!state.user || !db) return; let loc = []; try { loc = JSON.parse(localStorage.getItem(ATT_KEY) || '[]'); } catch (e) { return; }
    loc.forEach(r => {
        if (!r || r.id == null) return; const id = String(r.id), rem = attRemote.get(id);
        if (rem && canon(rem) === canon(attClean(r))) return;
        if (!state.admin && String(r.email || '').toLowerCase() !== state.user.email) return;   // শিক্ষক অন্যের রেকর্ড বদলাতে পারেন না
        attPending.set(id, r); pushAtt(r);
    });
}
// ---------- ভূমিকা: অ্যাডমিন ইমেইল-তালিকা (লেখার অধিকার) ও শিক্ষক-তালিকা (শুধু হাজিরা) ----------
let rolesLast = '';
function teacherMails() { try { return (JSON.parse(localStorage.getItem('kashimnagar_teachers') || '[]') || []).map(t => String((t && t.mail) || '').trim().toLowerCase()).filter(x => /@/.test(x)); } catch (e) { return []; } }
function roleOf(email) { if (!email) return 'viewer'; if (ADMINS.indexOf(email) >= 0) return 'admin'; return teacherMails().indexOf(email) >= 0 ? 'teacher' : 'viewer'; }
async function syncRoles() {
    if (!state.admin || !db) return; const list = Array.from(new Set(teacherMails())).sort(), j = JSON.stringify(list);
    if (j === rolesLast) return;
    try { await T.setDoc(T.doc(db, 'schools', SID, 'sec', 'roles'), { teachers: list, t: T.serverTimestamp() }); rolesLast = j; } catch (e) { console.warn('[fbs] roles', e); state.errors.roles = errTxt(e); }
}
async function createTeacherLogin(email, pass) {
    if (!state.admin) throw { code: 'permission-denied' };
    let app2; try { app2 = T.getApp('kgsec'); } catch (e) { app2 = T.initializeApp(cfg.firebaseConfig, 'kgsec'); }
    const a2 = T.getAuth(app2); await T.createUserWithEmailAndPassword(a2, email, pass); await T.signOut(a2);
}

// ---------- লগইন প্যানেল ----------
const css = 'position:fixed;inset:0;z-index:100000;background:rgba(15,23,42,.55);display:flex;align-items:center;justify-content:center;font-family:"Noto Sans Bengali",sans-serif;padding:12px';
function renderPanel() {
    const ov = document.getElementById('fbsOverlay'); if (!ov) return;
    const box = ov.firstElementChild, u = state.user;
    const inp = 'width:100%;padding:10px;border:2px solid #a7f3d0;border-radius:10px;font:inherit;margin-top:6px;box-sizing:border-box';
    const btn = (c, id, t) => '<button type="button" id="' + id + '" style="width:100%;padding:10px;border:0;border-radius:10px;background:' + c + ';color:#fff;font:inherit;font-weight:700;margin-top:10px;cursor:pointer">' + t + '</button>';
    const keep = { e: (document.getElementById('fbsEmail') || {}).value || '', msg: (document.getElementById('fbsMsg') || {}).innerHTML || '' };
    let h = '<div style="display:flex;justify-content:space-between;align-items:center"><b style="font-size:17px;color:#065f46">☁ ক্লাউড লগইন</b><button type="button" id="fbsClose" style="border:0;background:#e2e8f0;border-radius:8px;padding:4px 10px;cursor:pointer">বন্ধ</button></div>';
    if (u) {
        const RL = { admin: 'অ্যাডমিন — সব কাজ করতে পারবেন', teacher: 'শিক্ষক — হাজিরা দিতে ও সব দেখতে পারবেন', viewer: 'শুধু দেখার অনুমতি (সম্পাদনা করতে পারবেন না)' };
        h += '<p style="margin:12px 0 4px;font-size:14px">লগইন: <b>' + u.email.replace(/[<>&]/g, '') + '</b></p>' +
            '<p style="margin:4px 0;font-size:13px;color:#047857;font-weight:700">ভূমিকা: ' + RL[state.role] + '</p>' +
            '<p style="margin:4px 0;font-size:13px;color:#334155">অবস্থা: ' + state.status + (state.lastSync ? ' (' + state.lastSync.toLocaleTimeString('bn-BD') + ')' : '') + '</p>' +
            Object.keys(state.big).map(k => '<p style="margin:2px 0;font-size:12px;color:#b45309">⚠ "' + k + '" অনেক বড় (' + Math.round(state.big[k] / 1024) + ' KB), ক্লাউডে যায়নি। ছবির সংখ্যা/মাপ কমান।</p>').join('') +
            Object.keys(state.errors).map(k => '<p style="margin:2px 0;font-size:12px;color:#b91c1c">✖ ' + k + ': ' + state.errors[k] + '</p>').join('') +
            (state.admin ? btn('#047857', 'fbsSync', 'এখনই সিঙ্ক করুন') + '<div style="margin-top:12px;padding:10px;border:1px dashed #94a3b8;border-radius:10px"><b style="font-size:13px">নতুন শিক্ষকের লগইন তৈরি</b><p style="margin:4px 0 0;font-size:11px;color:#64748b">শিক্ষক প্রোফাইলে একই ইমেইল দেওয়া থাকতে হবে। শিক্ষককে পাসওয়ার্ডটি জানিয়ে দিন।</p><input id="fbsNewEmail" type="email" placeholder="শিক্ষকের ইমেইল" style="' + inp + '"><input id="fbsNewPass" type="text" placeholder="পাসওয়ার্ড (কমপক্ষে ৬ অক্ষর)" style="' + inp + '">' + btn('#0369a1', 'fbsMk', 'লগইন তৈরি করুন') + '</div>' : '') + btn('#475569', 'fbsOut', 'লগআউট');
    } else {
        h += '<p style="margin:10px 0 0;font-size:13px;color:#475569">শিক্ষক/অ্যাডমিনের ইমেইল ও পাসওয়ার্ড দিয়ে ঢুকুন। লগইন ছাড়াও সবাই সাইট দেখতে পারেন, কিন্তু সম্পাদনা করতে পারেন শুধু অ্যাডমিন।</p>' +
            '<button type="button" id="fbsGoogle" style="width:100%;padding:11px;border:2px solid #cbd5e1;border-radius:10px;background:#fff;color:#1f2937;font:inherit;font-weight:700;margin-top:12px;cursor:pointer"><span style="font-weight:900;color:#4285f4">G</span> জিমেইল (Google) দিয়ে লগইন</button>' +
            '<p style="margin:10px 0 0;font-size:12px;color:#64748b;text-align:center">— অথবা ইমেইল ও পাসওয়ার্ড দিয়ে —</p>' +
            '<input id="fbsEmail" type="email" autocomplete="username" placeholder="ইমেইল" style="' + inp + '">' +
            '<input id="fbsPass" type="password" autocomplete="current-password" placeholder="পাসওয়ার্ড" style="' + inp + '">' +
            btn('#047857', 'fbsIn', 'লগইন') + '<button type="button" id="fbsReset" style="border:0;background:none;color:#0369a1;margin-top:8px;cursor:pointer;font:inherit;font-size:13px">পাসওয়ার্ড ভুলে গেছেন?</button>';
    }
    h += '<p id="fbsMsg" style="margin:8px 0 0;font-size:13px;color:#b91c1c">' + keep.msg + '</p>';
    box.innerHTML = h;
    const e = document.getElementById('fbsEmail'); if (e) e.value = keep.e;
    const on = (id, f) => { const x = document.getElementById(id); if (x) x.onclick = f; };
    const say = (t, ok) => { const x = document.getElementById('fbsMsg'); if (x) { x.style.color = ok ? '#047857' : '#b91c1c'; x.textContent = t; } };
    on('fbsClose', closePanel);
    on('fbsOut', () => T.signOut(auth).then(closePanel));
    on('fbsMk', async () => {
        const em = (document.getElementById('fbsNewEmail').value || '').trim().toLowerCase(), pw = document.getElementById('fbsNewPass').value;
        if (!/@/.test(em) || (pw || '').length < 6) return say('সঠিক ইমেইল ও কমপক্ষে ৬ অক্ষরের পাসওয়ার্ড দিন।');
        say('তৈরি হচ্ছে…', true);
        try { await createTeacherLogin(em, pw); await syncRoles(); say('লগইন তৈরি হয়েছে: ' + em, true); } catch (x) { say(x && x.code === 'auth/email-already-in-use' ? 'এই ইমেইলে আগেই অ্যাকাউন্ট আছে।' : x && x.code === 'auth/weak-password' ? 'পাসওয়ার্ড দুর্বল (কমপক্ষে ৬ অক্ষর)।' : errTxt(x)); }
    });
    on('fbsSync', () => { const m = meta(); Object.keys(KEYCOL).forEach(k => { if (localStorage.getItem(k) != null && !m.rv[k]) m.dirty[k] = 1; }); saveMeta(m); flush(); });
    on('fbsGoogle', async () => {
        say('Google-এ যাওয়া হচ্ছে…', true);
        const prov = new T.GoogleAuthProvider(); prov.setCustomParameters({ prompt: 'select_account' });
        try { await T.signInWithPopup(auth, prov); }
        catch (x) {
            if (x && (x.code === 'auth/popup-blocked' || x.code === 'auth/operation-not-supported-in-this-environment')) { try { await T.signInWithRedirect(auth, prov); return; } catch (y) { x = y; } }
            say(x && x.code === 'auth/popup-closed-by-user' ? 'লগইন বাতিল হয়েছে।' : x && x.code === 'auth/unauthorized-domain' ? 'এই সাইটের ঠিকানা Firebase-এর Authorized domains-এ যোগ করা নেই।' : x && x.code === 'auth/operation-not-allowed' ? 'Firebase-এ Google লগইন চালু করা হয়নি।' : errTxt(x));
        }
    });
    on('fbsIn', async () => {
        const em = document.getElementById('fbsEmail').value.trim(), pw = document.getElementById('fbsPass').value;
        if (!em || !pw) return say('ইমেইল ও পাসওয়ার্ড দিন।');
        say('লগইন হচ্ছে…', true);
        try { await T.signInWithEmailAndPassword(auth, em, pw); } catch (x) { say(errTxt(x)); }
    });
    on('fbsReset', async () => {
        const em = (document.getElementById('fbsEmail').value || '').trim(); if (!em) return say('আগে ইমেইল ঘরে ঠিকানা লিখুন।');
        try { await T.sendPasswordResetEmail(auth, em); say('পাসওয়ার্ড বদলের লিংক ইমেইলে পাঠানো হয়েছে।', true); } catch (x) { say(errTxt(x)); }
    });
    const pw = document.getElementById('fbsPass'); if (pw) pw.onkeydown = ev => { if (ev.key === 'Enter') document.getElementById('fbsIn').click(); };
}
function closePanel() { const o = document.getElementById('fbsOverlay'); if (o) o.remove(); }
function openPanel() {
    if (document.getElementById('fbsOverlay')) return;
    const ov = document.createElement('div'); ov.id = 'fbsOverlay'; ov.style.cssText = css;
    ov.innerHTML = '<div style="background:#fff;border-radius:16px;padding:18px;width:100%;max-width:380px;box-shadow:0 20px 50px rgba(0,0,0,.3)"></div>';
    ov.addEventListener('click', e => { if (e.target === ov) closePanel(); });
    document.body.appendChild(ov); renderPanel();
}

// ---------- চালু ----------
const api = { user: null, role: 'viewer', admin: false, get applying() { return state.applying; }, openPanel, signOut: () => (T && auth ? T.signOut(auth) : Promise.resolve()) };
if (okCfg) {
    window.fbsAuth = api;
    emit('fbs-auth');
    try {
        T = await loadSdk();
        const app = T.initializeApp(cfg.firebaseConfig);
        auth = T.getAuth(app); db = T.getFirestore(app); state.ready = true; setStatus('সংযুক্ত');
        // সবাই (লগইন ছাড়াও) পড়তে পারে — তাই শুরুতেই সব শুনি
        T.onSnapshot(T.collection(db, 'schools', SID, 'pub'), s => applyDocs(s, 'pub'), e => { state.errors.pub = errTxt(e); setStatus('পাবলিক তথ্য আনা যায়নি'); });
        T.onSnapshot(T.collection(db, 'schools', SID, 'priv'), s => applyDocs(s, 'priv'), e => { state.errors.priv = errTxt(e); setStatus('ডেটা আনা যায়নি'); });
        T.onSnapshot(T.collection(db, 'schools', SID, 'att'), s => applyAtt(s), e => { state.errors.att = errTxt(e); setStatus('হাজিরা আনা যায়নি'); });
        T.onAuthStateChanged(auth, u => {
            state.user = u ? { email: String(u.email || '').toLowerCase(), uid: u.uid } : null; api.user = state.user;
            state.role = state.user ? roleOf(state.user.email) : 'viewer'; state.admin = state.role === 'admin'; api.role = state.role; api.admin = state.admin;
            if (state.admin) { trySeed('pub'); trySeed('priv'); if (attFirst) migrateAtt(); schedule(800); syncRoles(); } else if (state.user) pushAttDiff();
            if (!u) setStatus('লগইন করা নেই');
            emit('fbs-auth'); renderPanel();
        });
        window.addEventListener('fbs-sync', () => { if (state.user) { const r = roleOf(state.user.email); if (r !== state.role) { state.role = r; state.admin = r === 'admin'; api.role = r; api.admin = state.admin; emit('fbs-auth'); renderPanel(); } } });
    } catch (e) {
        console.warn('[fbs] Firebase চালু করা যায়নি (ইন্টারনেট/কনফিগ):', e);
        state.status = 'Firebase লোড হয়নি — ইন্টারনেট দেখুন';
        api.openPanel = () => alert('Firebase লোড হয়নি। ইন্টারনেট সংযোগ ও firebase-config.js দেখুন।');
    }
}
