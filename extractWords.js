// Import library yang dibutuhkan
const puppeteer = require('puppeteer');
const fs = require('fs');

// ============ KONFIGURASI ============
const CONFIG = {
  MAX_WORKERS: 12,          // Jumlah worker (tab) paralel. Sesuaikan dengan kemampuan CPU/RAM.
  RATE_LIMIT: 200,          // Jeda minimal antar request (ms). Naikkan jika sering error/blokir.
  SEED_WORDS: ['kamus', 'bahasa', 'indonesia', 'kata', 'arti'], // Kata(kata) awal untuk memulai
  OUTPUT_FILE: 'indonesian-words.txt', // Nama file output kata valid
  RESUME_FILE: 'resume_words.json',     // Nama file state untuk resume
  MAX_WORD_LENGTH: 30,      // Batas maksimum panjang kata (heuristik, cegah gabungan aneh)
  MIN_WORD_LENGTH: 1,       // Batas minimum panjang kata (misal 'a', 'i')
};
// =====================================

/**
 * Mengatur jeda antar request agar tidak membebani server target.
 */
class RateLimiter {
  constructor(interval) {
    this.lastRequestTime = 0;
    this.interval = interval;
    this.queue = [];
    this.processing = false;
  }

  async processQueue() {
    if (this.processing || this.queue.length === 0) {
      return;
    }
    this.processing = true;
    const resolve = this.queue.shift(); // Ambil fungsi resolve dari antrian

    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;
    const delay = Math.max(0, this.interval - timeSinceLastRequest);

    setTimeout(() => {
      this.lastRequestTime = Date.now(); // Update waktu *setelah* delay
      resolve(); // Panggil resolve untuk melanjutkan promise yang menunggu
      this.processing = false;
      this.processQueue(); // Proses antrian berikutnya jika ada
    }, delay);
  }

  acquire() {
    return new Promise(resolve => {
      this.queue.push(resolve); // Tambahkan resolve ke antrian
      this.processQueue(); // Coba proses antrian
    });
  }
}

/**
 * Mengekstrak kata-kata (urutan huruf a-z) dari seluruh teks halaman.
 * @param {puppeteer.Page} page Objek halaman Puppeteer
 * @returns {Promise<string[]>} Array kata unik dalam huruf kecil
 */
async function extractWords(page) {
  try {
    return await page.evaluate((minLen) => {
      const textContent = document.body.innerText || '';
      // Regex untuk mengambil urutan huruf saja
      const words = textContent.match(/\b[a-z]+(?:-[a-z]+)*\b/gi) || [];
      // Buat unik, lowercase, dan filter panjang minimum
      return Array.from(new Set(words.map(w => w.toLowerCase())))
        .filter(w => w.length >= minLen);
    }, CONFIG.MIN_WORD_LENGTH); // Kirim MIN_WORD_LENGTH ke konteks browser
  } catch (err) {
    console.warn(` Peringatan: Gagal mengekstrak kata dari halaman: ${err.message}`);
    return []; // Kembalikan array kosong jika gagal
  }
}

/**
 * Fungsi utama worker: mengambil kata dari antrian, mengunjungi KBBI,
 * memvalidasi, mengekstrak kata baru, dan menambahkannya ke antrian.
 * @param {puppeteer.Browser} browser Instance browser Puppeteer
 * @param {RateLimiter} limiter Instance RateLimiter
 * @param {string[]} queue Array antrian kata (shared)
 * @param {Set<string>} visited Set kata yang sudah dikunjungi (shared)
 * @param {string[]} output Array kata valid yang ditemukan (shared)
 */
