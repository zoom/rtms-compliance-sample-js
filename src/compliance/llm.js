/**
 * Minimal client for any OpenAI-compatible chat completions endpoint.
 *
 * Defaults to OpenRouter. Anthropic, OpenAI, and most self-hosted gateways
 * expose the same shape, so switching providers is two environment variables.
 *
 * Returns raw text. Parsing is adjudicate.js's job, because it also has to
 * handle the failure paths.
 */

export function createLlmClient({ baseUrl, apiKey, model, fetchImpl = globalThis.fetch }) {
  return async function complete(prompt) {
    // Omit the header entirely when there is no key. OpenRouter serves free
    // models unauthenticated, and sending "Bearer undefined" would turn that
    // into a 401 that looks like a broken key rather than an absent one.
    const headers = { 'content-type': 'application/json' };
    if (apiKey) headers.authorization = `Bearer ${apiKey}`;

    const response = await fetchImpl(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        // Low temperature: a compliance verdict should not vary run to run
        // more than it has to.
        temperature: 0,
        response_format: { type: 'json_object' },
      }),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`LLM request failed: ${response.status} ${detail.slice(0, 200)}`);
    }

    const body = await response.json();
    const content = body?.choices?.[0]?.message?.content;

    if (typeof content !== 'string') {
      throw new Error('LLM response contained no message content');
    }

    return content;
  };
}
