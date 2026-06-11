// Ghost Check — content script
// Runs on instagram.com. Uses your own logged-in session to fetch your
// "following" and "followers" lists via Instagram's internal web API,
// then diffs them. Nothing leaves your browser.

const IG_APP_ID = "936619743392459"; // same app id instagram.com's own frontend sends
let scanning = false;

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "PING") {
    sendResponse({ ok: true });
    return;
  }
  if (msg.type === "START_SCAN") {
    if (scanning) {
      sendResponse({ started: false, reason: "already-scanning" });
      return;
    }
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
  // Popup may be closed; ignore delivery failures.
  try {
    chrome.runtime.sendMessage({ type: "SCAN_UPDATE", ...update }).catch(() => {});
  } catch (_) { /* extension context gone */ }
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
      if (rateLimitRetries > 3) {
        throw new Error("Instagram rate-limited the scan. Wait a while and try again.");
      }
      report({ status: "progress", phase: kind, count: users.length, note: "Rate limited — pausing 30s" });
      await sleep(30000);
      continue;
    }
    if (res.status === 401 || res.status === 403) {
      throw new Error("Instagram refused the request. Make sure you're logged in, then refresh the tab.");
    }
    if (!res.ok) {
      throw new Error(`Instagram returned HTTP ${res.status}. Refresh the tab and try again.`);
    }

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

    // Polite delay between pages so big accounts don't trip rate limits.
    await sleep(900 + Math.random() * 800);
  }

  return users;
}

async function runScan() {
  const userId = getCookie("ds_user_id");
  if (!userId) {
    throw new Error("Couldn't find your session. Log in to Instagram in this tab, then try again.");
  }

  report({ status: "progress", phase: "following", count: 0 });
  const following = await fetchList("following", userId);

  report({ status: "progress", phase: "followers", count: 0 });
  const followers = await fetchList("followers", userId);

  const followerIds = new Set(followers.map((u) => u.id));
  const ghosts = following.filter((u) => !followerIds.has(u.id));

  const result = {
    scannedAt: Date.now(),
    followingCount: following.length,
    followersCount: followers.length,
    ghosts,
  };

  await chrome.storage.local.set({ lastScan: result });
  report({ status: "done", result });
}