async function crawlWord(browser, limiter, queue, visited, output) {
  let page = null; // Halaman browser untuk worker ini

  while (true) {
    const word = queue.shift(); // Ambil kata dari depan antrian

    // Cek jika antrian kosong
    if (!word) {
      // Beri jeda sedikit untuk menunggu jika worker lain menambahkan kata
      await new Promise(resolve => setTimeout(resolve, 500));
      // Cek lagi setelah jeda
      if (queue.length === 0) {
         // Jika masih kosong, tunggu sedikit lebih lama (mungkin semua worker hampir selesai)
         await new Promise(resolve => setTimeout(resolve, 1000));
         // Cek final sebelum keluar
         if (queue.length === 0) {
            // console.log(` Worker ${process.pid}: Antrian kosong, keluar.`); // Uncomment for debug
            break; // Keluar dari loop worker
        } else {
            continue; // Ada kata baru, lanjut
        }
      }
      continue; // Ada kata baru, lanjut
    }

    // Lewati jika kata ini sudah pernah dikunjungi (baik valid maupun tidak)
    if (visited.has(word)) {
      continue;
    }
    // Tandai sudah dikunjungi SEKARANG untuk mencegah worker lain rebutan
    visited.add(word);

    try {
      // Tunggu giliran sesuai rate limit
      await limiter.acquire();

      // Buat halaman baru jika belum ada atau jika sebelumnya ditutup karena error
      if (!page || page.isClosed()) {
          page = await browser.newPage();
          // blokir resource yang tidak perlu (CSS, gambar, font, dll.)
          await page.setRequestInterception(true);
          page.on('request', (req) => {
            if (req.resourceType() === 'document') {
              req.continue();
            } else {
              req.abort();
            }
          });
      }

      const kbbiUrl = `https://k**.w.id/${encodeURIComponent(word)}`; // URL KBBI
      // Melakukan navigasi ke halaman KBBI untuk kata tersebut
      await page.goto(kbbiUrl, {
          waitUntil: 'domcontentloaded', // Tunggu hingga DOM muncul
          timeout: 35000 // Timeout navigasi (ms)
        });

 // === PEMERIKSAAN VALIDITAS KATA (v5 - Cek Negatif & Positif Lebih Luas) ===
 const wordToValidate = word; // Kata yang sedang divalidasi
 const isWordValid = await page.evaluate((wordToCheck) => {
     const definitionArea = document.querySelector('#d1');
     // Jika area definisi utama (#d1) tidak ada, anggap tidak valid
     if (!definitionArea) {
         // console.log(`Debug (${wordToCheck}): #d1 tidak ditemukan.`);
         return false;
     }

     // 1. Cek Eksplisit "Tidak Ditemukan" (Negative Check - Paling Prioritas)
     const notFoundElement = definitionArea.querySelector('h3');
     if (notFoundElement && notFoundElement.textContent.includes('Entri tidak ditemukan')) {
         // console.log(`Debug (${wordToCheck}): Ditemukan "Entri tidak ditemukan".`);
         return false; // Jelas tidak valid
     }

     // Siapkan Regex untuk mencari kata utuh (word boundary \b) dan case-insensitive (i)
     // Escape karakter spesial dalam kata jika ada (penting!)
     const escapedWord = wordToCheck.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
     const wordRegex = new RegExp(`\\b${escapedWord}(?:\\d+)?\\b`, 'i')

     // 2. Cek Positif Prioritas Tinggi (Selector Asli)
     const primaryIndicators = definitionArea.querySelectorAll('b.main, b.tur, b.mjk');
     if (primaryIndicators && primaryIndicators.length > 0) {
         for (const indicator of primaryIndicators) {
             if (wordRegex.test(indicator.textContent || '')) {
                 // console.log(`Debug (${wordToCheck}): Ditemukan di indikator primer: ${indicator.textContent}`);
                 return true; // Ditemukan di tag utama/turunan/majemuk
             }
         }
     }

     // 3. Cek Positif Sekunder (Semua Tag <b> di dalam #d1)
     // Menangkap kata yang dibold dalam definisi/contoh
     const allBoldTags = definitionArea.querySelectorAll('b');
     if (allBoldTags && allBoldTags.length > 0) {
         for (const boldTag of allBoldTags) {
             if (wordRegex.test(boldTag.textContent || '')) {
                 // console.log(`Debug (${wordToCheck}): Ditemukan di tag <b> sekunder: ${boldTag.textContent}`);
                 return true; // Ditemukan di tag bold mana pun dalam #d1
             }
         }
     }

     // 4. Cek Positif Tambahan (Struktur Umum Kata Dasar: <span class="root-word"><a...>)
     // Ini sering muncul untuk entri utama.
     const rootWordLink = definitionArea.querySelector('span.root-word a');
     if (rootWordLink && wordRegex.test(rootWordLink.textContent || '')) {
          // console.log(`Debug (${wordToCheck}): Ditemukan di root word link: ${rootWordLink.textContent}`);
         return true;
     }

     // Jika tidak ada pesan "tidak ditemukan" DAN tidak ditemukan melalui cek positif di atas,
     // kemungkinan besar kata tersebut tidak valid sebagai entri utama/turunan/majemuk
     // yang relevan, meskipun mungkin muncul di tempat lain.
     // console.log(`Debug (${wordToCheck}): Tidak ditemukan melalui semua metode positif.`);
     return false;

 }, wordToValidate); // Kirim 'word' ke dalam lingkup page.evaluate sebagai 'wordToCheck'

 const hasPrefix = /^(ter|di|ber|me|mem|men|meng|pen|pem|per|se|ke|pe)/i.test(word); // Awalan
 const hasSuffix = /(nya|an)$/i.test(word); // Akhiran
 const isReduplicated = word.includes('-'); // Kata ulang
 
 if (!isWordValid && !hasPrefix && !hasSuffix && !isReduplicated) {
   console.log(`🟡 ${word} - Tidak valid, tanpa imbuhan awalan/akhiran, dan bukan kata ulang. Dilewati.`);
   continue;
 }
 
 if (isReduplicated && !isWordValid) {
   console.log(`🟡 ${word} - Kata ulang tidak valid, tetap disimpan.`);
 } else if (hasPrefix && !isWordValid) {
   console.log(`🟡 ${word} - Kata berawalan tidak valid, tetap disimpan.`);
 } else if (hasSuffix && !isWordValid) {
   console.log(`🟡 ${word} - Kata berakhiran tidak valid, tetap disimpan.`);
 } else if (isWordValid) {
   console.log(`✔️ ${word} - Valid di entri, mengekstrak kata lain...`);
 }
 

 // =======================================================================


      // --- Jika Lolos Validasi (kata ditemukan dalam teks indikator) ---
      console.log(`✔️ ${word} - Ditemukan dalam teks entri/turunan/majemuk. Mengekstrak kata lain...`);

      // Ekstrak semua kata lain dari halaman ini untuk ditambahkan ke antrian
      const newWords = await extractWords(page);

      // Filter kata-kata baru yang ditemukan
      const filteredWords = newWords.filter(w =>
        !visited.has(w) &&                // Belum pernah dikunjungi
        w !== word.toLowerCase() &&       // Bukan kata yang sedang diproses
        w.length <= CONFIG.MAX_WORD_LENGTH && // Memenuhi batas panjang maks
        w.length >= CONFIG.MIN_WORD_LENGTH    // Memenuhi batas panjang min
      );

      // Tambahkan kata baru yang unik dan valid ke *akhir* antrian
      if (filteredWords.length > 0) {
          // Pastikan tidak menambahkan kata yang sama persis lagi
          const uniqueNewWords = filteredWords.filter(nw => nw !== wordToValidate);
           if (uniqueNewWords.length > 0) {
             queue.push(...uniqueNewWords); // Gunakan spread operator untuk menambahkan semua elemen
           }
      }

      // Tambahkan kata yang TERVALIDASI ini ke dalam array output
      output.push(word);

      // Log status
      const qSize = queue.length;
      console.log(`✅ ${word} (Valid, Ditemukan: ${output.length}, Antrian: ${qSize}, +${filteredWords.length} baru)`);

      // Simpan progres secara berkala (misal setiap 100 kata valid ditemukan)
      if (output.length % 100 === 0) {
        saveProgress(output, queue, visited);
      }

    } catch (err) {
      // Tangani error yang mungkin terjadi (misal timeout, navigasi gagal)
      console.error(`❌ Gagal proses "${word}": ${err.name} - ${err.message.split('\n')[0]}`);
      // Jika error karena halaman ditutup atau timeout, tutup halaman agar dibuat ulang
       if (page && !page.isClosed() && (err.message.includes('Target closed') || err.message.includes('timeout') || err.name === 'TimeoutError')) {
           try { await page.close(); } catch (closeErr) { console.warn(` Gagal menutup page setelah error: ${closeErr.message}`)}
           page = null; // Set null agar halaman baru dibuat di iterasi berikutnya
       }
       // Pertimbangkan strategi retry jika diperlukan untuk error sementara
       // Contoh sederhana: queue.push(word); // Hati-hati potensi infinite loop
    }
  } // Akhir while(true) loop worker

  // Tutup halaman jika worker selesai dan halaman masih terbuka
  if (page && !page.isClosed()) {
    try { await page.close(); } catch (e) { /* Abaikan error saat menutup */ }
  }
  // console.log(` Worker ${process.pid} selesai.`); // buat debug
}

