import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, AUTH_OPTIONS } from "./supabase-config.js";
import { installSupabaseApiAdapter } from "./supabase-api.js?v=11";

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
  auth: { persistSession: true, storage: window.sessionStorage, autoRefreshToken: true, detectSessionInUrl: true }
});

window.supabaseClient = client;

const { data: sessionData } = await client.auth.getSession();
const session = sessionData?.session;
if (!session?.user) {
  location.replace(loginUrl());
  throw new Error("Authentication required");
}
sessionStorage.setItem("krp_cache_user_uid", session.user.id);

const { data: access, error: accessError } = await client
  .from("app_users")
  .select("*")
  .eq("user_id", session.user.id)
  .maybeSingle();

const accessExpired = access?.access_expires_at && new Date(access.access_expires_at) <= new Date();
const accessDenied = accessError || !access?.active || access?.access_status === "blocked" ||
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
    settings: access.role === "admin" || access.can_manage_settings === true,
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
if (window.currentKrpUser.avatarPath) {
  const { data: avatarData } = await client.storage.from("krp-avatars").createSignedUrl(window.currentKrpUser.avatarPath, 3600);
  window.currentKrpUser.avatarUrl = avatarData?.signedUrl || "";
}
window.dispatchEvent(new CustomEvent("krp-auth-ready", { detail: window.currentKrpUser }));
const permissionStyle = document.createElement("style");
permissionStyle.textContent = `${window.currentKrpUser.permissions.delete ? "" : '[onclick*="delete" i],.delete-btn,.btn-delete{display:none!important}'}
${window.currentKrpUser.permissions.edit ? "" : '[onclick*="editRecord" i],[onclick*="openEdit" i],.edit-btn,.btn-edit,.btn-config,.records-action-btn.update{display:none!important}'}
${window.currentKrpUser.permissions.create ? "" : '[onclick*="openForm" i],[onclick*="addCustomer" i],.btn-add{display:none!important}'}
${window.currentKrpUser.permissions.settings ? "" : '#mainSettingsBtn,[onclick*="openHeaderSettingsHub"]{display:none!important}'}
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

const sessionTokenKey = `krp_active_session_${session.user.id}`;
const storedSessionToken = sessionStorage.getItem(sessionTokenKey);
const activeSessionToken = storedSessionToken || crypto.randomUUID();
sessionStorage.setItem(sessionTokenKey, activeSessionToken);
const deviceLabel = (() => {
  const ua = navigator.userAgent;
  const browser = /Edg/i.test(ua) ? "Edge" : /Chrome/i.test(ua) ? "Chrome" : /Firefox/i.test(ua) ? "Firefox" : /Safari/i.test(ua) ? "Safari" : "Browser";
  const device = /Android/i.test(ua) ? "Android mobile" : /iPhone|iPad/i.test(ua) ? "iPhone/iPad" : /Windows/i.test(ua) ? "Windows PC" : /Mac/i.test(ua) ? "Mac" : "another device";
  return `${browser} on ${device}`;
})();

let singleSessionEnabled = false;
let displacedSession = null;
try {
  const { data: existing, error: readSessionError } = await client.from("active_sessions").select("session_token,device_label").eq("user_id", session.user.id).maybeSingle();
  if (readSessionError) throw readSessionError;
  if (storedSessionToken && existing?.session_token && existing.session_token !== activeSessionToken) {
    displacedSession = existing;
  } else {
    const { error: claimError } = await client.from("active_sessions").upsert({
      user_id: session.user.id,
      session_token: activeSessionToken,
      device_label: deviceLabel,
      signed_in_at: new Date().toISOString(),
      last_seen: new Date().toISOString()
    }, { onConflict: "user_id" });
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

window.logoutKrpDashboard = async function logoutKrpDashboard(reason = "manual", remoteDevice = "") {
  if (logoutInProgress) return;
  logoutInProgress = true;
  if (reason === "remote_login") {
    showRemoteLoginPopup(remoteDevice);
    await new Promise(resolve => setTimeout(resolve, 2600));
  } else if (singleSessionEnabled) {
    await client.from("active_sessions").delete().eq("user_id", session.user.id).eq("session_token", activeSessionToken);
  }
  sessionStorage.removeItem(sessionTokenKey);
  await client.auth.signOut({ scope: "local" });
  location.replace(AUTH_OPTIONS.loginPage);
};

if (displacedSession) {
  reveal();
  await window.logoutKrpDashboard("remote_login", displacedSession.device_label || "another system");
  throw new Error("Session moved to another device");
}

async function verifySingleSession() {
  if (!singleSessionEnabled || logoutInProgress || document.visibilityState === "hidden") return;
  const { data, error } = await client.from("active_sessions").select("session_token,device_label").eq("user_id", session.user.id).maybeSingle();
  if (error || !data) return;
  if (data.session_token !== activeSessionToken) {
    await window.logoutKrpDashboard("remote_login", data.device_label || "another system");
    return;
  }
  await client.from("active_sessions").update({ last_seen: new Date().toISOString() }).eq("user_id", session.user.id).eq("session_token", activeSessionToken);
}

if (singleSessionEnabled) {
  setInterval(verifySingleSession, 4000);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") verifySingleSession();
  });
  client.channel(`krp-session-${session.user.id}`)
    .on("postgres_changes", { event: "*", schema: "public", table: "active_sessions", filter: `user_id=eq.${session.user.id}` }, payload => {
      const next = payload.new;
      if (next?.session_token && next.session_token !== activeSessionToken) {
        window.logoutKrpDashboard("remote_login", next.device_label || "another system");
      }
    }).subscribe();
}

let idleTimer;
const idleMs = Math.max(1, Number(AUTH_OPTIONS.idleLogoutMinutes) || 5) * 60 * 1000;
function resetIdleTimer() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => window.logoutKrpDashboard(), idleMs);
}
["click", "keydown", "touchstart", "pointerdown", "scroll"].forEach(eventName =>
  addEventListener(eventName, resetIdleTimer, { passive: true })
);
resetIdleTimer();

client.auth.onAuthStateChange((event, nextSession) => {
  if (event === "SIGNED_OUT" || !nextSession) location.replace(AUTH_OPTIONS.loginPage);
});

reveal();

