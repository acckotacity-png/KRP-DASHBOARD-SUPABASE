(function installKrpApiGate() {
  if (window.__krpApiGateInstalled) return;
  window.__krpApiGateInstalled = true;
  const nativeFetch = window.fetch.bind(window);
  const waiting = [];

  window.fetch = function krpGatedFetch(input, init) {
    const url = typeof input === "string" ? input : (input && input.url) || "";
    if (!url.includes("__krp_supabase_api__")) return nativeFetch(input, init);
    return new Promise((resolve, reject) => waiting.push({ input, init, resolve, reject }));
  };

  window.__krpResolveApiGate = function resolveKrpApiGate() {
    const pending = waiting.splice(0);
    pending.forEach(job => window.fetch(job.input, job.init).then(job.resolve, job.reject));
  };
})();