/**
 * Menyimpan progres crawling ke file.
 * @param {string[]} output Array kata valid
 * @param {string[]} queue Array antrian kata
 * @param {Set<string>} visited Set kata yang sudah dikunjungi
 */
function saveProgress(output, queue, visited) {
  try {
    // Pastikan 'visited' adalah Set sebelum konversi
    if (!(visited instanceof Set)) {
        console.warn(" Tipe 'visited' bukan Set saat menyimpan, mencoba konversi...");
        visited = new Set(visited); // Coba pulihkan jika memungkinkan
    }
    console.log(`💾 Menyimpan progres... (${output.length} kata valid, ${visited.size} total dikunjungi)`);

    // Simpan daftar kata valid ke file teks (satu kata per baris)
    fs.writeFileSync(CONFIG.OUTPUT_FILE, output.join('\n'), 'utf-8');

    // Siapkan data untuk file resume (JSON)
    const resumeData = {
      output: output,
      queue: queue,
      visited: Array.from(visited) // Konversi Set ke Array agar bisa disimpan di JSON
    };
    // Simpan state ke file JSON
    fs.writeFileSync(CONFIG.RESUME_FILE, JSON.stringify(resumeData, null, 2), 'utf-8'); // `null, 2` untuk pretty print
    console.log(`💾 Progres disimpan ke ${CONFIG.OUTPUT_FILE} dan ${CONFIG.RESUME_FILE}.`);
  } catch (err) {
    console.error(" Gagal menyimpan progres:", err);
  }
}

