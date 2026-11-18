// ============================================================
// KRP · Suspicious upload activity popup (sirf ADMIN ko)
// Dashboard khulte hi naye (bina dekhe) alerts ka popup.
// "Baad mein" dabane par is session mein dobara nahi dikhega,
// jab tak koi naya alert na aaye.
// ============================================================
(function () {
  const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmt = v => v ? new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(v)) : "";
  let started = false;

  async function run(user) {
    if (started || !user || user.role !== "admin" || !window.supabaseClient) return;
    started = true;
    try {
      const { data, error } = await window.supabaseClient.rpc("upload_get_alerts");
      if (error || !Array.isArray(data)) return;
      const open = data.filter(a => !a.acked);
      if (!open.length) return;

      const latest = open.reduce((m, a) => (a.last_seen > m ? a.last_seen : m), "");
      const seenKey = "krp_upload_alerts_dismissed";
      let dismissed = "";
      try { dismissed = sessionStorage.getItem(seenKey) || ""; } catch (_) {}
      if (dismissed === `${open.length}|${latest}`) return;

      const high = open.filter(a => a.severity === "high").length;
      const color = high ? "#dc3a34" : "#ef941b";
      const box = document.createElement("div");
      box.setAttribute("role", "alert");
      box.style.cssText = `position:fixed;z-index:99999;right:16px;bottom:16px;width:min(380px,calc(100% - 32px));background:#fff;color:#24364a;border:1px solid #e1e7ef;border-left:6px solid ${color};border-radius:12px;box-shadow:0 14px 38px rgba(0,0,0,.25);padding:14px 14px 12px;font:13px/1.45 "Segoe UI",Arial,sans-serif`;
      box.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
          <b style="font-size:15px;color:${color}">⚠ Suspicious Activity</b>
          <button type="button" data-x style="border:0;background:none;font-size:18px;cursor:pointer;color:#7a8598">×</button>
        </div>
        <div style="margin:4px 0 8px;color:#53617a">${open.length} naye alert${open.length > 1 ? "s" : ""}${high ? ` · <b style="color:#dc3a34">${high} high</b>` : ""} (upload licenses)</div>
        <ul style="margin:0 0 10px;padding-left:18px">${open.slice(0, 4).map(a =>
          `<li style="margin:3px 0"><b>${esc(a.title)}</b> · ${esc(a.mobile)} <span style="color:#7a8598;font-size:11px">${esc(fmt(a.last_seen))}</span></li>`).join("")}
          ${open.length > 4 ? `<li style="color:#7a8598">...aur ${open.length - 4}</li>` : ""}</ul>
        <div style="display:flex;gap:7px;justify-content:flex-end">
          <button type="button" data-later style="border:1px solid #d6dce5;background:#fff;color:#344256;border-radius:8px;padding:8px 11px;font-weight:700;cursor:pointer">Baad mein</button>
          <button type="button" data-go style="border:0;background:${color};color:#fff;border-radius:8px;padding:8px 12px;font-weight:800;cursor:pointer">Alerts dekhein</button>
        </div>`;
      const close = () => { try { sessionStorage.setItem(seenKey, `${open.length}|${latest}`); } catch (_) {} box.remove(); };
      box.querySelector("[data-x]").onclick = close;
      box.querySelector("[data-later]").onclick = close;
      box.querySelector("[data-go]").onclick = () => { location.href = "upload-licenses.html?tab=alerts"; };
      document.body.appendChild(box);
    } catch (_) { /* alerts table/function abhi nahi bana - chupchap chhod do */ }
  }

  window.addEventListener("krp-auth-ready", e => setTimeout(() => run(e.detail), 1500));
  if (window.currentKrpUser) setTimeout(() => run(window.currentKrpUser), 1500);
})();
