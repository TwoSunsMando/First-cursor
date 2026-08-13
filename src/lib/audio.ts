export function float32ToPCM16Base64(float32Array: Float32Array): string {
  const pcm16 = new Int16Array(float32Array.length);

  for (let i = 0; i < float32Array.length; i++) {
    const sample = Math.max(-1, Math.min(1, float32Array[i]));
    pcm16[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }

  const bytes = new Uint8Array(pcm16.buffer);
  let binary = "";
  const chunkSize = 0x8000;

  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }

  return btoa(binary);
}

export function base64PCM16ToFloat32(base64Audio: string): Float32Array {
  const binary = atob(base64Audio);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  const pcm16 = new Int16Array(bytes.buffer);
  const float32 = new Float32Array(pcm16.length);

  for (let i = 0; i < pcm16.length; i++) {
    float32[i] = pcm16[i] / 32768;
  }

  return float32;
}

export function supportedSampleRate(rate: number): number {
  const supported = [8000, 16000, 22050, 24000, 32000, 44100, 48000];
  if (supported.includes(rate)) {
    return rate;
  }

  return supported.reduce((closest, candidate) =>
    Math.abs(candidate - rate) < Math.abs(closest - rate) ? candidate : closest,
  );
}
