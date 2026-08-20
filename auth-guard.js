import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, AUTH_OPTIONS } from "./supabase-config.js?v=3";
import { installSupabaseApiAdapter } from "./supabase-api.js?v=13";

// Migrate the previous tab-only Supabase session once, then keep the PWA session
// across Chrome restarts. localStorage is Supabase's standard browser persistence.
try {
  for (let i = 0; i < window.sessionStorage.length; i += 1) {
    const key = window.sessionStorage.key(i);
    if (key?.startsWith("sb-") && key.endsWith("-auth-token") && !window.localStorage.getItem(key)) {
      window.localStorage.setItem(key, window.sessionStorage.getItem(key));
    }
  }
} catch (_) {}

const guardStyle = document.getElementById("auth-guard-style");
const configured = /^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(SUPABASE_URL)
  && SUPABASE_PUBLISHABLE_KEY
  && !SUPABASE_PUBLISHABLE_KEY.includes("YOUR_");

function reveal() {
  if (guardStyle) guardStyle.remove();
  document.documentElement.style.visibility = "visible";
}

function loginUrl(reason = "") {
  const current = location.pathname.split("/").pop() || AUTH_OPTIONS.homePage;
  const query = new URLSearchParams({ next: current });
  if (reason) query.set("error", reason);
  return `${AUTH_OPTIONS.loginPage}?${query.toString()}`;
}

if (!configured) {
  reveal();
  document.body.innerHTML = '<main style="max-width:620px;margin:80px auto;padding:24px;font-family:Arial;color:#1b2559"><h2>Supabase setup required</h2><p><b>supabase-config.js</b> me Project URL aur Publishable Key add karein.</p></main>';
  throw new Error("Supabase configuration is missing");
}

const client = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: { persistSession: true, storage: window.localStorage, autoRefreshToken: true, detectSessionInUrl: true }
});

window.supabaseClient = client;

let { data: sessionData } = await client.auth.getSession();
let session = sessionData?.session;
if (session) {
  const { error: userCheckError } = await client.auth.getUser();
  if (userCheckError) {
    const { data: refreshed } = await client.auth.refreshSession();
    session = refreshed?.session || null;
  }
}
if (!session?.user) {
  location.replace(loginUrl());
  throw new Error("Authentication required");
}
localStorage.setItem("krp_cache_user_uid", session.user.id);

async function readMyAccess() {
  return client.from("app_users").select("*").eq("user_id", session.user.id).maybeSingle();
}

let { data: access, error: accessError } = await readMyAccess();
if (accessError) {
  const { data: refreshed } = await client.auth.refreshSession();
  if (refreshed?.session) {
    session = refreshed.session;
    ({ data: access, error: accessError } = await readMyAccess());
  }
}

if (accessError) {
  reveal();
  document.body.innerHTML = `<main style="max-width:620px;margin:70px auto;padding:24px;font-family:Arial;color:#1b2559;text-align:center">
    <h2>Session verify नहीं हो सकी</h2>
    <p style="color:#687386">Internet या authentication service में temporary problem है। आपका account logout नहीं किया गया है।</p>
    <button onclick="location.reload()" style="border:0;border-radius:9px;padding:11px 18px;background:#168447;color:white;font-weight:700;cursor:pointer">Retry</button>
  </main>`;
  throw new Error("Access verification temporarily failed");
}

const accessExpired = access?.access_expires_at && new Date(access.access_expires_at) <= new Date();
const accessDenied = !access?.active || access?.access_status === "blocked" ||
  access?.access_status === "declined" || accessExpired || access?.can_view === false;
if (accessDenied) {
  await client.auth.signOut();
  const reason = access?.access_status === "blocked" ? "blocked" : accessExpired ? "expired" : "access_denied";
  location.replace(loginUrl(reason));
  throw new Error("This account is not authorized");
}

