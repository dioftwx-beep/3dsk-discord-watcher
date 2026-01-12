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
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

  await page.goto(URL, { waitUntil: "domcontentloaded" });

  // Dáme gridu čas a "probudíme" lazy-load jen MALÝM scroll (ne celá stránka)
  await page.waitForTimeout(2000);
  await page.mouse.wheel(0, 900);
  await page.waitForTimeout(1200);
  await page.mouse.wheel(0, 900);
  await page.waitForTimeout(1200);

  // DEBUG: DOM základ
  const domStats = await page.evaluate(() => {
    const imgs = document.querySelectorAll("img").length;
    const links = document.querySelectorAll("a[href]").length;
    return { imgs, links, title: document.title };
  });
  console.log("DEBUG: page title =", domStats.title);
  console.log("DEBUG: DOM counts =", domStats);

  // Extraction: bereme "karty" tak, že hledáme prvky s velkým pozadím nebo velkým img
  const items = await page.evaluate(() => {
    const uniq = new Map();

    function pickBgImage(el) {
      const cs = window.getComputedStyle(el);
      const bg = cs.backgroundImage || "";
      // url("...") nebo url(...)
      const m = bg.match(/url\(["']?(.*?)["']?\)/i);
      return m ? m[1] : null;
    }

    function isBig(r) {
      return r && r.width >= 140 && r.height >= 140;
    }

    // Kandidáti 1: velké IMG
    const imgCandidates = Array.from(document.querySelectorAll("img"))
      .map(img => ({ el: img, r: img.getBoundingClientRect() }))
      .filter(x => isBig(x.r))
      .map(x => x.el);

    // Kandidáti 2: velké DIVy se background-image (grid často takhle)
    const bgCandidates = Array.from(document.querySelectorAll("div, a, span"))
      .map(el => ({ el, r: el.getBoundingClientRect() }))
      .filter(x => isBig(x.r))
      .filter(x => {
        const cs = window.getComputedStyle(x.el);
        return cs && cs.backgroundImage && cs.backgroundImage.includes("url(");
      })
      .map(x => x.el);

    const candidates = [...new Set([...imgCandidates, ...bgCandidates])];

    for (const el of candidates) {
      // najdi nejbližší link
      const a = el.closest("a[href]");
      if (!a) continue;

      const href = a.getAttribute("href") || "";

      // filtr: jen detail setu (ne search/kategorie)
      const isSetDetail =
        href.includes("/photo_sets/show/") ||
        href.includes("/photo_sets/show/id/") ||
        /\/photo_sets\/\d+/.test(href);

      if (!isSetDetail) continue;

      // title: title attribute nebo text z okolí
      const title =
        (a.getAttribute("title") || "").trim() ||
        (a.innerText || "").replace(/\s+/g, " ").trim() ||
        null;

      // image: z img src nebo z background-image
      let image = null;
      if (el.tagName && el.tagName.toLowerCase() === "img") {
        image =
          el.getAttribute("src") ||
          el.getAttribute("data-src") ||
          el.getAttribute("data-lazy") ||
          el.getAttribute("data-original") ||
          null;
      } else {
        image = pickBgImage(el);
      }

      if (!uniq.has(href)) {
        uniq.set(href, { url: href, title, image });
      }
    }

    return Array.from(uniq.values());
  });

  await browser.close();

  console.log("DEBUG: raw items found =", items.length);
  console.log("DEBUG: sample raw (first 10) =", items.slice(0, 10));

  const cleaned = items
    .map((i) => ({
      url: normalize(i.url),
      title: i.title ? i.title.replace(/\s+/g, " ").trim().slice(0, 160) : null,
      image: normalize(i.image)
    }))
    .filter((i) => i.url);

  const top = cleaned.slice(0, 60);

  console.log("DEBUG: cleaned =", cleaned.length);
  console.log("DEBUG: top URLs (first 10) =", top.slice(0, 10).map((x) => x.url));
  console.log("DEBUG: seen size =", seen.size);

  const fresh = top.filter((i) => !seen.has(i.url)).slice(0, MAX_POST);
  console.log("DEBUG: fresh count =", fresh.length);

  if (fresh.length === 0) {
    console.log("No new items.");
    return;
  }

  console.log("Posting:", fresh.map((x) => x.url));
  await sendToDiscord(webhook, fresh);

  const newSeen = [...fresh.map((x) => x.url), ...seenList];
  const dedup = Array.from(new Set(newSeen)).slice(0, 1000);
  saveState(dedup);
})();
