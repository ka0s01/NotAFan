// Ghost Check — popup logic

const $ = (id) => document.getElementById(id);
const scanBtn = $("scan-btn");
const exportBtn = $("export-btn");
const statusEl = $("status");
const resultsEl = $("results");
const filterEl = $("filter");

let currentGhosts = [];

init();

async function init() {
  const { lastScan } = await chrome.storage.local.get("lastScan");
  if (lastScan) renderResult(lastScan);

  scanBtn.addEventListener("click", startScan);
  exportBtn.addEventListener("click", exportCsv);
  filterEl.addEventListener("input", () => renderRows(currentGhosts, filterEl.value.trim().toLowerCase()));

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type !== "SCAN_UPDATE") return;
    if (msg.status === "progress") {
      const note = msg.note ? ` · ${msg.note}` : "";
      setStatus(`Fetching ${msg.phase}… ${msg.count} so far${note}`);
    } else if (msg.status === "done") {
      scanBtn.disabled = false;
      scanBtn.textContent = "Scan my account";
      setStatus("");
      renderResult(msg.result);
    } else if (msg.status === "error") {
      scanBtn.disabled = false;
      scanBtn.textContent = "Scan my account";
      setStatus(msg.message, true);
    }
  });
}

async function startScan() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const onInstagram = tab && tab.url && tab.url.startsWith("https://www.instagram.com");

  if (!onInstagram) {
    setStatus("Open instagram.com first — taking you there.", true);
    chrome.tabs.create({ url: "https://www.instagram.com/" });
    return;
  }

  // Make sure the content script is alive (it won't be if the tab predates install).
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "PING" });
  } catch (_) {
    setStatus("Refresh your Instagram tab once, then scan again.", true);
    return;
  }

  scanBtn.disabled = true;
  scanBtn.textContent = "Scanning…";
  setStatus("Starting scan…");
  chrome.tabs.sendMessage(tab.id, { type: "START_SCAN" }).catch(() => {
    scanBtn.disabled = false;
    scanBtn.textContent = "Scan my account";
    setStatus("Couldn't reach the Instagram tab. Refresh it and try again.", true);
  });
}

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle("error", isError);
}

function renderResult(result) {
  currentGhosts = result.ghosts || [];

  $("stats").classList.remove("hidden");
  $("stat-following").textContent = result.followingCount;
  $("stat-followers").textContent = result.followersCount;
  $("stat-ghosts").textContent = currentGhosts.length;
  $("scanned-at").textContent = new Date(result.scannedAt).toLocaleString();

  exportBtn.classList.toggle("hidden", currentGhosts.length === 0);
  filterEl.classList.toggle("hidden", currentGhosts.length < 8);

  renderRows(currentGhosts, "");
}

function renderRows(ghosts, query) {
  resultsEl.textContent = "";

  const shown = query
    ? ghosts.filter(
        (u) =>
          u.username.toLowerCase().includes(query) ||
          u.fullName.toLowerCase().includes(query)
      )
    : ghosts;

  if (shown.length === 0) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = query
      ? "No matches."
      : "No ghosts — everyone you follow follows you back.";
    resultsEl.appendChild(li);
    return;
  }

  for (const u of shown) {
    const li = document.createElement("li");
    const a = document.createElement("a");
    a.className = "row";
    a.href = `https://www.instagram.com/${u.username}/`;
    a.target = "_blank";
    a.rel = "noopener";

    const img = document.createElement("img");
    img.src = u.pic;
    img.alt = "";
    img.loading = "lazy";

    const names = document.createElement("div");
    names.className = "names";

    const uname = document.createElement("div");
    uname.className = "username";
    uname.textContent = u.username;
    if (u.verified) {
      const v = document.createElement("span");
      v.className = "verified";
      v.textContent = "✓";
      uname.appendChild(v);
    }

    const fname = document.createElement("div");
    fname.className = "fullname";
    fname.textContent = u.fullName;

    names.append(uname, fname);
    a.append(img, names);
    li.appendChild(a);
    resultsEl.appendChild(li);
  }
}

function exportCsv() {
  const header = "username,full_name,profile_url\n";
  const rows = currentGhosts
    .map((u) => {
      const name = `"${(u.fullName || "").replace(/"/g, '""')}"`;
      return `${u.username},${name},https://www.instagram.com/${u.username}/`;
    })
    .join("\n");

  const blob = new Blob([header + rows], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `instagram-ghosts-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}
