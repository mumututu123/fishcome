const encoder = new TextEncoder();

async function digestBytes(bytes) {
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}

export function jsonDigest(value) {
  return digestBytes(encoder.encode(JSON.stringify(value)));
}

export async function stepDigest(value) {
  const binary = [];
  const json = JSON.stringify(value, (_, item) => {
    if (item instanceof Map) return Array.from(item.entries());
    if (item instanceof Set) return Array.from(item);
    if (!ArrayBuffer.isView(item)) return item;
    binary.push(new Uint8Array(item.buffer, item.byteOffset, item.byteLength));
    return { binary: binary.length - 1, type: item.constructor.name, bytes: item.byteLength };
  });
  const bytes = binary.length ? await new Blob([json, ...binary]).arrayBuffer() : encoder.encode(json);
  return digestBytes(bytes);
}
