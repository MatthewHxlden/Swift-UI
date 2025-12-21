export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "method not allowed" });
    return;
  }

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    const { stream, ...payload } = body || {};

    const upstream = await fetch("https://api.venice.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": `Bearer ${process.env.VENICE_API_KEY}`,
      },
      body: JSON.stringify({ ...payload, stream: !!stream }),
    });

    if (!upstream.ok) {
      const text = await upstream.text().catch(() => "");
      res.status(upstream.status).send(text || `upstream failed (${upstream.status})`);
      return;
    }

    // non-stream: just proxy json
    if (!stream) {
      const data = await upstream.json();
      res.status(200).json(data);
      return;
    }

    // stream: convert upstream stream to SSE with {"type":"delta","text":""}
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "connection": "keep-alive",
    });

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // venice/openai-style streams come as lines: data: {...}\n\n
      // we parse each line and re-emit only deltas
      let idx;
      while ((idx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, idx).trimEnd();
        buffer = buffer.slice(idx + 1);

        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;

        try {
          const json = JSON.parse(data);
          const delta = json?.choices?.[0]?.delta?.content;
          const text =
            typeof delta === "string"
              ? delta
              : Array.isArray(delta)
              ? delta.map(p => (typeof p === "string" ? p : (p?.text || ""))).join("")
              : (delta?.text || "");

          if (text) {
            res.write(`data: ${JSON.stringify({ type: "delta", text })}\n\n`);
          }
        } catch {
          // ignore parse errors
        }
      }
    }

    res.write(`data: ${JSON.stringify({ type: "done" })}\n\n`);
    res.end();
  } catch (e) {
    res.status(500).json({ error: "server error", detail: String(e) });
  }
}
