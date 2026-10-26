export async function request({
  url,
  method = "GET",
  body,
  headers,
  timeoutMs = 5_000,
}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const mergedHeaders =
      body === undefined
        ? headers
        : { "content-type": "application/json", ...headers };

    return await fetch(url, {
      method,
      signal: controller.signal,
      ...(mergedHeaders === undefined ? {} : { headers: mergedHeaders }),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } finally {
    clearTimeout(timer);
  }
}
