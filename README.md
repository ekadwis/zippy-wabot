# 🤖 Zippy Store — WhatsApp Notif Bot

Bot pemantau keyword. Login pakai **nomor BISNIS** (scan QR). Kalau di grup yang
dipantau ada keyword (mis. "wtb netflix"), bot kirim notif ke grup **Notif BOT**.
Semua perintah dijalankan dari **nomor PRIBADI** di dalam grup itu.

---

## 1. Persiapan (sekali aja)

1. Pastikan **Node.js v20+** sudah terinstall. Cek: `node --version`
2. Buka folder ini di terminal, jalankan:
   ```
   npm install
   ```
3. Edit file **settings.json**:
   - `ownerNumber` → isi **nomor PRIBADI** kamu, format `628xxxxxxxxx` (pakai 62, tanpa + atau 0).
   - `keywords` → daftar kata yang mau dideteksi (sudah ada contoh, bebas diubah).

## 2. Bikin grup WhatsApp

- Buat grup baru, namai **Notif BOT**.
- Anggotanya: **nomor bisnis** + **nomor pribadi** kamu. (cukup 2 itu)

## 3. Jalankan bot

```
npm start
```

- Muncul **QR code** di terminal → scan pakai **WA BISNIS**
  (WhatsApp > Perangkat Tertaut > Tautkan Perangkat).
- Kalau muncul "✅ BOT TERHUBUNG" berarti sukses.

## 4. Setup awal (dari nomor PRIBADI, di grup Notif BOT)

```
.sethere                         → set grup ini sebagai pusat notif
.groups                          → lihat daftar semua grup + nomor index-nya
.add 3 thr GRUP THRONE           → pantau grup index 3, kode .thr, nama "GRUP THRONE"
```

Ulangi `.add` untuk tiap grup yang mau dipantau (kasih prefix beda: thr, jkt, dll).

## 5. Pemakaian harian

| Perintah | Fungsi |
|---|---|
| (otomatis) | Bot kirim notif tiap ada keyword |
| `thr0001 done` | Tandai notif sudah kamu respon |
| `.list` | Lihat semua notif yang belum direspon |
| `.monitored` | Lihat grup yang dipantau |
| `.kw` | Lihat daftar keyword |
| `.kw add wtb disney` | Tambah keyword |
| `.kw del wtb disney` | Hapus keyword |
| `.help` | Daftar semua perintah |

---

## ⚠️ Catatan penting

- **Bot harus terus jalan** selama mau memantau. Kalau laptop dimatikan, bot berhenti.
  Lihat opsi hosting gratis di chat.
- Pakai **nomor bisnis** sebagai bot. Risiko ban kecil selama tidak spam.
- Kalau perlu ganti nomor bot: hapus folder `auth`, jalankan ulang, scan QR baru.
- File `data.json` & folder `auth` jangan dihapus (isinya sesi login & data notif).
