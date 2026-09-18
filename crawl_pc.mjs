import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";

const [campaign = "103592", from = "2026-08-31", to = "2026-09-07"] =
  process.argv.slice(2);

const validDate = value =>
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString().slice(0, 10) === value;

if (!/^\d+$/.test(campaign) ||
    !validDate(from) || !validDate(to) || from > to) {
  throw new Error("Cú pháp: node crawl.mjs CAMPAIGN YYYY-MM-DD YYYY-MM-DD");
}

const setup = process.env.SETUP === "1";
const sessionDir = fileURLToPath(
  new URL(".admicro-session/", import.meta.url)
);
const outputDir = fileURLToPath(new URL("output/", import.meta.url));
const outputFile = fileURLToPath(
  new URL("output/ADX_pc_overall.csv", import.meta.url)
);

const url = new URL(
  `https://adx.admicro.vn/vn/campaign/detail/${campaign}`
);
url.searchParams.set("fd", from);
url.searchParams.set("td", to);

let context;
let stage = "khởi động";

function progress(message) {
  stage = message;
  console.log(`[${new Date().toLocaleTimeString("vi-VN")}] ${message}`);
}

const heartbeat = setInterval(() => {
  console.log(`Đang chờ: ${stage}...`);
}, 10000);
heartbeat.unref();

