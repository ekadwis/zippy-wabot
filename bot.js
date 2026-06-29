/**
 * ZIPPY STORE - WhatsApp Notif Bot
 * --------------------------------
 * Bot ini login pakai NOMOR BISNIS (scan QR).
 * Fungsinya: pantau grup-grup tertentu, kalau ada keyword (mis. "wtb netflix")
 * dia kirim notif ke grup "Notif BOT". Semua perintah dijalankan dari NOMOR PRIBADI
 * di dalam grup "Notif BOT".
 */

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
} = require("@whiskeysockets/baileys");
const qrcode = require("qrcode-terminal");
const pino = require("pino");
const fs = require("fs");
const path = require("path");

// Anti-crash: jangan biarkan error kecil matiin bot
process.on("uncaughtException", (e) => console.log("⚠️ uncaughtException:", e.message));
process.on("unhandledRejection", (e) => console.log("⚠️ unhandledRejection:", e?.message || e));

// ---------- File paths ----------
const SETTINGS_PATH = path.join(__dirname, "settings.json");
const DATA_PATH = path.join(__dirname, "data.json");
const AUTH_DIR = path.join(__dirname, "auth");

// ---------- Load settings & data ----------
const settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8"));

let data = {
  hubJid: null, // JID grup "Notif BOT"
  ownerJid: null, // JID asli owner (di-bind saat .sethere), tahan format @lid
  scanMode: true, // lapor grup baru yang belum dipantau
  seen: {}, // grup yang sudah pernah dilaporkan (biar gak spam)
  monitored: {}, // { groupJid: { prefix, name, counter } }
  pending: {}, // { kode: { jid, name, number, message, time } }
  // ---- broadcast ----
  bcNumbers: [], // daftar nomor tujuan (sekali pakai)
  bcText: "", // isi pesan / caption
  bcImage: null, // path lokal atau URL gambar
  bcDelayMin: 40, // jeda min antar pesan (detik)
  bcDelayMax: 100, // jeda max antar pesan (detik)
  schedules: [], // jadwal broadcast: [{id, runAt, numbers, text, image, delayMin, delayMax}]
  scheduleSeq: 0, // counter id jadwal
  stats: { log: [], daily: {} }, // log notif + agregat harian
};

// state broadcast (tidak disimpan)
let bcRunning = false;
let bcStop = false;
let sockRef = null; // referensi socket aktif untuk scheduler
let schedulerStarted = false;
if (fs.existsSync(DATA_PATH)) {
  try {
    data = { ...data, ...JSON.parse(fs.readFileSync(DATA_PATH, "utf8")) };
  } catch (e) {
    console.log("data.json rusak, pakai default.");
  }
}
function saveData() {
  fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2));
}

