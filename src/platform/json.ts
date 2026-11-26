export async function readJson(response: Response, maximumBytes: number): Promise<unknown> {
  if (!response.body) throw new Error('Response body is missing.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let data = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return JSON.parse(data + decoder.decode());
      bytes += value.byteLength;
      if (bytes > maximumBytes) throw new Error('Response exceeds the size limit.');
      data += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
