const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export function localModelUrl(value = 'http://127.0.0.1:11434') {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !LOOPBACK_HOSTS.has(url.hostname) || url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw new Error('The model must use a local HTTP Ollama endpoint.');
  }
  return url;
}

// This adapter uses local compute only. It does not support billable providers.
export function createOllamaModel({ url, name, fetchImpl = globalThis.fetch } = {}) {
  const endpoint = localModelUrl(url);
  if (typeof name !== 'string' || !/^[a-zA-Z0-9_.:/-]{1,120}$/.test(name)) {
    throw new Error('Set LUCY_MODEL_NAME to an installed local Ollama model.');
  }
  return async ({ prompt, signal }) => {
    if (typeof prompt !== 'string' || prompt.length > 24000) throw new Error('Model prompt exceeds its limit.');
    const response = await fetchImpl(new URL('/api/generate', endpoint), {
      method: 'POST', redirect: 'error', signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: name, prompt, stream: false, format: 'json', options: { num_predict: 256, temperature: 0.3 } }),
    });
    if (!response.ok) throw new Error('Local model request failed.');
    const input = await response.text();
    if (input.length > 64000) throw new Error('Local model response exceeds its limit.');
    const data = JSON.parse(input);
    if (typeof data.response !== 'string' || data.response.length > 4096) throw new Error('Local model returned an invalid response.');
    return data.response;
  };
}