// ==================================================
// Fungsi Utama (IIFE - Immediately Invoked Function Expression)
// ==================================================
(async () => {
  console.log("==============================================");
  console.log("🚀 Memulai Ekstraksi Kata (Validasi Teks)...");
  console.log("==============================================");
  let browser; // Deklarasi di luar try agar bisa ditutup di finally

  try {
    // Luncurkan browser Puppeteer
    browser = await puppeteer.launch({
        headless: 'new',
        args: [ 
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu'
        ]
   });

    console.log("🖥️  Browser Puppeteer berhasil diluncurkan.");

    // Inisialisasi state
    let queue = [...CONFIG.SEED_WORDS]; // Antrian kata yang akan dikunjungi
    let visited = new Set();            // Set kata yang sudah dikunjungi
    let output = [];                    // Array untuk menyimpan kata valid yang ditemukan

    // Cek dan muat state dari file resume jika ada
    if (fs.existsSync(CONFIG.RESUME_FILE)) {
      try {
        console.log(`🔄 Memuat progres dari ${CONFIG.RESUME_FILE}...`);
        const resumeRaw = fs.readFileSync(CONFIG.RESUME_FILE, 'utf-8');
        const resumeData = JSON.parse(resumeRaw);
        output = resumeData.output || [];
        queue = resumeData.queue || [...CONFIG.SEED_WORDS]; // Fallback ke seed jika queue kosong
        // Rekonstruksi Set 'visited' dari array yang disimpan
        visited = new Set(resumeData.visited || []);
        // Pastikan semua kata di output juga ada di visited (jaga-jaga)
        output.forEach(word => visited.add(word));
        console.log(`✅ Progres dimuat: ${output.length} kata valid, ${queue.length} antrian, ${visited.size} total dikunjungi.`);

        // Jika state dimuat tapi antrian kosong, cek apakah ada seed words baru yg belum divisit
        if (queue.length === 0 && CONFIG.SEED_WORDS.some(sw => !visited.has(sw))) {
            const newSeeds = CONFIG.SEED_WORDS.filter(sw => !visited.has(sw));
            if (newSeeds.length > 0) {
               queue.push(...newSeeds);
               console.log(`ℹ️ Antrian kosong, menambahkan seed words yang belum divisit: ${newSeeds.join(', ')}`);
            }
        }
         // Jika tidak ada state sama sekali atau state korup
         if (queue.length === 0 && output.length === 0 && visited.size === 0) {
             console.log("ℹ️ State kosong atau tidak valid, memulai ulang dengan SEED_WORDS.");
             queue = [...CONFIG.SEED_WORDS];
         }

      } catch (err) {
        console.error(` Gagal memuat atau parse file resume (${CONFIG.RESUME_FILE}): ${err}. Memulai dari awal.`);
        // Hapus file resume yang rusak agar tidak error lagi di run berikutnya
        try { fs.unlinkSync(CONFIG.RESUME_FILE); } catch (e) { /* abaikan jika gagal hapus */ }
        queue = [...CONFIG.SEED_WORDS]; visited = new Set(); output = []; // Reset state
      }
    } else {
        console.log(`ℹ️ File resume (${CONFIG.RESUME_FILE}) tidak ditemukan, memulai dari awal.`);
    }

    // Buat instance RateLimiter
    const limiter = new RateLimiter(CONFIG.RATE_LIMIT);

    // Jalankan workers secara paralel
    console.log(`👷 Menjalankan ${CONFIG.MAX_WORKERS} worker...`);
    const workers = [];
    for (let i = 0; i < CONFIG.MAX_WORKERS; i++) {
      workers.push(crawlWord(browser, limiter, queue, visited, output));
    }

    // Tunggu semua worker selesai
    await Promise.all(workers);

    console.log("🏁 Semua worker telah selesai.");
    console.log("💾 Menyimpan hasil akhir...");
    saveProgress(output, queue, visited); // Panggil saveProgress sekali lagi di akhir

    console.log("==============================================");
    console.log(`✅✅✅ Selesai! Total kata unik VALID ditemukan: ${output.length}.`);
    console.log(`       Total kata unik dikunjungi: ${visited.size}.`);
    console.log(`       Hasil disimpan di: ${CONFIG.OUTPUT_FILE}`);
    console.log("==============================================");

  } catch (error) {
    // Tangani error level atas (misalnya gagal launch browser)
    console.error("💥 Terjadi error fatal:", error);
  } finally {
    // Pastikan browser selalu ditutup
    if (browser) {
      await browser.close();
      console.log("🔒 Browser ditutup.");
    }
  }
})();
