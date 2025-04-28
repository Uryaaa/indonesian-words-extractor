# Pengekstrak Kata KBBI (KBBI Word Scraper)

[![Node.js](https://img.shields.io/badge/Node.js-16.x+-brightgreen.svg)](https://nodejs.org/)
[![Puppeteer](https://img.shields.io/badge/Puppeteer-Used-blue.svg)](https://pptr.dev/)

Program ini menggunakan [Puppeteer](https://pptr.dev/) untuk menjelajahi (crawl) dan mengekstrak (scrape) kata-kata Bahasa Indonesia yang **valid** dari situs web KBBI Online

## ✨ Fitur

* **Scraping Paralel:** Menggunakan beberapa _worker_ (tab browser headless) secara bersamaan untuk mempercepat proses ekstraksi (`MAX_WORKERS`).
* **Rate Limiting:** Mengatur jeda antar permintaan ke server KBBI untuk mencegah pemblokiran IP dan mengurangi beban server (`RATE_LIMIT`).
* **Validasi Kata:** Memverifikasi apakah sebuah kata benar-benar merupakan entri yang valid di KBBI (termasuk entri utama, turunan, atau majemuk) sebelum menyimpannya, dengan memeriksa elemen HTML spesifik pada halaman hasil pencarian.
* **Ekstraksi Rekursif:** Mengekstrak kata-kata baru dari halaman KBBI yang valid untuk ditambahkan ke antrian proses selanjutnya.
* **Filter Kata:** Mengabaikan kata yang terlalu panjang (`MAX_WORD_LENGTH`) atau terlalu pendek (`MIN_WORD_LENGTH`), serta mencegah duplikasi kata yang sudah diproses (`visited`).
* **Resume Otomatis:** Menyimpan status proses (kata yang sudah divalidasi, antrian kata berikutnya, kata yang sudah dikunjungi) secara berkala ke file `RESUME_FILE`. Jika skrip dihentikan dan dijalankan kembali, ia akan melanjutkan dari status terakhir yang tersimpan.
* **Konfigurasi Fleksibel:** Parameter utama seperti jumlah worker, rate limit, kata awal, nama file output, dan filter panjang kata dapat diatur melalui objek `CONFIG`.
* **Optimasi:** Anti load resource yang tidak perlu (CSS, gambar, font) untuk mempercepat navigasi halaman dan mengurangi penggunaan bandwidth.
* **Output Jelas:** Menghasilkan file teks (`OUTPUT_FILE`) berisi daftar kata-kata valid yang berhasil diekstrak, satu kata per baris.

## ⚙️ Konfigurasi

Semua pengaturan utama dapat ditemukan dan diubah dalam objek `CONFIG` didalam file (`extractWords.js`):

```javascript
const CONFIG = {
  MAX_WORKERS: 12,          // Jumlah worker paralel. Sesuaikan dengan CPU/RAM.
  RATE_LIMIT: 200,          // Jeda minimal antar request (ms). Naikkan jika sering error.
  SEED_WORDS: ['kamus', 'bahasa', 'indonesia', 'kata', 'arti'], // Kata awal
  OUTPUT_FILE: 'indonesian-words.txt', // Nama file output kata valid
  RESUME_FILE: 'resume_words.json',    // Nama file state untuk resume
  MAX_WORD_LENGTH: 30,      // Batas maksimum panjang kata
  MIN_WORD_LENGTH: 1,       // Batas minimum panjang kata
};
```
- **MAX_WORKERS**: Semakin tinggi, semakin cepat prosesnya, namun membutuhkan lebih banyak CPU dan RAM.
- **RATE_LIMIT**: Jeda dalam milidetik antar request per worker. Jangan terlalu kecil untuk menghindari pemblokiran IP.
- **SEED_WORDS**: Daftar kata awal untuk memulai scraping.
- **OUTPUT_FILE**: Nama file hasil daftar kata valid.
- **RESUME_FILE**: Nama file untuk menyimpan progress.
- **MAX_WORD_LENGTH / MIN_WORD_LENGTH**: Filter panjang kata.

## 🚀 Prasyarat
- Node.js (Disarankan versi 16.x atau lebih baru)
- npm atau Yarn

## 🛠️ Instalasi
Clone repository ini atau salin kode:
```bash
git clone indonesian-words-extractor
cd indonesian-words-extractor
```
Instal puppeteer:
```bash
npm install puppeteer
```
atau menggunakan yarn
```bash
yarn add puppeteer
```

## ▶️ Cara Menjalankan
 Konfigurasikan `(CONFIG)` sesuai kebutuhan

Jalankan file
```bash
node extractWords.js
```