// ---------- Helpers ----------
// ambil hanya angka dari JID, biar gampang dibandingkan
function digits(jid) {
  return (jid || "").split("@")[0].split(":")[0].replace(/\D/g, "");
}
function isOwner(jid) {
  if (!jid) return false;
  if (data.ownerJid && jid === data.ownerJid) return true;
  return digits(jid) === digits(settings.ownerNumber);
}
function getText(msg) {
  const m = msg.message;
  if (!m) return "";
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    ""
  );
}
// Cocokkan keyword sebagai kata utuh.
// - Keyword 1 kata (mis. "cv")  -> kata itu harus muncul utuh.
// - Keyword multi-kata (mis. "surat sakit") -> SEMUA katanya harus ada di pesan,
//   tapi TIDAK harus berurutan/nempel. "butuh surat untuk sakit" -> cocok.
function wordPresent(lower, word) {
  const esc = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${esc}([^a-z0-9]|$)`, "i").test(lower);
}
function matchKeyword(text) {
  const lower = text.toLowerCase();
  for (const k of settings.keywords) {
    const words = k.toLowerCase().trim().split(/\s+/).filter(Boolean);
    if (!words.length) continue;
    if (words.every((w) => wordPresent(lower, w))) return k;
  }
  return null;
}
function fmtTime(d = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// normalisasi nomor -> 62xxxx
function normNum(s) {
  let d = (s || "").replace(/\D/g, "");
  if (!d) return null;
  if (d.startsWith("0")) d = "62" + d.slice(1);
  else if (d.startsWith("8")) d = "62" + d;
  if (d.length < 9 || d.length > 15) return null;
  return d;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

// spin text: "{halo|hai|hi} kak" -> pilih acak tiap kirim
function spin(t) {
  return (t || "").replace(/\{([^{}]*)\}/g, (m, g) => {
    const opts = g.split("|");
    return opts[randInt(0, opts.length - 1)];
  });
}

// kunci tanggal lokal "YYYY-MM-DD"
function dateKey(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
// awal hari kemarin (epoch ms) -> batas simpan: hari ini + kemarin
function cutoffYesterday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime() - 86400000;
}
// auto-hapus data lama (pending & log mentah) di luar hari ini+kemarin
function pruneOld() {
  const cutoff = cutoffYesterday();
  let changed = false;
  for (const [code, n] of Object.entries(data.pending)) {
    if (n.ts && n.ts < cutoff) {
      delete data.pending[code];
      changed = true;
    }
  }
  if (data.stats?.log?.length) {
    const before = data.stats.log.length;
    data.stats.log = data.stats.log.filter((e) => e.ts >= cutoff);
    if (data.stats.log.length !== before) changed = true;
  }
  if (changed) {
    saveData();
    console.log(`[PRUNE] data lama dibersihkan. Pending: ${Object.keys(data.pending).length}`);
  }
}

// ---------- Main ----------
async function start() {
  const { state, saveCreds } = await useMultiFileAuthState(sesi_baru);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: "silent" }),
    printQRInTerminal: false,
  });

  sock.ev.on("creds.update", saveCreds);
  sockRef = sock;

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      console.log("\n=== SCAN QR INI PAKAI WA BISNIS ===\n");
      qrcode.generate(qr, { small: true });
    }
    if (connection === "open") {
      console.log("\n✅ BOT TERHUBUNG! Siap memantau.\n");
      sockRef = sock;
      if (!schedulerStarted) {
        schedulerStarted = true;
        startScheduler();
        pruneOld(); // bersihkan data lama saat start
        setInterval(pruneOld, 3600000); // tiap 1 jam
        console.log("⏰ Scheduler jadwal broadcast aktif.\n");
      }
      if (!data.hubJid) {
        console.log("👉 Buka grup 'Notif BOT', lalu kirim  .sethere  dari nomor pribadi.\n");
      }
    }
    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      const reconnect = code !== DisconnectReason.loggedOut;
      console.log("Koneksi putus. Reconnect:", reconnect);
      if (reconnect) start();
      else console.log("Logout. Hapus folder 'auth' lalu jalankan ulang untuk scan QR baru.");
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
    for (const msg of messages) {
      try {
        await handleMessage(sock, msg);
      } catch (e) {
        console.log("Error handle pesan:", e.message);
      }
    }
  });
}

// ---------- Pesan masuk ----------
async function handleMessage(sock, msg) {
  if (msg.key.fromMe) return; // abaikan pesan dari bot sendiri
  const jid = msg.key.remoteJid;
  if (!jid) return;
  const isGroup = jid.endsWith("@g.us");
  if (!isGroup) return; // cuma proses grup
  const text = getText(msg).trim();
  if (!text) return;
  const sender = msg.key.participant || msg.participant || "";

  // LOG biar kelihatan di terminal (buat debug)
  const tag = jid === data.hubJid ? "HUB" : data.monitored[jid] ? "DIPANTAU" : "lain";
  console.log(`[MSG][${tag}] grup=${jid} from=${sender} | "${text}"`);

  // ===== COMMAND dari owner =====
  // .sethere boleh dari grup mana saja (buat set hub pertama kali)
  // Di grup berdua (bot+owner), pengirim non-bot pasti owner -> sekalian bind ownerJid
  if (text.toLowerCase() === ".sethere") {
    const allowed = isOwner(sender) || !data.ownerJid;
    if (allowed) {
      data.hubJid = jid;
      data.ownerJid = sender; // simpan JID asli (tahan @lid)
      saveData();
      console.log(`[SETUP] hub=${jid} owner=${sender}`);
      await sock.sendMessage(jid, {
        text: "✅ Grup ini di-set sebagai *Notif BOT*. Semua notif & perintah lewat sini.\nKetik *.help* untuk daftar perintah.",
      });
      return;
    }
  }

  // simpan gambar broadcast: kirim FOTO dengan caption .setgambar di hub
  if (jid === data.hubJid && isOwner(sender) && msg.message?.imageMessage) {
    const cap = (msg.message.imageMessage.caption || "").trim().toLowerCase();
    if (cap === ".setgambar") {
      try {
        const buf = await downloadMediaMessage(
          msg,
          "buffer",
          {},
          { logger: pino({ level: "silent" }), reuploadRequest: sock.updateMediaMessage }
        );
        const imgPath = path.join(__dirname, "promo.jpg");
        fs.writeFileSync(imgPath, buf);
        data.bcImage = imgPath;
        saveData();
        await sock.sendMessage(jid, { text: "✅ Gambar broadcast disimpan. Cek dengan *.lihatpesan*" });
      } catch (e) {
        await sock.sendMessage(jid, { text: "❌ Gagal simpan gambar: " + e.message });
      }
      return;
    }
    if (cap === ".sticker" || cap === ".stiker") {
      try {
        const buf = await downloadMediaMessage(
          msg,
          "buffer",
          {},
          { logger: pino({ level: "silent" }), reuploadRequest: sock.updateMediaMessage }
        );
        let sharp;
        try {
          sharp = require("sharp");
        } catch (e) {
          await sock.sendMessage(jid, { text: "❌ Modul 'sharp' belum terinstall. Jalankan: npm install sharp" });
          return;
        }
        const webp = await sharp(buf)
          .resize(512, 512, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
          .webp({ quality: 90 })
          .toBuffer();
        await sock.sendMessage(jid, { sticker: webp });
      } catch (e) {
        await sock.sendMessage(jid, { text: "❌ Gagal bikin sticker: " + e.message });
      }
      return;
    }
  }

  // command lain hanya diproses kalau di hub group & dari owner
  if (jid === data.hubJid && isOwner(sender) && text.startsWith(".")) {
    await handleCommand(sock, jid, text);
    return;
  }

  // ===== DETEKSI KEYWORD di grup yang dipantau =====
  if (data.monitored[jid] && jid !== data.hubJid) {
    const hit = matchKeyword(text);
    console.log(`[CHECK] match=${hit || "(tidak ada)"}`);
    if (hit) {
      await fireNotif(sock, jid, sender, text, hit, msg);
    }
  }

  // ===== AUTO-DETECT grup baru (belum dipantau) =====
  if (jid !== data.hubJid && !data.monitored[jid] && data.scanMode !== false && data.hubJid) {
    if (!data.seen) data.seen = {};
    if (!data.seen[jid]) {
      data.seen[jid] = true;
      saveData();
      let name = jid;
      try {
        const md = await sock.groupMetadata(jid);
        name = md.subject || jid;
      } catch (e) {}
      await sock.sendMessage(data.hubJid, {
        text:
          `🆕 *Grup baru terdeteksi* (belum dipantau)\n` +
          `📛 ${name}\n` +
          `🆔 ${jid}\n\n` +
          `Untuk mulai pantau, copy & edit <prefix>:\n` +
          `.addjid ${jid} <prefix> ${name}`,
      });
    }
  }
}

// ---------- Buat & kirim notif ----------
async function fireNotif(sock, jid, sender, text, hit, srcMsg) {
  if (!data.hubJid) {
    console.log("⚠️ Keyword kedeteksi tapi hub belum di-set (.sethere).");
    return;
  }
  const grp = data.monitored[jid];
  const num = String(grp.counter).padStart(4, "0");
  const code = `${grp.prefix}${num}`;
  grp.counter++;

  const senderNum = digits(sender);
  const notif = {
    jid,
    groupName: grp.name,
    number: senderNum,
    senderJid: sender, // JID asli (buat .reply, tahan @lid)
    quoted: srcMsg ? { key: srcMsg.key, message: srcMsg.message } : null, // buat reply quote di grup
    message: text,
    time: fmtTime(),
    ts: Date.now(),
    keyword: hit,
  };
  data.pending[code] = notif;
  // catat statistik
  if (!data.stats) data.stats = { log: [], daily: {} };
  if (!data.stats.daily) data.stats.daily = {};
  data.stats.log.push({ ts: Date.now(), prefix: grp.prefix, name: grp.name, keyword: hit });
  if (data.stats.log.length > 3000) data.stats.log = data.stats.log.slice(-3000);
  // agregat harian (tetap tersimpan walau log mentah dihapus)
  const dk = dateKey(new Date());
  const d = (data.stats.daily[dk] ||= { total: 0, kw: {}, grp: {} });
  d.total++;
  d.kw[hit] = (d.kw[hit] || 0) + 1;
  d.grp[grp.name] = (d.grp[grp.name] || 0) + 1;
  saveData();

  const out =
    `🔔 *${grp.name}* — kode .${grp.prefix}\n\n` +
    `• *${code}*  ${notif.time}\n` +
    `  📱 +${senderNum}\n` +
    `  🔑 match: "${hit}"\n` +
    `  💬 ${text}\n\n` +
    `_balas: ketik_  *${code} done*  _kalau sudah direspon_`;

  await sock.sendMessage(data.hubJid, { text: out });
}

// ---------- Handle command dari owner ----------
async function handleCommand(sock, hubJid, text) {
  const parts = text.trim().split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const reply = (t) => sock.sendMessage(hubJid, { text: t });

  // .kode done  ->  tandai selesai
  if (parts.length === 2 && parts[1].toLowerCase() === "done") {
    const code = parts[0].replace(/^\./, "").toLowerCase();
    if (data.pending[code]) {
      delete data.pending[code];
      saveData();
      await reply(`✅ ${code} ditandai *selesai*.`);
    } else {
      await reply(`❓ Kode *${code}* gak ketemu (mungkin sudah selesai).`);
    }
    return;
  }

  switch (cmd) {
    case ".help":
      await reply(
        "📋 *PERINTAH ZIPPY BOT*\n\n" +
          "━━━ *NOTIF GRUP (internal)* ━━━\n" +
          "*.groups* — list grup + JID\n" +
          "*.addjid <jid> <prefix> <nama>* — pantau grup\n" +
          "*.add <index> <prefix> <nama>* — pantau via index\n" +
          "*.del <prefix>* — berhenti pantau\n" +
          "*.resetgrup yakin* — hapus SEMUA pantauan\n" +
          "*.monitored* — list grup dipantau\n" +
          "*.list* — notif belum direspon\n" +
          "*<kode> done* — tandai selesai (mis: thr0001 done)\n" +
          "*.reply <kode> <isi>* — balas langsung ke pengirim (via owner)\n" +
          "*.donesemua* — tandai SEMUA notif selesai\n" +
          "*.stats [hari]* — statistik notif (default 7)\n" +
          "*.scan on/off/reset* — deteksi grup baru\n" +
          "*.kw* / *.kw add <kata>* / *.kw del <kata>* — keyword\n" +
          "*.ping* — cek bot hidup\n" +
          "*.sethere* — set hub notif\n\n" +
          "━━━ *BROADCAST WA (promosi)* ━━━\n" +
          "*.addnomor 628.., 628..* — tambah nomor tujuan\n" +
          "*.listnomor* — lihat daftar nomor\n" +
          "*.clearnomor* — kosongkan nomor\n" +
          "*.pesan <teks>* — set isi pesan/caption\n" +
          "*.setgambar <url>* — set gambar (atau kirim foto + caption .setgambar)\n" +
          "*.hapusgambar* — hapus gambar\n" +
          "*.lihatpesan* — preview pesan\n" +
          "*.setjeda <min> <max>* — jeda antar pesan (detik)\n" +
          "*.broadcast* — mulai kirim (perlu konfirmasi)\n" +
          "*.stopbc* — hentikan broadcast berjalan\n" +
          "*.jadwalkan YYYY-MM-DD HH:MM* — jadwalkan broadcast (bisa banyak)\n" +
          "*.jadwal* — lihat daftar jadwal\n" +
          "*.hapusjadwal <id>* — hapus jadwal\n\n" +
          "💡 Spin text: tulis *{halo|hai|hi} kak* di pesan, bot pilih acak tiap kirim.\n" +
          "💡 Sticker: kirim foto + caption *.sticker* → bot balas bentuk stiker."
      );
      break;

    case ".groups": {
      const groups = await sock.groupFetchAllParticipating();
      const list = Object.values(groups);
      if (!list.length) {
        await reply("Bot belum ikut grup apapun.");
        break;
      }
      let out = "*DAFTAR GRUP:*\n\n";
      list.forEach((g, i) => {
        const mon = data.monitored[g.id] ? " ✅(dipantau)" : "";
        out += `${i + 1}. ${g.subject}${mon}\n   ${g.id}\n`;
      });
      out += "\nPakai: *.add <index> <prefix> <nama>*\natau *.addjid <jid> <prefix> <nama>* (copy JID di atas)";
      // simpan urutan sementara biar .add bisa pakai index
      data._lastGroupList = list.map((g) => g.id);
      saveData();
      await reply(out);
      break;
    }

    case ".addjid": {
      const gjid = parts[1];
      const prefix = (parts[2] || "").toLowerCase();
      const name = parts.slice(3).join(" ");
      if (!gjid || !gjid.endsWith("@g.us") || !prefix || !name) {
        await reply("Format: *.addjid <jid> <prefix> <nama>*\nContoh: .addjid 120363408939560829@g.us princess PRINCESS\n(JID bisa dilihat di log terminal: grup=...@g.us)");
        break;
      }
      data.monitored[gjid] = { prefix, name, counter: 1 };
      saveData();
      await reply(`✅ Mulai pantau *${name}* (.${prefix})\n   ${gjid}`);
      break;
    }

    case ".add": {
      const idx = parseInt(parts[1], 10) - 1;
      const prefix = (parts[2] || "").toLowerCase();
      const name = parts.slice(3).join(" ");
      if (!data._lastGroupList || isNaN(idx) || !prefix || !name) {
        await reply("Format: *.add <index> <prefix> <nama>*\nJalankan *.groups* dulu ya.");
        break;
      }
      const gjid = data._lastGroupList[idx];
      if (!gjid) {
        await reply("Index gak valid. Jalankan *.groups* lagi.");
        break;
      }
      data.monitored[gjid] = { prefix, name, counter: 1 };
      saveData();
      await reply(`✅ Mulai pantau *${name}* dengan kode *.${prefix}*`);
      break;
    }

    case ".del": {
      const prefix = (parts[1] || "").toLowerCase();
      const found = Object.entries(data.monitored).find(([, v]) => v.prefix === prefix);
      if (found) {
        delete data.monitored[found[0]];
        saveData();
        await reply(`🗑️ Berhenti pantau grup dengan kode *.${prefix}*`);
      } else {
        await reply(`Kode *.${prefix}* gak ketemu.`);
      }
      break;
    }

    case ".monitored": {
      const entries = Object.entries(data.monitored);
      if (!entries.length) {
        await reply("Belum ada grup yang dipantau. Pakai *.groups* lalu *.add*.");
        break;
      }
      let out = "*GRUP DIPANTAU:*\n\n";
      entries.forEach(([gjid, g]) => (out += `• ${g.name} (.${g.prefix})\n   ${gjid}\n`));
      await reply(out);
      break;
    }

    case ".list": {
      const codes = Object.keys(data.pending);
      if (!codes.length) {
        await reply("🎉 Semua notif sudah direspon. Kosong.");
        break;
      }
      // kelompokin per grup
      const byGroup = {};
      for (const code of codes) {
        const n = data.pending[code];
        (byGroup[n.groupName] ||= []).push({ code, ...n });
      }
      let out = "*BELUM DIRESPON:*\n";
      for (const [gname, items] of Object.entries(byGroup)) {
        out += `\n*${gname}*\n`;
        items.forEach((it) => {
          out += `• ${it.code} ${it.time} | +${it.number}\n  💬 ${it.message}\n`;
        });
      }
      await reply(out);
      break;
    }

    case ".kw": {
      const sub = (parts[1] || "").toLowerCase();
      if (!sub) {
        await reply("*KEYWORD:*\n" + settings.keywords.map((k) => `• ${k}`).join("\n"));
      } else if (sub === "add") {
        const word = parts.slice(2).join(" ").toLowerCase();
        if (word && !settings.keywords.includes(word)) {
          settings.keywords.push(word);
          fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
          await reply(`✅ Keyword ditambah: "${word}"`);
        } else await reply("Keyword kosong / sudah ada.");
      } else if (sub === "del") {
        const word = parts.slice(2).join(" ").toLowerCase();
        const i = settings.keywords.indexOf(word);
        if (i >= 0) {
          settings.keywords.splice(i, 1);
          fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
          await reply(`🗑️ Keyword dihapus: "${word}"`);
        } else await reply("Keyword gak ketemu.");
      }
      break;
    }

    case ".resetgrup": {
      if ((parts[1] || "").toLowerCase() !== "yakin") {
        await reply(`⚠️ Ini akan hapus *SEMUA* ${Object.keys(data.monitored).length} grup dari pantauan.\nKalau yakin, ketik:\n*.resetgrup yakin*`);
        break;
      }
      data.monitored = {};
      data.seen = {};
      saveData();
      await reply("🗑️ Semua grup pantauan dihapus. Mulai bersih.\nDeteksi grup baru otomatis aktif lagi — tinggal tunggu laporan 🆕 lalu .addjid.");
      break;
    }

    case ".scan": {
      const sub = (parts[1] || "").toLowerCase();
      if (sub === "on") {
        data.scanMode = true;
        saveData();
        await reply("🔍 Deteksi grup baru: *ON*");
      } else if (sub === "off") {
        data.scanMode = false;
        saveData();
        await reply("🔕 Deteksi grup baru: *OFF*");
      } else if (sub === "reset") {
        data.seen = {};
        saveData();
        await reply("♻️ Reset. Semua grup belum dipantau akan dilaporkan lagi saat ada chat.");
      } else {
        await reply(`Status deteksi: *${data.scanMode !== false ? "ON" : "OFF"}*\nPakai: .scan on | .scan off | .scan reset`);
      }
      break;
    }

    case ".ping":
      await reply(`🟢 Bot aktif. ${fmtTime()}\nDipantau: ${Object.keys(data.monitored).length} grup | Pending: ${Object.keys(data.pending).length}`);
      break;

    // ========== BROADCAST ==========
    case ".addnomor": {
      const raw = text.substring(cmd.length).trim();
      if (!raw) {
        await reply("Format: *.addnomor 628xxx, 628xxx, ...*");
        break;
      }
      const tokens = raw.split(/[\s,;]+/).filter(Boolean);
      let added = 0,
        invalid = 0,
        dup = 0;
      for (const t of tokens) {
        const n = normNum(t);
        if (!n) {
          invalid++;
          continue;
        }
        if (data.bcNumbers.includes(n)) {
          dup++;
          continue;
        }
        data.bcNumbers.push(n);
        added++;
      }
      saveData();
      await reply(`✅ +${added} nomor (total: ${data.bcNumbers.length})` + (dup ? `\n↩️ ${dup} duplikat dilewati` : "") + (invalid ? `\n⚠️ ${invalid} format salah dilewati` : ""));
      break;
    }

    case ".listnomor": {
      if (!data.bcNumbers.length) {
        await reply("Daftar nomor kosong. Tambah dengan *.addnomor*");
        break;
      }
      await reply(`*NOMOR TUJUAN (${data.bcNumbers.length}):*\n` + data.bcNumbers.map((n, i) => `${i + 1}. +${n}`).join("\n"));
      break;
    }

    case ".clearnomor":
      data.bcNumbers = [];
      saveData();
      await reply("🗑️ Daftar nomor dikosongkan.");
      break;

    case ".pesan": {
      const tpl = text.substring(cmd.length).trim();
      if (!tpl) {
        await reply("Format: *.pesan <isi pesan>*\nBoleh beberapa baris.");
        break;
      }
      data.bcText = tpl;
      saveData();
      await reply("✅ Pesan disimpan. Preview dengan *.lihatpesan*");
      break;
    }

    case ".setgambar": {
      const url = parts[1];
      if (url && /^https?:\/\//i.test(url)) {
        data.bcImage = url;
        saveData();
        await reply("✅ Gambar (URL) disimpan.");
      } else {
        await reply("Set gambar dengan 2 cara:\n1. *.setgambar https://...* (link gambar)\n2. Kirim *foto* ke grup ini dengan caption *.setgambar*");
      }
      break;
    }

    case ".hapusgambar":
      data.bcImage = null;
      saveData();
      await reply("🗑️ Gambar broadcast dihapus.");
      break;

    case ".lihatpesan": {
      const img = data.bcImage ? (/^https?:/i.test(data.bcImage) ? "URL: " + data.bcImage : "Ada (foto tersimpan)") : "—";
      await reply(`*PREVIEW BROADCAST*\n\n🖼️ Gambar: ${img}\n💬 Pesan:\n${data.bcText || "(kosong)"}\n\n👥 Nomor: ${data.bcNumbers.length}\n⏱️ Jeda: ${data.bcDelayMin}-${data.bcDelayMax} detik`);
      break;
    }

    case ".setjeda": {
      const mn = parseInt(parts[1], 10);
      const mx = parseInt(parts[2], 10);
      if (isNaN(mn) || isNaN(mx) || mn < 5 || mx < mn) {
        await reply("Format: *.setjeda <min> <max>* (detik)\nContoh: .setjeda 40 100\nMinimal 5 detik, max ≥ min.");
        break;
      }
      data.bcDelayMin = mn;
      data.bcDelayMax = mx;
      saveData();
      await reply(`✅ Jeda di-set ${mn}-${mx} detik antar pesan.`);
      break;
    }

    case ".broadcast": {
      if (bcRunning) {
        await reply("⏳ Broadcast sedang berjalan. Ketik *.stopbc* untuk hentikan.");
        break;
      }
      if (!data.bcNumbers.length) {
        await reply("❌ Belum ada nomor. Tambah dengan *.addnomor*");
        break;
      }
      if (!data.bcText && !data.bcImage) {
        await reply("❌ Belum ada isi pesan/gambar. Set dengan *.pesan* / *.setgambar*");
        break;
      }
      if ((parts[1] || "").toLowerCase() !== "yakin") {
        const estMin = Math.round((data.bcNumbers.length * (data.bcDelayMin + data.bcDelayMax)) / 2 / 60);
        await reply(
          `⚠️ *KONFIRMASI BROADCAST*\n\n👥 ${data.bcNumbers.length} nomor\n⏱️ Jeda ${data.bcDelayMin}-${data.bcDelayMax} dtk\n⏳ Estimasi ~${estMin} menit\n🖼️ Gambar: ${data.bcImage ? "ada" : "tidak"}\n\n💬 Pesan:\n${data.bcText || "(hanya gambar)"}\n\nKalau yakin ketik:\n*.broadcast yakin*\n\n_Ingat: kirim hanya ke orang yang kenal kamu, biar gak kena report/ban._`
        );
        break;
      }
      const payload = {
        numbers: [...data.bcNumbers],
        text: data.bcText,
        image: data.bcImage,
        delayMin: data.bcDelayMin,
        delayMax: data.bcDelayMax,
      };
      // sekali pakai: kosongkan nomor (gak kekirim dobel)
      data.bcNumbers = [];
      saveData();
      runBroadcast(sock, hubJid, payload); // jalan async
      break;
    }

    case ".stopbc":
      if (!bcRunning) {
        await reply("Tidak ada broadcast berjalan.");
      } else {
        bcStop = true;
        await reply("🛑 Menghentikan broadcast setelah pesan saat ini...");
      }
      break;

    case ".donesemua": {
      const n = Object.keys(data.pending).length;
      data.pending = {};
      saveData();
      await reply(`✅ ${n} notif ditandai selesai semua. Daftar bersih.`);
      break;
    }

    case ".jadwalkan": {
      // .jadwalkan YYYY-MM-DD HH:MM  -> snapshot config sekarang jadi 1 jadwal
      const dateStr = parts[1];
      const timeStr = parts[2];
      if (!dateStr || !timeStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr) || !/^\d{2}:\d{2}$/.test(timeStr)) {
        await reply("Format: *.jadwalkan YYYY-MM-DD HH:MM*\nContoh: .jadwalkan 2026-06-13 09:00\n\n(Set .addnomor, .pesan, .setgambar dulu — itu yang akan dijadwalkan)");
        break;
      }
      if (!data.bcNumbers.length) {
        await reply("❌ Belum ada nomor. .addnomor dulu.");
        break;
      }
      if (!data.bcText && !data.bcImage) {
        await reply("❌ Belum ada pesan/gambar. .pesan dulu.");
        break;
      }
      const runAt = new Date(`${dateStr}T${timeStr}:00`).getTime();
      if (isNaN(runAt)) {
        await reply("Tanggal/jam tidak valid.");
        break;
      }
      if (runAt <= Date.now()) {
        await reply("⚠️ Waktu itu sudah lewat. Pakai waktu di masa depan.");
        break;
      }
      data.scheduleSeq = (data.scheduleSeq || 0) + 1;
      const id = "jdw" + data.scheduleSeq;
      data.schedules.push({
        id,
        runAt,
        numbers: [...data.bcNumbers],
        text: data.bcText,
        image: data.bcImage,
        delayMin: data.bcDelayMin,
        delayMax: data.bcDelayMax,
      });
      // bersihkan config sekarang biar bisa siapin jadwal berikutnya
      data.bcNumbers = [];
      data.bcText = "";
      data.bcImage = null;
      saveData();
      await reply(`✅ Jadwal *${id}* dibuat untuk *${dateStr} ${timeStr}*.\nConfig sekarang dikosongkan — siapin jadwal berikutnya kalau mau (.addnomor, .pesan, .jadwalkan lagi).`);
      break;
    }

    case ".jadwal": {
      if (!data.schedules || !data.schedules.length) {
        await reply("Belum ada jadwal. Buat dengan *.jadwalkan*");
        break;
      }
      const sorted = [...data.schedules].sort((a, b) => a.runAt - b.runAt);
      let out = "*JADWAL BROADCAST:*\n\n";
      sorted.forEach((j) => {
        out += `🗓️ *${j.id}* — ${fmtTime(new Date(j.runAt))}\n   👥 ${j.numbers.length} nomor | 🖼️ ${j.image ? "ada" : "-"}\n   💬 ${(j.text || "(gambar saja)").slice(0, 50)}...\n\n`;
      });
      out += "Hapus: *.hapusjadwal <id>*";
      await reply(out);
      break;
    }

    case ".hapusjadwal": {
      const id = (parts[1] || "").toLowerCase();
      const before = data.schedules.length;
      data.schedules = data.schedules.filter((j) => j.id.toLowerCase() !== id);
      saveData();
      await reply(before !== data.schedules.length ? `🗑️ Jadwal *${id}* dihapus.` : `Jadwal *${id}* gak ketemu. Cek *.jadwal*`);
      break;
    }

    case ".stats": {
      const days = parseInt(parts[1], 10) || 7;
      const daily = data.stats?.daily || {};
      const hari = ["Min", "Sen", "Sel", "Rab", "Kam", "Jum", "Sab"];
      const cutoff = new Date();
      cutoff.setHours(0, 0, 0, 0);
      cutoff.setTime(cutoff.getTime() - (days - 1) * 86400000);
      const byKw = {},
        byGrp = {},
        byDay = {};
      let total = 0;
      for (const [dk, d] of Object.entries(daily)) {
        const ts = new Date(`${dk}T00:00:00`).getTime();
        if (ts < cutoff.getTime()) continue;
        total += d.total || 0;
        for (const [k, v] of Object.entries(d.kw || {})) byKw[k] = (byKw[k] || 0) + v;
        for (const [k, v] of Object.entries(d.grp || {})) byGrp[k] = (byGrp[k] || 0) + v;
        const wd = hari[new Date(ts).getDay()];
        byDay[wd] = (byDay[wd] || 0) + (d.total || 0);
      }
      if (!total) {
        await reply(`Belum ada data notif dalam ${days} hari terakhir.`);
        break;
      }
      const top = (obj, n) =>
        Object.entries(obj)
          .sort((a, b) => b[1] - a[1])
          .slice(0, n)
          .map(([k, v], i) => `${i + 1}. ${k} — ${v}x`)
          .join("\n");
      const busiestDay = Object.entries(byDay).sort((a, b) => b[1] - a[1])[0];
      await reply(
        `📊 *STATISTIK ${days} HARI*\n\n` +
          `Total notif: *${total}*\n` +
          `Hari paling rame: *${busiestDay[0]}* (${busiestDay[1]}x)\n\n` +
          `🔑 *Keyword teratas:*\n${top(byKw, 5)}\n\n` +
          `👥 *Grup teratas:*\n${top(byGrp, 5)}`
      );
      break;
    }

    case ".reply": {
      const rest = text.substring(cmd.length).trim(); // "thr0001 isi pesan..."
      const sp = rest.indexOf(" ");
      const code = (sp === -1 ? rest : rest.slice(0, sp)).toLowerCase();
      const body = sp === -1 ? "" : rest.slice(sp + 1).trim();
      const n = data.pending[code];
      if (!n) {
        await reply(`❓ Kode *${code}* gak ada di daftar. Cek *.list*`);
        break;
      }
      if (!body) {
        await reply("Format: *.reply <kode> <isi pesan>*\nContoh: .reply thr0001 Halo kak, ready netflix-nya 👍");
        break;
      }
      const target = n.senderJid || `${n.number}@s.whatsapp.net`;
      try {
        // DM pribadi ke pengirim, tapi quote pesan grup aslinya (balas pribadi)
        if (n.quoted) {
          await sock.sendMessage(target, { text: body }, { quoted: n.quoted });
        } else {
          await sock.sendMessage(target, { text: body });
        }
        delete data.pending[code]; // dianggap sudah direspon
        saveData();
        await reply(`✅ Balasan DM terkirim ke +${n.number}${n.quoted ? " (quote pesan grup)" : ""}\n💬 "${body}"\n_${code} ditandai selesai._`);
      } catch (e) {
        await reply(`❌ Gagal kirim ke +${n.number}: ${e.message}`);
      }
      break;
    }

    default:
      await reply("Perintah gak dikenal. Ketik *.help*.");
  }
}

// ---------- Jalankan broadcast ----------
async function runBroadcast(sock, hubJid, payload, label = "") {
  bcRunning = true;
  bcStop = false;
  const reply = (t) => sock.sendMessage(hubJid, { text: t });
  const numbers = [...payload.numbers];
  const dMin = payload.delayMin ?? 40;
  const dMax = payload.delayMax ?? 100;
  let ok = 0,
    fail = 0,
    skip = 0;

  await reply(`🚀 Broadcast${label ? ` (${label})` : ""} dimulai ke ${numbers.length} nomor...`);

  for (let i = 0; i < numbers.length; i++) {
    if (bcStop) {
      await reply(`🛑 Dihentikan di nomor ke-${i}. Terkirim: ${ok}`);
      break;
    }
    const num = numbers[i];
    try {
      const res = await sock.onWhatsApp(num);
      if (!res || !res[0]?.exists) {
        skip++;
        console.log(`[BC] skip (tidak di WA): ${num}`);
      } else {
        const target = res[0].jid;
        const msgText = spin(payload.text || ""); // variasi tiap kirim
        if (payload.image) {
          await sock.sendMessage(target, { image: { url: payload.image }, caption: msgText });
        } else {
          await sock.sendMessage(target, { text: msgText });
        }
        ok++;
        console.log(`[BC] terkirim: ${num} (${ok}/${numbers.length})`);
      }
    } catch (e) {
      fail++;
      console.log(`[BC] gagal ${num}: ${e.message}`);
    }

    if ((i + 1) % 5 === 0) await reply(`📊 Progress: ${i + 1}/${numbers.length} (✅${ok} ⏭️${skip} ❌${fail})`);

    if (i < numbers.length - 1 && !bcStop) {
      await sleep(randInt(dMin, dMax) * 1000);
    }
  }

  bcRunning = false;
  await reply(`✅ *Broadcast${label ? ` (${label})` : ""} selesai*\nTerkirim: ${ok} | Dilewati: ${skip} | Gagal: ${fail}`);
}

// ---------- Scheduler: cek jadwal tiap 30 detik ----------
function startScheduler() {
  setInterval(async () => {
    if (bcRunning || !sockRef || !data.hubJid) return;
    if (!data.schedules || !data.schedules.length) return;
    const now = Date.now();
    const due = data.schedules.find((j) => j.runAt <= now);
    if (!due) return;
    // angkat job ini dari antrian
    data.schedules = data.schedules.filter((j) => j.id !== due.id);
    saveData();
    console.log(`[JADWAL] menjalankan ${due.id}`);
    await runBroadcast(sockRef, data.hubJid, due, due.id);
  }, 30000);
}

start();