import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

const [campaign = "49891", from = "2026-08-31", to = "2026-09-07"] =
  process.argv.slice(2);

if (!/^\d+$/.test(campaign) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(from) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
  throw new Error("Cú pháp: node crawl.mjs CAMPAIGN YYYY-MM-DD YYYY-MM-DD");
}

const setup = process.env.SETUP === "1";
const sessionDir = fileURLToPath(new URL(".admicro-session/", import.meta.url));
const url = new URL(
  `https://adx.admicro.vn/mobile/vn/campaign/detail/${campaign}`
);
url.searchParams.set("fd", from);
url.searchParams.set("td", to);

let context;
let stage = "khởi động Chrome";
const progress = message => {
  stage = message;
  console.log(`[${new Date().toLocaleTimeString("vi-VN")}] ${message}`);
};
const heartbeat = setInterval(() => {
  console.log(`Đang chờ: ${stage}...`);
}, 10000);
heartbeat.unref();

try {
  progress("Khởi động Chrome (tối đa 30 giây)");
  console.log(`Phiên Chrome của crawler: ${sessionDir}`);
  context = await chromium.launchPersistentContext(
    sessionDir,
    { channel: "chrome", headless: !(setup || process.env.HEADLESS === "0"), timeout: 30000 }
  );
  context.setDefaultTimeout(30000);
  context.setDefaultNavigationTimeout(30000);
  const page = await context.newPage();
  progress(`Tải báo cáo ${campaign}: ${from} → ${to} (tối đa 30 giây)`);
  await page.goto(url.href, { waitUntil: "domcontentloaded" });

  if (setup) {
    progress("Chờ bạn đăng nhập và nhấn Enter trong Terminal");
    const terminal = createInterface({
      input: process.stdin,
      output: process.stdout
    });
    try {
      await terminal.question(
        "Đăng nhập trong trình duyệt, sau đó quay lại Terminal nhấn Enter..."
      );
    } finally {
      terminal.close();
    }

    progress("Tải lại báo cáo sau đăng nhập (tối đa 30 giây)");
    await page.goto(url.href, { waitUntil: "domcontentloaded" });
  }

  // Chỉ xuất khi bảng có ít nhất một dòng quảng cáo với Click dạng số.
  progress("Chờ bảng báo cáo có dữ liệu (tối đa 60 giây)");
  const ready = await page.waitForFunction(() => {
    if (location.hostname === "sso.admicro.vn" &&
        /^\/authenticate\/sign\/?$/.test(location.pathname)) {
      return "login";
    }
    const clean = s => s.replace(/\s+/g, " ").trim();

    return [...document.querySelectorAll("table")].some(table => {
      if (table.getClientRects().length === 0) return false;
      const rows = [...table.rows];
      const header = rows.find(row => {
        const labels = [...row.cells].map(c => clean(c.innerText));
        return labels.includes("Quảng cáo") &&
               labels.includes("Lượt hiển thị");
      });

      if (!header) return false;

      const labels = [...header.cells].map(c => clean(c.innerText));
      const adIndex = labels.indexOf("Quảng cáo");
      const clickIndex = labels.indexOf("Click");

      return clickIndex >= 0 && rows.some(row =>
        row.getClientRects().length > 0 &&
        row.cells.length === header.cells.length &&
        clean(row.cells[adIndex]?.innerText || "") !== "" &&
        /^[\d,.]+$/.test(clean(row.cells[clickIndex]?.innerText || ""))
      );
    });
  }, null, { timeout: 60000 }).catch(async error => {
    if (error.name !== "TimeoutError") throw error;
    const info = await page.evaluate(() => ({
      location: location.origin + location.pathname,
      title: document.title,
      loginRoute: /\/(login|signin|sign-in)(\/|$)/i.test(location.pathname) ||
        (location.hostname === "sso.admicro.vn" &&
         /^\/authenticate\/sign\/?$/.test(location.pathname)),
      passwordVisible: [...document.querySelectorAll('input[type="password"]')].some(input => {
        const style = getComputedStyle(input);
        return input.getClientRects().length > 0 &&
          style.visibility !== "hidden" && style.display !== "none";
      })
    }));
    console.error(`Trang hiện tại: ${info.location} (${info.title})`);
    if (info.loginRoute) {
      throw new Error(
        `Crawler đang ở trang đăng nhập trong phiên riêng. Chạy: SETUP=1 node crawl.mjs ${campaign} ${from} ${to}`
      );
    }
    throw new Error(
      "Chưa thấy bảng có dữ liệu sau 60 giây." +
      (info.passwordVisible ? " Trang có ô mật khẩu, nhưng chưa đủ căn cứ kết luận hết phiên." : "") +
      ` Xem trang thực tế bằng: HEADLESS=0 node crawl.mjs ${campaign} ${from} ${to}`
    );
  });
  const state = await ready.jsonValue();
  await ready.dispose();
  if (state === "login") {
    throw new Error(
      "Crawler bị chuyển tới trang đăng nhập SSO: sso.admicro.vn/authenticate/sign. " +
      `Chạy: SETUP=1 node crawl.mjs ${campaign} ${from} ${to}. ` +
      "Đăng nhập trong cửa sổ Chrome vừa mở, chờ tới trang báo cáo rồi nhấn Enter trong Terminal."
    );
  }

  progress("Đọc bảng và xuất CSV");
  const rows = await page.evaluate(() => {
    const clean = s => s.replace(/\s+/g, " ").trim();

    const table = [...document.querySelectorAll("table")].find(t => {
      const text = clean(t.innerText);
      return t.getClientRects().length > 0 &&
             text.includes("Quảng cáo") &&
             text.includes("Lượt hiển thị") &&
             [...t.rows].some(r =>
               [...r.cells].some(c =>
                 /^[\d,.]+$/.test(clean(c.innerText))
               )
             );
    });

    if (!table) throw new Error("Không tìm thấy bảng báo cáo.");

    // Mở rộng ô gộp để hàng Tổng không bị lệch cột.
    const grid = [];
    const visibleRows = [...table.rows].filter(
      row => row.getClientRects().length > 0
    );

    visibleRows.forEach((row, r) => {
      grid[r] ??= [];
      let col = 0;

      for (const cell of row.cells) {
        while (grid[r][col] !== undefined) col++;

        const height = cell.rowSpan === 0
          ? visibleRows.length - r
          : cell.rowSpan;

        for (let dr = 0; dr < height; dr++) {
          grid[r + dr] ??= [];
          for (let dc = 0; dc < cell.colSpan; dc++) {
            grid[r + dr][col + dc] =
              dr === 0 && dc === 0
                ? (
                    [...cell.querySelectorAll("img")]
                        .map(img => {
                        const src =
                            img.currentSrc ||
                            img.getAttribute("data-src") ||
                            img.getAttribute("src");

                        return src ? new URL(src, document.baseURI).href : "";
                        })
                        .filter(Boolean)
                        .join(" | ") || clean(cell.innerText)
                    )
                : "";
          }
        }
        col += cell.colSpan;
      }
    });

    const width = Math.max(...grid.map(row => row.length));

    return grid.map(row =>
      Array.from({ length: width }, (_, i) => row[i] ?? "")
    );
  });

  const csv = "\uFEFF" + rows.map(row =>
    row.map(value => `"${value.replace(/"/g, '""')}"`).join(",")
  ).join("\r\n");

  await mkdir("output", { recursive: true });
  const file = `output/ADX_mobile_overall.csv`;
  await writeFile(file, csv, "utf8");

  console.log(`Đã lưu: ${resolve(file)}`);
} catch (error) {
  console.error(`Lỗi tại bước: ${stage}`);
  console.error(
    "Không xuất được báo cáo. Kiểm tra phiên đăng nhập, khoảng ngày " +
    "và cấu trúc bảng. Nếu phiên hết hạn, chạy lại với SETUP=1."
  );
  console.error(error.message);
  process.exitCode = 1;
} finally {
  clearInterval(heartbeat);
  if (context) {
    progress("Đóng Chrome");
    const closeDeadline = setTimeout(() => {
      console.error("Chrome không đóng sau 10 giây; kết thúc crawler.");
      process.exit(1);
    }, 10000);
    try {
      await context.close();
    } catch (error) {
      console.error(`Không đóng được Chrome: ${error.message}`);
      process.exitCode = 1;
    } finally {
      clearTimeout(closeDeadline);
    }
  }
}
