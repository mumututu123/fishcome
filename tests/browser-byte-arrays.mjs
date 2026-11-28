// Model the negotiated browser byte APIs in the protocol tests on Node 22.
// Other test files run in their own Node process and retain its native offer.
if (!Uint8Array.prototype.toBase64) {
  Object.defineProperty(Uint8Array.prototype, 'toBase64', {
    configurable: true, value() { return Buffer.from(this).toString('base64'); }
  });
}
if (!Uint8Array.fromBase64) {
  Object.defineProperty(Uint8Array, 'fromBase64', {
    configurable: true,
    value(text, options) {
      const bytes = Buffer.from(text, 'base64');
      if (options?.lastChunkHandling === 'strict' && bytes.toString('base64') !== text) throw new SyntaxError('无效的 Base64 数据');
      return new Uint8Array(bytes);
    }
  });
}
