import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, AUTH_OPTIONS } from "./supabase-config.js";
import { installSupabaseApiAdapter } from "./supabase-api.js?v=6";

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
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
});

window.supabaseClient = client;

const { data: sessionData } = await client.auth.getSession();
const session = sessionData?.session;
if (!session?.user) {
  location.replace(loginUrl());
  throw new Error("Authentication required");
}

const { data: access, error: accessError } = await client
  .from("app_users")
  .select("user_id,email,full_name,role,active")
  .eq("user_id", session.user.id)
  .maybeSingle();

if (accessError || !access?.active) {
  await client.auth.signOut();
  location.replace(loginUrl("access_denied"));
  throw new Error("This account is not authorized");
}

window.currentKrpUser = {
  uid: session.user.id,
  email: session.user.email || access.email || "",
  name: access.full_name || session.user.user_metadata?.full_name || "",
  role: access.role || "staff"
};

installSupabaseApiAdapter(client, window.currentKrpUser);

window.logoutKrpDashboard = async function logoutKrpDashboard() {
  await client.auth.signOut();
  location.replace(AUTH_OPTIONS.loginPage);
};

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
