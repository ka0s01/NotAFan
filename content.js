// NotAFan — content script
const IG_APP_ID = "936619743392459";
let scanning = false;

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "PING") { sendResponse({ ok: true }); return; }
  if (msg.type === "START_SCAN") {
    if (scanning) { sendResponse({ started: false, reason: "already-scanning" }); return; }
    scanning = true;
    runScan()
      .catch((err) => report({ status: "error", message: err.message || String(err) }))
      .finally(() => { scanning = false; });
    sendResponse({ started: true });
  }
});

function getCookie(name) {
  const match = document.cookie.match(new RegExp("(?:^|; )" + name + "=([^;]*)"));
  return match ? decodeURIComponent(match[1]) : null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function report(update) {
  try { chrome.runtime.sendMessage({ type: "SCAN_UPDATE", ...update }).catch(() => {}); }
  catch (_) {}
}

async function fetchImageAsBase64(url) {
  try {
    const res = await fetch(url, { credentials: "include" });
    if (!res.ok) return null;
    const blob = await res.blob();
    return await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

async function fetchList(kind, userId) {
  const users = [];
  let maxId = null;
  let rateLimitRetries = 0;

  while (true) {
    const url =
      `https://www.instagram.com/api/v1/friendships/${userId}/${kind}/?count=100` +
      (maxId ? `&max_id=${encodeURIComponent(maxId)}` : "");

    const res = await fetch(url, {
      headers: { "x-ig-app-id": IG_APP_ID },
      credentials: "include",
    });

    if (res.status === 429) {
      rateLimitRetries++;
      if (rateLimitRetries > 3) throw new Error("Instagram rate-limited the scan. Wait a while and try again.");
      report({ status: "progress", phase: kind, count: users.length, note: "Rate limited — pausing 30s" });
      await sleep(30000);
      continue;
    }
    if (res.status === 401 || res.status === 403)
      throw new Error("Instagram refused the request. Make sure you're logged in, then refresh the tab.");
    if (!res.ok)
      throw new Error(`Instagram returned HTTP ${res.status}. Refresh the tab and try again.`);

    const data = await res.json();
    for (const u of data.users || []) {
      users.push({
        id: String(u.pk ?? u.pk_id ?? u.id ?? ""),
        username: u.username,
        fullName: u.full_name || "",
        pic: u.profile_pic_url || "",
        verified: !!u.is_verified,
      });
    }

    report({ status: "progress", phase: kind, count: users.length });
    maxId = data.next_max_id || null;
    if (!maxId) break;
    await sleep(900 + Math.random() * 800);
  }

  return users;
}

async function runScan() {
  const userId = getCookie("ds_user_id");
  if (!userId) throw new Error("Couldn't find your session. Log in to Instagram in this tab, then try again.");

  report({ status: "progress", phase: "following", count: 0 });
  const following = await fetchList("following", userId);

  report({ status: "progress", phase: "followers", count: 0 });
  const followers = await fetchList("followers", userId);

  const followerIds = new Set(followers.map((u) => u.id));
  const ghosts = following.filter((u) => !followerIds.has(u.id));

  // Fetch profile pics as base64 so popup can display them without CDN blocking
  report({ status: "progress", phase: "avatars", count: 0 });
  for (let i = 0; i < ghosts.length; i++) {
    if (ghosts[i].pic) {
      ghosts[i].pic = (await fetchImageAsBase64(ghosts[i].pic)) || "";
    }
    if (i % 10 === 0) report({ status: "progress", phase: "avatars", count: i });
    await sleep(50); // light delay, these are small images
  }

  const result = {
    scannedAt: Date.now(),
    followingCount: following.length,
    followersCount: followers.length,
    ghosts,
  };

  await chrome.storage.local.set({ lastScan: result });
  report({ status: "done", result });
}