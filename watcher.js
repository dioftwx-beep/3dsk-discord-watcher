import fs from "fs";
import { chromium } from "playwright";

const URL =
  "https://www.3d.sk/photo_sets/search/premium/1/standard/1/thumb/small/orderBy/chronology/fresh/";

const STATE_FILE = "state.json";
const MAX_POST = 5;

function normalize(url) {
  if (!url) return null;
  if (url.startsWith("//")) return "https:" + url;
  if (url.startsWith("/")) return "https://www.3d.sk" + url;
  return url;
}

function loadState() {
  if (!fs.existsSync(STATE_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return [];
  }
}

function saveState(arr) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(arr, null, 2), "utf8");
}

async function sendToDiscord(webhook, items) {
  const embeds = items.map((i) => ({
    title: i.title || "New set",
    url: i.url,
    image: i.image ? { url: i.image } : undefined
  }));

  const res = await fetch(webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      content: `🆕 New premium sets (${items.length})`,
      embeds
    })
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Discord webhook failed: ${res.status} ${res.statusText} ${txt}`);
  }
}

(async () => {
  const webhook = process.env.DISCORD_WEBHOOK_URL;
  if (!webhook) throw new Error("Missing DISCORD_WEBHOOK_URL secret.");

  const seenList = loadState();
  const seen = new Set(seenList);

  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(URL, { waitUntil: "networkidle" });

  // Vytáhneme odkazy na sety a k nim thumbnail
  const items = await page.evaluate(() => {
    const uniq = new Map();

    // vezmi odkazy, které vypadají jako set detail
    const anchors = Array.from(document.querySelectorAll("a[href]"));
    for (const a of anchors) {
      const href = a.getAttribute("href") || "";
      if (!href.includes("/photo_sets/")) continue;

      const title =
        (a.textContent || "").trim().replace(/\s+/g, " ") ||
        a.getAttribute("title") ||
        null;

      const img =
        a.querySelector("img") ||
        a.parentElement?.querySelector("img") ||
        a.closest("*")?.querySelector("img");

      const image =
        img?.getAttribute("src") ||
        img?.getAttribute("data-src") ||
        img?.getAttribute("data-lazy") ||
        img?.getAttribute("data-original") ||
        null;

      if (!uniq.has(href)) {
        uniq.set(href, { url: href, title, image });
      }
    }

    return Array.from(uniq.values());
  });

  await browser.close();

  const cleaned = items
    .map((i) => ({
      url: normalize(i.url),
      title: i.title ? i.title.slice(0, 160) : null,
      image: normalize(i.image)
    }))
    .filter((i) => i.url);

  // vezmeme vršek stránky (nejnovější)
  const top = cleaned.slice(0, 30);

  // nové = co ještě nebylo viděno
  const fresh = top.filter((i) => !seen.has(i.url)).slice(0, MAX_POST);

  if (fresh.length === 0) {
    console.log("No new items.");
    return;
  }

  console.log("Posting:", fresh.map((x) => x.url));
  await sendToDiscord(webhook, fresh);

  // uložíme jako “seen”
  const newSeen = [...fresh.map((x) => x.url), ...seenList];
  const dedup = Array.from(new Set(newSeen)).slice(0, 500);
  saveState(dedup);
})();
