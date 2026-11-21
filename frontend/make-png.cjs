const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function createPng(width, height, r, g, b) {
  // Simple uncompressed or deflate PNG generator
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  // IHDR chunk
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData.writeUInt8(8, 8); // 8-bit depth
  ihdrData.writeUInt8(2, 9); // Truecolor RGB
  ihdrData.writeUInt8(0, 10);
  ihdrData.writeUInt8(0, 11);
  ihdrData.writeUInt8(0, 12);

  function makeChunk(type, data) {
    const len = data.length;
    const buf = Buffer.alloc(12 + len);
    buf.writeUInt32BE(len, 0);
    buf.write(type, 4, 4, 'ascii');
    data.copy(buf, 8);
    const crc = crc32(buf.subarray(4, 8 + len));
    buf.writeInt32BE(crc, 8 + len);
    return buf;
  }

  // Generate image data (scanlines with filter byte 0)
  const rawData = Buffer.alloc(height * (1 + width * 3));
  let offset = 0;
  for (let y = 0; y < height; y++) {
    rawData.writeUInt8(0, offset++); // filter 0
    for (let x = 0; x < width; x++) {
      // Draw a subtle border and red emergency center
      const inCenter = (x > width * 0.2 && x < width * 0.8 && y > height * 0.2 && y < height * 0.8);
      rawData.writeUInt8(inCenter ? 220 : r, offset++);
      rawData.writeUInt8(inCenter ? 38 : g, offset++);
      rawData.writeUInt8(inCenter ? 38 : b, offset++);
    }
  }

  const idatData = zlib.deflateSync(rawData);
  const idatChunk = makeChunk('IDAT', idatData);
  const ihdrChunk = makeChunk('IHDR', ihdrData);
  const iendChunk = makeChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([signature, ihdrChunk, idatChunk, iendChunk]);
}

// CRC32 table
const crcTable = [];
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  }
  crcTable[n] = c;
}

function crc32(buf) {
  let crc = -1;
  for (let i = 0; i < buf.length; i++) {
    crc = (crc >>> 8) ^ crcTable[(crc ^ buf[i]) & 0xff];
  }
  return crc ^ -1;
}

const outDir = path.resolve(__dirname, 'public');
fs.writeFileSync(path.join(outDir, 'icon-192.png'), createPng(192, 192, 9, 9, 11));
fs.writeFileSync(path.join(outDir, 'icon-512.png'), createPng(512, 512, 9, 9, 11));
console.log('PNG icons created successfully.');
