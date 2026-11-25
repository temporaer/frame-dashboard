export async function fetchJson(url, bearer, fetcher = fetch) {
  const response = await fetcher(url, {
    headers: { authorization: `Bearer ${bearer}`, accept: 'application/json' },
    redirect: 'error',
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? 'source_unauthorized' : `source_http_${response.status}`);
  const chunks = [];
  let length = 0;
  for await (const chunk of response.body) {
    length += chunk.length;
    if (length > 2 * 1024 * 1024) {
      await response.body.cancel().catch(() => {});
      throw new Error('source_response_too_large');
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('source_invalid_json');
  }
}

export function endpoint(base, route) {
  return new URL(route, `${base.replace(/\/+$/, '')}/`);
}
