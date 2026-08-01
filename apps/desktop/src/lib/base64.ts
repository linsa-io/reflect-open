/** Base64-decode into raw bytes (collab update/seed payloads over JSON IPC). */
export function bytesOfBase64(encoded: string): Uint8Array {
  const binary = atob(encoded)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

/** Base64-encode raw bytes (asset writes over JSON IPC, inline image payloads). */
export function base64Of(buffer: ArrayBuffer): string {
  return base64OfBytes(new Uint8Array(buffer))
}

/** {@link base64Of} for a byte view — respects the view's offset and length. */
export function base64OfBytes(bytes: Uint8Array): string {
  let binary = ''
  // Encode in 32 KiB chunks: spreading the whole buffer into String.fromCharCode
  // would exceed the engine's argument-count limit on large images.
  const chunk = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk))
  }
  return btoa(binary)
}
