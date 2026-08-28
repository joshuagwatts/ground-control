await import("./app.js?v=0234").catch((err) => {
  const root = document.getElementById("view");
  const msg = String(err?.message || err || "boot failed");
  if (root) {
    root.innerHTML = `<h3>GC BOOT ERROR</h3><p class="muted">${msg.replace(/</g, "&lt;")}</p>`;
  }
  const st = document.getElementById("status");
  if (st) st.textContent = "BOOT FAILED";
  console.error(err);
});
