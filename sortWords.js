const fs = require('fs');

// Baca file
const filePath = 'indonesian-words.txt';
const outputFilePath = 'indonesian-wordlist-sorted.txt';

try {
  const data = fs.readFileSync(filePath, 'utf-8');
  const words = data.split(/\r?\n/).filter(Boolean);

  // Sort kata-kata
  const sortedWords = words.sort((a, b) => a.localeCompare(b, 'id'));

  // Gabung kembali dan tulis ke file baru
  fs.writeFileSync(outputFilePath, sortedWords.join('\n'), 'utf-8');

  console.log(`File berhasil diurutkan dan disimpan sebagai ${outputFilePath}`);
} catch (err) {
  console.error('Terjadi kesalahan:', err);
}
