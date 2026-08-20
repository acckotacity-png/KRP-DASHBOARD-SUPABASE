(function initKrpTheme() {
  const modeKey = "krp_theme_mode";
  const customKey = "krp_custom_theme_v1";
  const fields = ["bg", "surface", "text", "accent", "border"];
  const defaults = {
    light: { bg: "#eef3f0", surface: "#f7faf8", text: "#17324a", accent: "#059669", border: "#cbd8d1" },
    dark: { bg: "#06111a", surface: "#0b1924", text: "#d4dee7", accent: "#10b981", border: "#2b3a47" }
  };
  let editorSnapshot = null;
  let editorMode = "light";

  const systemDark = () => matchMedia("(prefers-color-scheme: dark)").matches;
  const selected = () => localStorage.getItem(modeKey) || "system";
  const isDark = () => selected() === "dark" || (selected() === "system" && systemDark());
  const activeMode = () => isDark() ? "dark" : "light";
  const validColor = value => /^#[0-9a-f]{6}$/i.test(String(value || ""));
  const readCustom = () => {
    try { return JSON.parse(localStorage.getItem(customKey) || "{}") || {}; }
    catch (_) { return {}; }
  };

  function applyPalette(palette) {
    const root = document.documentElement;
    const valid = palette && fields.every(name => validColor(palette[name]));
    root.classList.toggle("krp-custom-theme", !!valid);
    fields.forEach(name => valid
      ? root.style.setProperty(`--krp-user-${name}`, palette[name])
      : root.style.removeProperty(`--krp-user-${name}`));
  }

  function apply() {
    document.documentElement.classList.toggle("krp-dark-theme", isDark());
    applyPalette(readCustom()[activeMode()]);
    const button = document.getElementById("themeToggleBtn");
    if (button) {
      const dark = isDark();
      button.innerHTML = `<i class="fas ${dark ? "fa-sun" : "fa-moon"}"></i>`;
      button.removeAttribute("title");
      button.setAttribute("aria-label", dark ? "Switch to light theme" : "Switch to dark theme");
    }
  }

  function editorValues() {
    const values = {};
    fields.forEach(name => {
      const input = document.querySelector(`[data-theme-color="${name}"]`);
      values[name] = validColor(input?.value) ? input.value : defaults[editorMode][name];
    });
    return values;
  }

  function fillEditor(palette) {
    fields.forEach(name => {
      const input = document.querySelector(`[data-theme-color="${name}"]`);
      if (input) input.value = palette[name];
    });
    applyPalette(palette);
  }

  window.toggleKrpTheme = function toggleKrpTheme() {
    localStorage.setItem(modeKey, isDark() ? "light" : "dark");
    apply();
  };

  window.openThemeEditorFromHub = function openThemeEditorFromHub() {
    editorMode = activeMode();
    editorSnapshot = readCustom()[editorMode] || null;
    document.getElementById("headerSettingsHub")?.classList.remove("active");
    document.getElementById("themeEditorModal")?.classList.add("active");
    const label = document.getElementById("themeEditorModeLabel");
    if (label) label.textContent = editorMode === "dark" ? "Dark mode" : "Light mode";
    fillEditor(editorSnapshot || defaults[editorMode]);
  };

  window.closeThemeEditor = function closeThemeEditor(backToHub) {
    applyPalette(editorSnapshot);
    document.getElementById("themeEditorModal")?.classList.remove("active");
    if (backToHub) document.getElementById("headerSettingsHub")?.classList.add("active");
  };

  window.resetThemeEditor = function resetThemeEditor() {
    const all = readCustom();
    delete all[editorMode];
    localStorage.setItem(customKey, JSON.stringify(all));
    editorSnapshot = null;
    fields.forEach(name => {
      const input = document.querySelector(`[data-theme-color="${name}"]`);
      if (input) input.value = defaults[editorMode][name];
    });
    applyPalette(null);
    if (typeof window.showMessage === "function") window.showMessage("Original KRP theme restored", "success");
  };

  window.saveThemeEditor = function saveThemeEditor() {
    const all = readCustom();
    all[editorMode] = editorValues();
    localStorage.setItem(customKey, JSON.stringify(all));
    editorSnapshot = all[editorMode];
    applyPalette(editorSnapshot);
    if (typeof window.showMessage === "function") window.showMessage(`${editorMode === "dark" ? "Dark" : "Light"} theme saved`, "success");
    document.getElementById("themeEditorModal")?.classList.remove("active");
    document.getElementById("headerSettingsHub")?.classList.add("active");
  };

  document.addEventListener("input", event => {
    if (event.target?.matches?.("[data-theme-color]")) applyPalette(editorValues());
  });
  addEventListener("storage", event => { if (event.key === modeKey || event.key === customKey) apply(); });
  matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", () => { if (selected() === "system") apply(); });
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", apply);
  apply();
})();
