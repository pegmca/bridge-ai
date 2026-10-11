// Quota / failure classification for the CodeBuddy upstream.
//
// CodeBuddy's chat endpoint is OpenAI-compatible and returns standard HTTP
// status codes. We treat:
//   401 / 403 -> auth problem (token expired / invalid key)
//   429       -> quota exhausted (rotate account)
//   5xx       -> transient / overloaded (short cooldown, retry)
// In-stream SSE errors (sent as a `data:` event carrying an error) are detected
// by peeking the first event before we commit the response to the client.

export const STREAM_FAILURE_CODES = new Set([
  'rate_limit_exceeded',
  'server_error',
  'server_is_overloaded',
  'overloaded_error',
  'capacity_exceeded',
  'quota_exceeded',
  'tokens_exhausted',
]);

// Map an HTTP status to a coarse class used by the rotation logic.
export function classifyStatus(status) {
  if (status === 200) return 'ok';
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'quota';
  if (status >= 500) return 'retryable';
  return 'error';
}

// Inspect a buffered chunk of an SSE stream (before any bytes are sent to the
// client) and return the first error it finds, or null if it looks healthy.
// Looks for OpenAI-style `{ "error": ... }` and Anthropic/CodeBuddy error events.
export function detectStreamError(bufferText) {
  const events = bufferText.split('\n\n');
  for (const ev of events) {
    if (!ev.trim()) continue;
    for (const line of ev.split('\n')) {
      const t = line.trim();
      if (!t.startsWith('data:')) continue;
      const payload = t.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      let json;
      try {
        json = JSON.parse(payload);
      } catch {
        continue;
      }
      if (json.error) return json.error;
      const choice = json.choices && json.choices[0];
      if (choice && (choice.finish_reason === 'error' || (choice.delta && choice.delta.error))) {
        return choice;
      }
      if (json.type && /error/.test(json.type)) return json;
      // Some providers embed an error code string in the content/event.
      const code = json.error?.code || json.code;
      if (typeof code === 'string' && STREAM_FAILURE_CODES.has(code)) return json;
    }
  }
  return null;
}
