async function loadQqBootstrap() {
  const response = await fetch(document.body.dataset.bootstrapUrl);
  const payload = await response.json();
  document.getElementById("summary-grid").textContent = JSON.stringify(payload.connection, null, 2);
  document.getElementById("log-list").textContent = JSON.stringify(payload.logs, null, 2);
}

loadQqBootstrap().catch((error) => {
  document.getElementById("log-list").textContent = String(error);
});