window.currentKrpUser = {
  uid: session.user.id,
  email: session.user.email || access.email || "",
  name: access.full_name || session.user.user_metadata?.full_name || "",
  mobile: access.mobile_no || "",
  designation: access.designation || "",
  avatarPath: access.avatar_path || "",
  role: access.role || "staff",
  accessExpiresAt: access.access_expires_at || null,
  permissions: {
    view: access.can_view !== false,
    create: access.role === "admin" || access.can_create !== false,
    edit: access.role === "admin" || access.can_edit !== false,
    delete: access.role === "admin" || access.can_delete !== false,
    settings: access.role === "admin",
    sections: {
      form: access.role === "admin" || access.can_data_entry !== false,
      tracker: access.role === "admin" || access.can_tracker !== false,
      dashboard: access.role === "admin" || access.can_dashboard !== false,
      notepad: access.role === "admin" || access.can_notepad !== false,
      transaction: access.role === "admin" || access.can_transactions !== false,
      udhari: access.role === "admin" || access.can_udhari !== false,
      expense: access.role === "admin" || access.can_expenses !== false
    }
  }
};
document.documentElement.classList.add(window.currentKrpUser.role === "admin" ? "krp-role-admin" : "krp-role-user");
if (window.currentKrpUser.avatarPath) {
  const { data: avatarData } = await client.storage.from("krp-avatars").createSignedUrl(window.currentKrpUser.avatarPath, 3600);
  window.currentKrpUser.avatarUrl = avatarData?.signedUrl || "";
}
try {
  localStorage.setItem(`krp_profile_bootstrap_${session.user.id}`, JSON.stringify({
    full_name: access.full_name || window.currentKrpUser.name,
    first_name: access.first_name || "",
    last_name: access.last_name || "",
    designation: access.designation || "",
    email: access.email || window.currentKrpUser.email,
    mobile_no: access.mobile_no || window.currentKrpUser.mobile,
    address: access.address || "",
    bio: access.bio || "",
    avatar_path: access.avatar_path || "",
    avatar_url: window.currentKrpUser.avatarUrl || "",
    cached_at: Date.now()
  }));
} catch (_) {}
window.dispatchEvent(new CustomEvent("krp-auth-ready", { detail: window.currentKrpUser }));
const permissionStyle = document.createElement("style");
permissionStyle.textContent = `${window.currentKrpUser.permissions.delete ? "" : '[onclick*="delete" i],.delete-btn,.btn-delete{display:none!important}'}
${window.currentKrpUser.permissions.edit ? "" : 'button[onclick^="edit" i],button[onclick*=";edit" i],[onclick*="editRecord" i],[onclick*="openEdit" i],[onclick*="openFullEdit" i],[onclick*="savePaymentUpdate" i],.edit-btn,.btn-edit,.btn-config,.records-action-btn.update{display:none!important}'}
${window.currentKrpUser.permissions.create ? "" : '[onclick*="openForm" i],[onclick*="toggleForm" i],[onclick*="openExpense" i],[onclick*="openNotepadModal" i],[onclick*="openAddRecordsModal" i],[onclick*="addCustomer" i],.btn-add,.records-action-btn.add,[data-right="create"]{display:none!important}'}
${window.currentKrpUser.permissions.settings ? "" : '#mainSettingsBtn,[onclick*="openHeaderSettingsHub"],[data-admin-only]{display:none!important}'}
${Object.entries(window.currentKrpUser.permissions.sections).filter(([,allowed])=>!allowed).map(([section])=>`[data-tab="${section}"],[data-section="${section}"]{display:none!important}`).join('\n')}`;
document.head.appendChild(permissionStyle);
const guardedPageSection = {
  "expense.html": "expense",
  "transaction.html": "transaction",
  "udhari.html": "udhari"
}[location.pathname.split("/").pop()];
if (guardedPageSection && session.user && access.role !== "admin" && window.currentKrpUser.permissions.sections[guardedPageSection] === false) {
  location.replace(`${AUTH_OPTIONS.homePage}?error=section_denied`);
  throw new Error("Section access denied");
}
if (window.currentKrpUser.accessExpiresAt) {
  setInterval(async () => {
    if (new Date(window.currentKrpUser.accessExpiresAt) <= new Date()) {
      await client.auth.signOut();
      location.replace(loginUrl("expired"));
    }
  }, 30000);
}

