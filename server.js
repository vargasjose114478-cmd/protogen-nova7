const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = 8090;
const ROOT = __dirname;

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml"
};

/**
 * Motor 1: Qwen 3.8 27B (Sin límite de 45s por IP, ideal para conversaciones seguidas)
 */
async function callQwen27B(messages) {
  const host = "https://zk-armor-qwen3-8-27b-uncensored-chatbot.hf.space";
  const sysMsg = messages.find((m) => m.role === "system")?.content ||
    "Eres Nova-7, un Protogen muy inteligente, dulce y carismático. Responde SIEMPRE en español (100% español, sin mezclar inglés).";

  const chatTurns = messages.filter((m) => m.role !== "system");
  const contextText = chatTurns
    .slice(-6)
    .map((m) => `${m.role === "user" ? "Usuario" : "Nova-7"}: ${m.content}`)
    .join("\n");

  const finalPrompt = `${contextText}\n\n(Instrucción: Responde únicamente como Nova-7 en español natural, coherente y completo, sin repetir "Nova-7:" al inicio.)`;

  const postRes = await fetch(`${host}/gradio_api/call/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      data: [
        finalPrompt,
        sysMsg + " IMPORTANTE: Escribe el 100% de tu respuesta en español.",
        false,
        0.7,
        512,
        0.9,
        40
      ]
    }),
    signal: AbortSignal.timeout(16000)
  });

  if (!postRes.ok) throw new Error(`Qwen POST ${postRes.status}`);
  const { event_id } = await postRes.json();

  const sseRes = await fetch(`${host}/gradio_api/call/chat/${event_id}`, {
    signal: AbortSignal.timeout(18000)
  });
  if (!sseRes.ok) throw new Error(`Qwen SSE ${sseRes.status}`);

  const sseText = await sseRes.text();
  const lines = sseText.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].startsWith("data: ")) {
      try {
        const arr = JSON.parse(lines[i].slice(6));
        const chatHistory = arr?.[0];
        if (Array.isArray(chatHistory) && chatHistory.length > 0) {
          const lastMsg = chatHistory[chatHistory.length - 1];
          let text = Array.isArray(lastMsg.content)
            ? lastMsg.content.map((c) => c.text || "").join("")
            : typeof lastMsg.content === "string"
            ? lastMsg.content
            : "";
          text = text
            .replace(/<details>[\s\S]*?<\/details>/gi, "")
            .replace(/^Nova-7:\s*/i, "")
            .trim();
          if (text.length > 2) return text;
        }
      } catch (e) {}
    }
  }
  throw new Error("Empty Qwen response");
}

/**
 * Motor 2: Pollinations OpenAI 20B (Respaldo secundario)
 */
async function callPollinations20B(rawBody) {
  const aiRes = await fetch("https://text.pollinations.ai/openai", {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: rawBody,
    signal: AbortSignal.timeout(14000)
  });
  if (!aiRes.ok) throw new Error(`Pollinations ${aiRes.status}`);
  const data = await aiRes.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content || content.trim().length < 2) throw new Error("Empty Pollinations reply");
  return content.trim();
}

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(200);
    res.end();
    return;
  }

  const parsedUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = parsedUrl.pathname;

  // Endpoint Multi-Motor IA (/api/chat)
  if (pathname === "/api/chat" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk.toString("utf8");
    });

    req.on("end", async () => {
      try {
        const parsed = JSON.parse(body);
        const messages = parsed.messages || [];

        let replyText = null;
        try {
          // Intentar primero con Qwen 27B (Sin límite de 45s)
          replyText = await callQwen27B(messages);
        } catch (err1) {
          // Si Qwen tarda o falla, usar Pollinations 20B
          replyText = await callPollinations20B(body);
        }

        const responsePayload = JSON.stringify({
          choices: [{ message: { role: "assistant", content: replyText } }]
        });

        res.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store"
        });
        res.end(responsePayload, "utf8");
      } catch (err) {
        res.writeHead(502, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "AI_PROXY_ERROR", message: err.message }));
      }
    });
    return;
  }

  // Archivos estáticos
  let safePath = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.join(ROOT, decodeURIComponent(safePath));

  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("404 Not Found");
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
      "Cache-Control": "no-store, no-cache, must-revalidate"
    });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`Servidor Multi-IA (Qwen 27B + GPT-OSS 20B) activo en http://localhost:${PORT}/`);
});
