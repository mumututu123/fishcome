const assert = require('node:assert/strict');
const { inflateRawSync } = require('node:zlib');

function zipEntry(bytes, name) {
  const end = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert(end >= 0, '文件缺少 ZIP 目录');
  let offset = bytes.readUInt32LE(end + 16);
  const entryCount = bytes.readUInt16LE(end + 10);
  for (let index = 0; index < entryCount; index++) {
    assert.equal(bytes.readUInt32LE(offset), 0x02014b50);
    const size = bytes.readUInt32LE(offset + 20);
    const filenameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const method = bytes.readUInt16LE(offset + 10);
    const local = bytes.readUInt32LE(offset + 42);
    const filename = bytes.subarray(offset + 46, offset + 46 + filenameLength).toString('utf8');
    if (filename === name) {
      const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
      const compressed = bytes.subarray(start, start + size);
      return method === 8 ? inflateRawSync(compressed) : compressed;
    }
    offset += 46 + filenameLength + extraLength + commentLength;
  }
  throw new Error('发行包缺少 ' + name);
}

module.exports = { zipEntry };