const deviceType = (() => {
  const ua = navigator.userAgent || "";
  const ipadDesktopMode = navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
  return /Android|iPhone|iPad|iPod|Mobile/i.test(ua) || ipadDesktopMode ? "mobile" : "desktop";
})();
const sessionTokenKey = `krp_active_session_${session.user.id}_${deviceType}`;
const storedSessionToken = localStorage.getItem(sessionTokenKey);
const forceClaimKey = `krp_force_session_claim_${session.user.id}`;
// A second tab/PWA window in the same browser shares localStorage and must reuse
// the same device token. Only a genuinely new browser storage claims a new token.
const forceNewLoginClaim = localStorage.getItem(forceClaimKey) === "1" && !storedSessionToken;
localStorage.removeItem(forceClaimKey);
const makeSessionToken = () => globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
const activeSessionToken = forceNewLoginClaim ? makeSessionToken() : (storedSessionToken || makeSessionToken());
localStorage.setItem(sessionTokenKey, activeSessionToken);
const deviceLabel = (() => {
  const ua = navigator.userAgent;
  const browser = /Edg/i.test(ua) ? "Edge" : /Chrome/i.test(ua) ? "Chrome" : /Firefox/i.test(ua) ? "Firefox" : /Safari/i.test(ua) ? "Safari" : "Browser";
  const device = /Android/i.test(ua) ? "Android mobile" : /iPhone|iPad/i.test(ua) ? "iPhone/iPad" : /Windows/i.test(ua) ? "Windows PC" : /Mac/i.test(ua) ? "Mac" : "another device";
  return `${browser} on ${device}`;
})();

let singleSessionEnabled = false;
let displacedSession = null;
let replacedPreviousSession = null;
try {
  const { data: existing, error: readSessionError } = await client.from("active_sessions").select("session_token,device_label,device_type").eq("user_id", session.user.id).eq("device_type", deviceType).maybeSingle();
  if (readSessionError) throw readSessionError;
  if (!forceNewLoginClaim && storedSessionToken && existing?.session_token && existing.session_token !== activeSessionToken) {
    displacedSession = existing;
  } else {
    if (existing?.session_token && existing.session_token !== activeSessionToken) replacedPreviousSession = existing;
    const { error: claimError } = await client.from("active_sessions").upsert({
      user_id: session.user.id,
      device_type: deviceType,
      session_token: activeSessionToken,
      device_label: deviceLabel,
      signed_in_at: new Date().toISOString(),
      last_seen: new Date().toISOString()
    }, { onConflict: "user_id,device_type" });
    if (claimError) throw claimError;
  }
  singleSessionEnabled = true;
} catch (error) {
  console.warn("Single-session protection needs SUPABASE-SINGLE-SESSION.sql:", error);
}

installSupabaseApiAdapter(client, window.currentKrpUser);

let logoutInProgress = false;
function showRemoteLoginPopup(remoteDevice = "another system") {
  const popup = document.createElement("div");
  popup.setAttribute("role", "alert");
  popup.style.cssText = "position:fixed;z-index:999999;right:14px;top:14px;max-width:340px;padding:14px 16px;border-radius:12px;background:#fff4e8;color:#7a2800;border:1px solid #ff8a3d;box-shadow:0 12px 34px rgba(0,0,0,.22);font:600 13px/1.45 Segoe UI,Arial,sans-serif";
  popup.textContent = `Yeh ID ab ${remoteDevice} par login hui hai. Is system se logout kiya ja raha hai.`;
  document.body.appendChild(popup);
}
function showNewLoginPopup(previousDevice = "previous browser") {
  const popup = document.createElement("div");
  popup.setAttribute("role", "status");
  popup.style.cssText = "position:fixed;z-index:999999;right:14px;top:14px;max-width:340px;padding:13px 15px;border-radius:12px;background:#e9fff3;color:#075b37;border:1px solid #29b978;box-shadow:0 12px 34px rgba(0,0,0,.22);font:700 12px/1.45 Segoe UI,Arial,sans-serif";
  popup.textContent = `Login successful. ${previousDevice} wali purani session logout kar di gayi hai.`;
  document.body.appendChild(popup);
  setTimeout(() => popup.remove(), 4200);
}

