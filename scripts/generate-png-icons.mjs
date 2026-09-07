import fs from 'fs';
import zlib from 'zlib';

function createCRC32Table() {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c;
  }
  return table;
}

const crcTable = createCRC32Table();

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = crcTable[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function writePNG(width, height, isMaskable = false) {
  const bytesPerPixel = 4; // RGBA
  const scanlineLength = width * bytesPerPixel;
  const rawData = Buffer.alloc(height * (scanlineLength + 1));

  // Colors
  const bgR = 4, bgG = 120, bgB = 87; // #047857 Emerald
  const darkBgR = 6, darkBgG = 78, darkBgB = 59; // #064e3b
  const goldR = 217, goldG = 119, goldB = 6; // #d97706 Gold
  const white = 255;

  const margin = isMaskable ? 0.20 : 0.15;
  const bookX1 = Math.round(width * margin);
  const bookX2 = Math.round(width * (1 - margin));
  const bookY1 = Math.round(height * margin);
  const bookY2 = Math.round(height * (1 - margin));

  for (let y = 0; y < height; y++) {
    const rowOffset = y * (scanlineLength + 1);
    rawData[rowOffset] = 0; // Filter type 0: None

    for (let x = 0; x < width; x++) {
      const px = rowOffset + 1 + x * bytesPerPixel;

      // Check if inside book
      const inBook = x >= bookX1 && x <= bookX2 && y >= bookY1 && y <= bookY2;
      const inSpine = inBook && x <= bookX1 + Math.round((bookX2 - bookX1) * 0.16);
      const inRibbon = inBook && x >= Math.round(bookX1 + (bookX2 - bookX1) * 0.65) &&
                       x <= Math.round(bookX1 + (bookX2 - bookX1) * 0.8) &&
                       y <= Math.round(bookY1 + (bookY2 - bookY1) * 0.35);

      if (inRibbon) {
        rawData[px] = goldR;
        rawData[px + 1] = goldG;
        rawData[px + 2] = goldB;
        rawData[px + 3] = 255;
      } else if (inSpine) {
        rawData[px] = 6;
        rawData[px + 1] = 95;
        rawData[px + 2] = 70;
        rawData[px + 3] = 255;
      } else if (inBook) {
        // Book page
        rawData[px] = 250;
        rawData[px + 1] = 250;
        rawData[px + 2] = 250;
        rawData[px + 3] = 255;
      } else {
        // Emerald gradient background
        const gradT = y / height;
        rawData[px] = Math.round(bgR * (1 - gradT) + darkBgR * gradT);
        rawData[px + 1] = Math.round(bgG * (1 - gradT) + darkBgG * gradT);
        rawData[px + 2] = Math.round(bgB * (1 - gradT) + darkBgB * gradT);
        rawData[px + 3] = 255;
      }
    }
  }

  // Deflate IDAT
  const compressed = zlib.deflateSync(rawData);

  // Build PNG chunks
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  // IHDR chunk
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8; // Bit depth: 8
  ihdrData[9] = 6; // Color type: 6 (RGBA)
  ihdrData[10] = 0; // Compression method
  ihdrData[11] = 0; // Filter method
  ihdrData[12] = 0; // Interlace method

  const ihdr = makeChunk('IHDR', ihdrData);
  const idat = makeChunk('IDAT', compressed);
  const iend = makeChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([signature, ihdr, idat, iend]);
}

function makeChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const len = data.length;
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(len, 0);

  const crcBuf = Buffer.alloc(4);
  const toHash = Buffer.concat([typeBuf, data]);
  const c = crc32(toHash);
  crcBuf.writeUInt32BE(c, 0);

  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

// Generate all required icons
fs.writeFileSync('./public/pwa-192x192.png', writePNG(192, 192, false));
fs.writeFileSync('./public/pwa-512x512.png', writePNG(512, 512, false));
fs.writeFileSync('./public/pwa-maskable-512x512.png', writePNG(512, 512, true));
fs.writeFileSync('./public/apple-touch-icon.png', writePNG(180, 180, false));
fs.writeFileSync('./public/favicon.ico', writePNG(64, 64, false));

console.log('PWA icons successfully generated!');