try {
  progress("Khởi động Chrome");

  context = await chromium.launchPersistentContext(sessionDir, {
    channel: "chrome",
    headless: !(setup || process.env.HEADLESS === "0"),
    viewport: { width: 1600, height: 1000 },
    timeout: 30000
  });

  context.setDefaultNavigationTimeout(60000);
  const page = context.pages()[0] || await context.newPage();

  progress(`Mở báo cáo PC ${campaign}: ${from} → ${to}`);
  await page.goto(url.href, { waitUntil: "domcontentloaded" });
  await page.bringToFront();

  if (setup) {
    progress("Chờ bạn đăng nhập");

    const terminal = createInterface({
      input: process.stdin,
      output: process.stdout
    });

    try {
      await terminal.question(
        "Đăng nhập trong Chrome, rồi quay lại Terminal nhấn Enter..."
      );
    } finally {
      terminal.close();
    }

    await page.goto(url.href, { waitUntil: "domcontentloaded" });
    await page.bringToFront();
  }

  progress("Đợi bảng, số liệu và dòng Tổng tải xong — tối đa 120 giây");

  const handle = await page.waitForFunction(() => {
    const loginRoute =
      /\/(login|signin|sign-in)(\/|$)/i.test(location.pathname) ||
      (
        location.hostname === "sso.admicro.vn" &&
        /^\/authenticate\/sign\/?$/.test(location.pathname)
      );

    if (loginRoute) return "login";

    const table = document.querySelector("#tabledata");
    if (!table || !table.getClientRects().length) return false;
    if (!table.querySelector("tbody tr")) return false;

    // Trang PC gửi số liệu qua Socket.IO.
    const flags = window.rmtData;
    if (!flags) return false;

    const complete = ["rpt", "total", "uv", "cpa"].every(
      key => flags[key] !== undefined &&
             flags[key] !== null &&
             String(flags[key]) !== ""
    );

    if (!complete) return false;

    if (String(flags.rpt) !== "1" || String(flags.total) !== "1") {
      return "report-error";
    }

    const totalClick =
      document.querySelector("#totalclick")?.textContent.trim();
    const totalView =
      document.querySelector("#totalview")?.textContent.trim();

    return totalClick && totalView ? "ready" : false;
  }, null, { timeout: 120000 }).catch(async error => {
    if (error.name !== "TimeoutError") throw error;

    const current = new URL(page.url());
    console.error(`Trang hiện tại: ${current.origin}${current.pathname}`);

    throw new Error(
      "Chưa nhận đủ dữ liệu sau 120 giây. " +
      `Chạy HEADLESS=0 node crawl.mjs ${campaign} ${from} ${to} ` +
      "để xem trang thực tế."
    );
  });

  const state = await handle.jsonValue();
  await handle.dispose();

  if (state === "login") {
    throw new Error(
      `Cần đăng nhập: SETUP=1 node crawl.mjs ${campaign} ${from} ${to}`
    );
  }

  if (state === "report-error") {
    throw new Error(
      "Admicro chưa trả được báo cáo hoặc dòng Tổng hợp lệ. Không xuất file rỗng."
    );
  }

  // Đợi các timer trên trang cập nhật xong, tránh lấy số liệu quá sớm.
  progress("Đợi bảng ổn định");

  let previous = "";
  let stable = 0;

  for (let i = 0; i < 30 && stable < 3; i++) {
    await page.waitForTimeout(1000);
    const current = await page.locator("#tabledata").innerText();
    stable = current === previous ? stable + 1 : 0;
    previous = current;
  }

  if (stable < 3) {
    throw new Error("Bảng vẫn đang thay đổi. Hãy chạy lại.");
  }

  progress("Đọc bảng và link ảnh Preview");

  const result = await page.evaluate(() => {
    const clean = value => (value || "").replace(/\s+/g, " ").trim();
    const table = document.querySelector("#tabledata");

    if (!table) throw new Error("Không tìm thấy bảng #tabledata.");

    const visibleRows = [...table.rows].filter(
      row => row.getClientRects().length > 0
    );

    const grid = [];

    visibleRows.forEach((row, r) => {
      grid[r] ??= [];
      let col = 0;

      for (const cell of row.cells) {
        while (grid[r][col] !== undefined) col++;

        let value = clean(cell.innerText);

        // Chỉ lấy ảnh trong Preview để không thay số liệu bằng icon.
        if (cell.matches(".col-preview") && cell.colSpan === 1) {
          const images = [...cell.querySelectorAll("img")]
            .map(img => {
              const src =
                img.getAttribute("data-original") ||
                img.getAttribute("data-src") ||
                img.currentSrc ||
                img.getAttribute("src");

              if (!src) return "";

              try {
                return new URL(src, document.baseURI).href;
              } catch {
                return "";
              }
            })
            .filter(Boolean);

          if (images.length) {
            value = [...new Set(images)].join(" | ");
          }
        }

        if (cell.matches(".col-status") && !value) {
          value = [...cell.querySelectorAll("[title], img[alt]")]
            .map(el => el.getAttribute("title") || el.getAttribute("alt"))
            .filter(Boolean)
            .join(" | ");
        }

        // Mở rộng ô gộp để dòng Tổng khớp các cột.
        const height = cell.rowSpan === 0
          ? visibleRows.length - r
          : cell.rowSpan;

        for (let dr = 0; dr < height; dr++) {
          grid[r + dr] ??= [];

          for (let dc = 0; dc < cell.colSpan; dc++) {
            grid[r + dr][col + dc] =
              dr === 0 && dc === 0 ? value : "";
          }
        }

        col += cell.colSpan;
      }
    });

    const width = Math.max(...grid.map(row => row.length));

const detailLinks = visibleRows.map(row => {
  if (row.closest("thead")) return "Link chi tiết";
  if (row.closest("tfoot")) return "";

  const anchor = [...row.querySelectorAll("a[href]")].find(a => {
    try {
      const link = new URL(a.getAttribute("href"), document.baseURI);
      return link.pathname === "/vn/banner/detail" &&
             link.searchParams.has("bannerid");
    } catch {
      return false;
    }
  });

  if (!anchor) return "";

  const link = new URL(anchor.getAttribute("href"), document.baseURI);

  // Dùng đúng khoảng ngày của báo cáo đang mở.
  const current = new URL(location.href);
  for (const key of ["fd", "td"]) {
    const value = current.searchParams.get(key);
    if (value) link.searchParams.set(key, value);
  }

  return link.href;
});

return {
  rows: grid.map((row, index) => [
    ...Array.from({ length: width }, (_, i) => row[i] ?? ""),
    detailLinks[index] ?? ""
  ]),
      count: [...table.querySelectorAll("tbody tr")].filter(
        row => row.getClientRects().length > 0
      ).length
    };
  });

  const csv = "\uFEFF" + result.rows.map(row =>
    row.map(value => {
      const safe = /^[=+@-]/.test(value) ? "'" + value : value;
      return `"${safe.replace(/"/g, '""')}"`;
    }).join(",")
  ).join("\r\n");

  await mkdir(outputDir, { recursive: true });
  await writeFile(outputFile, csv, "utf8");

  console.log(`Đã lấy ${result.count} dòng trong bảng hiện tại.`);
  console.log(`Đã lưu: ${outputFile}`);
} catch (error) {
  console.error(`Lỗi tại bước: ${stage}`);
  console.error(error.message);
  process.exitCode = 1;
} finally {
  clearInterval(heartbeat);

  if (context) {
    console.log("Đóng Chrome...");
    const deadline = setTimeout(() => {
      console.error("Chrome không đóng sau 10 giây; kết thúc crawler.");
      process.exit(1);
    }, 10000);

    try {
      await context.close();
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    } finally {
      clearTimeout(deadline);
    }
  }
}