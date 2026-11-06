const LANGUAGES = ["English","German","Turkish","Polish","Spanish","French","Italian","Portuguese","Dutch","Hindi","Russian","Arabic"];

for (const id of ["sourceLanguage", "adaptedLanguage"]) {
  const sel = document.getElementById(id);
  sel.innerHTML = LANGUAGES.map((l) => `<option>${l}</option>`).join("");
}
document.getElementById("sourceLanguage").value = "German";
document.getElementById("adaptedLanguage").value = "Turkish";

async function health() {
  try {
    const h = await (await fetch("/api/health")).json();
    const el = document.getElementById("health");
    if (!h.dbConfigured) el.textContent = "Warning: database is not configured (MONGODB_URI missing) — submissions will fail.";
    else if (h.model && !h.model.keySet) el.textContent = `Warning: no API key set for provider "${h.model.provider}" — tasks cannot be processed.`;
    else if (h.model) el.textContent = `Model: ${h.model.provider} / ${h.model.model}`;
  } catch { /* server not up yet */ }
}

const dl = (taskId, kind, label) =>
  `<a class="dl" href="/api/tasks/${taskId}/files/${kind}">${label}</a>`;

function renderTasks(tasks) {
  const tbody = document.querySelector("#tasksTable tbody");
  document.getElementById("noTasks").style.display = tasks.length ? "none" : "block";
  tbody.innerHTML = tasks.map((t) => {
    const inputs = [
      t.files.source && dl(t.taskId, "source", "Source"),
      t.files.adapted && dl(t.taskId, "adapted", "Adapted"),
      t.files.ls && dl(t.taskId, "ls", "LS sheet"),
    ].filter(Boolean).join(" ");
    const outputs = t.files.review ? [
      dl(t.taskId, "review", "Review (highlighted)"),
      dl(t.taskId, "corrected", "Corrected"),
      dl(t.taskId, "changelog", "Change log"),
    ].join(" ") : "";
    let result = "";
    if (t.status === "Ready" && t.summary) {
      result = `${t.summary.totalFixes} fixes · ${t.summary.pass2Finds} pass-2 finds`;
    } else if (t.status === "Processing" && t.progress) {
      result = `Episode ${t.progress.done} of ${t.progress.total}`;
    } else if (t.status === "Failed" && t.error) {
      result = `<span class="err">${t.error}</span>`;
    }
    const reprocess = (t.status === "Failed" || t.status === "Ready")
      ? `<button data-reprocess="${t.taskId}">Reprocess</button>` : "";
    return `<tr>
      <td><strong>${t.taskId}</strong></td>
      <td>${t.showName}</td>
      <td>${t.sourceLanguage} → ${t.adaptedLanguage}</td>
      <td><span class="status s-${t.status.toLowerCase()}">${t.status}</span></td>
      <td>${result}</td>
      <td><div class="dls"><span class="dlgroup">In: ${inputs || "—"}</span>${outputs ? `<span class="dlgroup">Out: ${outputs}</span>` : ""}</div></td>
      <td>${reprocess}</td>
    </tr>`;
  }).join("");
  tbody.querySelectorAll("[data-reprocess]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      await fetch(`/api/tasks/${btn.dataset.reprocess}/reprocess`, { method: "POST" });
      loadTasks();
    });
  });
}

async function loadTasks() {
  try {
    const tasks = await (await fetch("/api/tasks")).json();
    if (Array.isArray(tasks)) renderTasks(tasks);
  } catch { /* ignore transient errors */ }
}

document.getElementById("submitForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = document.getElementById("submitBtn");
  const msg = document.getElementById("submitMsg");
  btn.disabled = true;
  msg.textContent = "Uploading…";
  try {
    const res = await fetch("/api/tasks", { method: "POST", body: new FormData(e.target) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Submission failed");
    msg.textContent = `Task created: ${data.taskId} — status ${data.status}. Processing starts automatically; outputs will appear in the Downloads column.`;
    e.target.reset();
    document.getElementById("sourceLanguage").value = "German";
    document.getElementById("adaptedLanguage").value = "Turkish";
    loadTasks();
  } catch (err) {
    msg.textContent = `Error: ${err.message}`;
  } finally {
    btn.disabled = false;
  }
});

health();
loadTasks();
setInterval(loadTasks, 5000);