window.logoutKrpDashboard = async function logoutKrpDashboard(reason = "manual", remoteDevice = "") {
  if (logoutInProgress) return;
  logoutInProgress = true;
  if (reason === "remote_login") {
    showRemoteLoginPopup(remoteDevice);
    await new Promise(resolve => setTimeout(resolve, 2600));
    // If another context in this same browser already wrote the replacement
    // token, signing out here would clear its shared Supabase localStorage too.
    // Block only this stale page; keep the newly active browser session intact.
    if (localStorage.getItem(sessionTokenKey) !== activeSessionToken) {
      document.body.innerHTML = `<main style="position:fixed;inset:0;z-index:1000000;display:grid;place-items:center;padding:20px;background:#07111d;color:#f8fafc;font-family:Segoe UI,Arial,sans-serif">
        <section style="width:min(420px,100%);padding:22px;border:1px solid #294652;border-radius:14px;background:#10232e;text-align:center;box-shadow:0 18px 50px rgba(0,0,0,.38)">
          <h2 style="margin:0 0 9px;font-size:19px">Session updated</h2>
          <p style="margin:0 0 16px;color:#b8c8d2;font-size:13px;line-height:1.5">इसी Chrome में नई KRP window active है। इस पुराने page को सुरक्षित रूप से रोक दिया गया है।</p>
          <button type="button" onclick="location.replace('${AUTH_OPTIONS.homePage}')" style="border:0;border-radius:9px;padding:10px 15px;background:#168447;color:#fff;font-weight:800;cursor:pointer">Active App खोलें</button>
        </section>
      </main>`;
      reveal();
      return;
    }
  } else if (singleSessionEnabled) {
    await client.from("active_sessions").delete().eq("user_id", session.user.id).eq("device_type", deviceType).eq("session_token", activeSessionToken);
  }
  localStorage.removeItem(sessionTokenKey);
  await client.auth.signOut({ scope: "local" });
  location.replace(AUTH_OPTIONS.loginPage);
};

if (displacedSession) {
  reveal();
  await window.logoutKrpDashboard("remote_login", displacedSession.device_label || "another system");
  throw new Error("Session moved to another device");
}
if (replacedPreviousSession) setTimeout(() => showNewLoginPopup(replacedPreviousSession.device_label || "previous browser"), 250);

async function verifySingleSession() {
  if (!singleSessionEnabled || logoutInProgress || document.visibilityState === "hidden") return;
  const { data, error } = await client.from("active_sessions").select("session_token,device_label,device_type").eq("user_id", session.user.id).eq("device_type", deviceType).maybeSingle();
  if (error || !data) return;
  if (data.session_token !== activeSessionToken) {
    await window.logoutKrpDashboard("remote_login", data.device_label || "another system");
    return;
  }
  await client.from("active_sessions").update({ last_seen: new Date().toISOString() }).eq("user_id", session.user.id).eq("device_type", deviceType).eq("session_token", activeSessionToken);
}

if (singleSessionEnabled) {
  setInterval(verifySingleSession, 4000);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") verifySingleSession();
  });
  client.channel(`krp-session-${session.user.id}`)
    .on("postgres_changes", { event: "*", schema: "public", table: "active_sessions", filter: `user_id=eq.${session.user.id}` }, payload => {
      const next = payload.new;
      if (next?.device_type === deviceType && next?.session_token && next.session_token !== activeSessionToken) {
        window.logoutKrpDashboard("remote_login", next.device_label || "another system");
      }
    }).subscribe();
}

let idleTimer;
let lastActivityWrite = 0;
const idleMs = Math.max(1, Number(AUTH_OPTIONS.idleLogoutMinutes) || 60) * 60 * 1000;
const lastActivityKey = `krp_last_activity_${session.user.id}_${deviceType}_${activeSessionToken}`;

function readLastActivity() {
  const stored = Number(localStorage.getItem(lastActivityKey));
  return Number.isFinite(stored) && stored > 0 ? stored : Date.now();
}

function scheduleIdleCheck() {
  clearTimeout(idleTimer);
  const remainingMs = idleMs - (Date.now() - readLastActivity());
  if (remainingMs <= 0) {
    window.logoutKrpDashboard("idle");
    return;
  }
  idleTimer = setTimeout(scheduleIdleCheck, Math.min(remainingMs, 30000));
}

function recordActivity() {
  const now = Date.now();
  if (now - lastActivityWrite < 1000) return;
  lastActivityWrite = now;
  localStorage.setItem(lastActivityKey, String(now));
  scheduleIdleCheck();
}

if (!localStorage.getItem(lastActivityKey)) {
  localStorage.setItem(lastActivityKey, String(Date.now()));
}

["click", "keydown", "touchstart", "pointerdown", "pointermove", "scroll"].forEach(eventName =>
  addEventListener(eventName, recordActivity, { passive: true })
);
addEventListener("focus", scheduleIdleCheck);
document.addEventListener("visibilitychange", scheduleIdleCheck);
scheduleIdleCheck();

client.auth.onAuthStateChange((event, nextSession) => {
  if (event === "SIGNED_OUT" || !nextSession) location.replace(AUTH_OPTIONS.loginPage);
});

reveal();

