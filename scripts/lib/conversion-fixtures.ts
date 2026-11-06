import { createCipheriv } from 'node:crypto';

export const expectedPixels = Buffer.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255]);
export function bitmapFixture(): Buffer {
  const bytes = Buffer.alloc(70);
  bytes.write('BM'); bytes.writeUInt32LE(70, 2); bytes.writeUInt32LE(54, 10); bytes.writeUInt32LE(40, 14);
  bytes.writeInt32LE(2, 18); bytes.writeInt32LE(2, 22); bytes.writeUInt16LE(1, 26); bytes.writeUInt16LE(24, 28); bytes.writeUInt32LE(16, 34);
  Buffer.from([255, 0, 0, 255, 255, 255, 0, 0, 0, 0, 255, 0, 255, 0, 0, 0]).copy(bytes, 54);
  return bytes;
}

// Independently generated PDF with a Unicode map; no personal document or font
// file is copied into the repository. Text extraction must preserve these glyphs.
export function chinesePdfFixture(): Buffer {
  const text = 'BT /F1 18 Tf 40 160 Td <4E2D65876D4B8BD5> Tj ET';
  const cmap = '/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def /CMapName /Fixture def /CMapType 2 def 1 begincodespacerange <0000> <FFFF> endcodespacerange 4 beginbfchar <4E2D> <4E2D> <6587> <6587> <6D4B> <6D4B> <8BD5> <8BD5> endbfchar endcmap CMapName currentdict /CMap defineresource pop end end';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 6 0 R >>',
    '<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /DescendantFonts [5 0 R] /ToUnicode 7 0 R >>',
    '<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 4 >> /DW 1000 >>',
    `<< /Length ${Buffer.byteLength(text)} >>\nstream\n${text}\nendstream`,
    `<< /Length ${Buffer.byteLength(cmap)} >>\nstream\n${cmap}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n'; const offsets = [0];
  for (const [index, object] of objects.entries()) { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; }
  const start = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
  return Buffer.from(pdf);
}

export function ncmFixture(audio: Buffer): Buffer {
  const key = Buffer.from(Array.from({ length: 16 }, (_, index) => index + 1));
  const cipher = createCipheriv('aes-128-ecb', Buffer.from('hzHRAmso5kInbaxW'), null);
  const masked = Buffer.concat([cipher.update(Buffer.concat([Buffer.from('neteasecloudmusic'), key])), cipher.final()]).map(byte => byte ^ 0x64);
  const box = Uint8Array.from({ length: 256 }, (_, index) => index); let last = 0;
  for (let index = 0; index < 256; index++) { const current = box[index]; const next = (current + last + key[index % key.length]) & 255; box[index] = box[next]; box[next] = current; last = next; }
  const payload = Buffer.from(audio);
  for (let index = 0; index < payload.length; index++) { const value = (index + 1) & 255; payload[index] ^= box[(box[value] + box[(box[value] + value) & 255]) & 255]; }
  const length = Buffer.alloc(4); length.writeUInt32LE(masked.length);
  return Buffer.concat([Buffer.from('CTENFDAM'), Buffer.alloc(2), length, masked, Buffer.alloc(17), payload]);
}

export function audioFixtures() {
  const info = Buffer.alloc(34); info.writeUInt16BE(16, 0); info.writeUInt16BE(4096, 2);
  info.writeBigUInt64BE((44100n << 44n) | (1n << 41n) | (15n << 36n), 10);
  return [
    { extension: 'mp3', bytes: Buffer.from('ID3\x04\x00\x00\x00\x00\x00\x00synthetic-audio') },
    { extension: 'flac', bytes: Buffer.concat([Buffer.from('fLaC'), Buffer.from([128, 0, 0, 34]), info]) },
  ];
}
