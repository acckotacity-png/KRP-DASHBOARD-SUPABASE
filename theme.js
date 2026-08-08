(function initKrpTheme() {
  const key = "krp_theme_mode";
  const systemDark = () => matchMedia("(prefers-color-scheme: dark)").matches;
  const selected = () => localStorage.getItem(key) || "system";
  const isDark = () => selected() === "dark" || (selected() === "system" && systemDark());

  function apply() {
    document.documentElement.classList.toggle("krp-dark-theme", isDark());
    const button = document.getElementById("themeToggleBtn");
    if (button) {
      const dark = isDark();
      button.innerHTML = `<i class="fas ${dark ? "fa-sun" : "fa-moon"}"></i> ${dark ? "Light" : "Dark"} Theme`;
      button.title = dark ? "Switch to light theme" : "Switch to dark theme";
    }
  }

  window.toggleKrpTheme = function toggleKrpTheme() {
    localStorage.setItem(key, isDark() ? "light" : "dark");
    apply();
  };
  addEventListener("storage", event => { if (event.key === key) apply(); });
  matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", () => { if (selected() === "system") apply(); });
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", apply);
  apply();
})();
