/**
 * RC4, because Node 26 no longer ships it.
 *
 * It is needed for exactly one thing: opening a CDSL CAS. The standard PDF
 * security handler at revisions 2–4 encrypts with RC4, and that is what the
 * registrars' generators still emit. Nothing else in this app uses it, and
 * nothing new should — it is here to read a file, not to protect one.
 *
 * Verified against the published RFC 6229 / Wikipedia test vectors in the
 * accompanying test, which is the only reason to trust a hand-rolled cipher.
 */

export function rc4(key: Uint8Array, data: Uint8Array): Uint8Array {
  const s = new Uint8Array(256);
  for (let i = 0; i < 256; i++) s[i] = i;

  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + s[i]! + key[i % key.length]!) & 0xff;
    [s[i], s[j]] = [s[j]!, s[i]!];
  }

  const out = new Uint8Array(data.length);
  let i = 0;
  j = 0;
  for (let n = 0; n < data.length; n++) {
    i = (i + 1) & 0xff;
    j = (j + s[i]!) & 0xff;
    [s[i], s[j]] = [s[j]!, s[i]!];
    out[n] = data[n]! ^ s[(s[i]! + s[j]!) & 0xff]!;
  }
  return out;
}
