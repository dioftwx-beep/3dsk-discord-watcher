import fs from "fs";
import { chromium } from "playwright";

const URL =
  "https://www.3d.sk/photo_sets/search/premium/1/standard/1/thumb/small/orderBy/chronology/fresh/";

const STATE_FILE = "state.json";
const MAX_POST = 5;

// jen aby se nic nerozbilo na //cdn... apod.
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
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

  await page.goto(URL, { waitUntil: "domcontentloaded" });

  // Počkáme, až se načtou thumbnails (JS + lazy load)
  // Cíl: na stránce musí být několik "velkých" img (grid)
  await page.waitForFunction(() => {
    const imgs = Array.from(document.querySelectorAll("img"));
    let big = 0;
    for (const img of imgs) {
      const r = img.getBoundingClientRect();
      if (r.width >= 120 && r.height >= 120) big++;
      if (big >= 8) return true; // když vidíme aspoň 8 velkých thumbů, grid je ready
    }
    return false;
  }, { timeout: 25000 }).catch(() => {});

  // Vytáhneme jen grid karty: velké thumbnails + jejich nejbližší <a>
  const items = await page.evaluate(() => {
    const uniq = new Map();

    const imgs = Array.from(document.querySelectorAll("img"))
      .map((img) => ({ img, r: img.getBoundingClientRect() }))
      .filter((x) => x.r.width >= 120 && x.r.height >= 120)
      .map((x) => x.img);

    for (const img of imgs) {
      const a = img.closest("a[href]");
      if (!a) continue;

      const href = a.getAttribute("href") || "";

      // chceme jen detail setu (ne search/kategorie)
      const isSetDetail =
        href.includes("/photo_sets/show/") ||
        href.includes("/photo_sets/show/id/") ||
        /\/photo_sets\/\d+/.test(href);

      if (!isSetDetail) continue;

      const title =
        (a.getAttribute("title") || "").trim() ||
        (img.getAttribute("alt") || "").trim() ||
        null;

      const image =
        img.getAttribute("src") ||
        img.getAttribute("data-src") ||
        img.getAttribute("data-lazy") ||
        img.getAttribute("data-original") ||
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
      title: i.title ? i.title.replace(/\s+/g, " ").trim().slice(0, 160) : null,
      image: normalize(i.image)
    }))
    .filter((i) => i.url);

  // Nejnovější bývají nahoře – vezmeme horní kus
  const top = cleaned.slice(0, 40);

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
  const dedup = Array.from(new Set(newSeen)).slice(0, 1000);
  saveState(dedup);
})();
