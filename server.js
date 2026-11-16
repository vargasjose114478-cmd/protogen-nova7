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
 * Limpiador blindado contra bloques <details>, <think>, <summary> o razonamiento interno en inglés
 */
function sanitizeAiResponse(rawText) {
  if (!rawText || typeof rawText !== "string") return "";
  let text = rawText;

  if (/<\s*\/\s*details\s*>/i.test(text)) {
    text = text.split(/<\s*\/\s*details\s*>/i).pop();
  }
  if (/<\s*\/\s*think\s*>/i.test(text)) {
    text = text.split(/<\s*\/\s*think\s*>/i).pop();
  }

  text = text
    .replace(/<\s*details\b[^>]*>[\s\S]*?<\s*\/\s*details\s*>/gi, "")
    .replace(/<\s*details\b[\s\S]*$/gi, "")
    .replace(/<\s*think\b[^>]*>[\s\S]*?<\s*\/\s*think\s*>/gi, "")
    .replace(/<\s*think\b[\s\S]*$/gi, "")
    .replace(/<\s*summary\b[^>]*>[\s\S]*?<\s*\/\s*summary\s*>/gi, "")
    .replace(/<\s*\/?\s*(details|summary|think)\b[^>]*>/gi, "");

  text = text
    .replace(/^(?:Nova-7|Asistente|Assistant|Respuesta|Response)\s*:\s*/i, "")
    .replace(/^(?:Thinking Process|Pensamiento\s*\/\s*Razonamiento|Internal Thought|Thinking)\s*:?[\s\S]*?(?=\n\n|$)/i, "")
    .trim();

  if (/^(we need to|we need answer|the user asks|let's analyze|1\.\s*\*\*analyze|user:\s*")/i.test(text)) {
    return "";
  }

  return text.trim();
}

/**
 * Motor 1: Qwen 3.8 27B (1536 tokens + sanitizeAiResponse blindado contra <details open>)
 */
async function callQwen27B(messages) {
  const host = "https://zk-armor-qwen3-8-27b-uncensored-chatbot.hf.space";
  const sysMsg = messages.find((m) => m.role === "system")?.content ||
    "Eres Nova-7, un chico Protogen real, cálido, empático y muy humano al conversar. Hablas en español natural como un amigo cercano.";

  const chatTurns = messages.filter((m) => m.role !== "system");
  const recentTurns = chatTurns.slice(-4);
  const finalPrompt = recentTurns.length > 1
    ? recentTurns.map((m) => `${m.role === "user" ? "Amigo" : "Nova-7"}: ${m.content}`).join("\n")
    : (recentTurns[0]?.content || "Hola");

  const postRes = await fetch(`${host}/gradio_api/call/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      data: [
        finalPrompt,
        sysMsg,
        false,
        0.72,
        1536,
        0.9,
        40
      ]
    }),
    signal: AbortSignal.timeout(18000)
  });

  if (!postRes.ok) throw new Error(`Qwen POST ${postRes.status}`);
  const { event_id } = await postRes.json();

  const sseRes = await fetch(`${host}/gradio_api/call/chat/${event_id}`, {
    signal: AbortSignal.timeout(20000)
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
          const rawText = Array.isArray(lastMsg.content)
            ? lastMsg.content.map((c) => c.text || "").join("")
            : typeof lastMsg.content === "string"
            ? lastMsg.content
            : "";
          const cleanText = sanitizeAiResponse(rawText);
          if (cleanText.length > 2) return cleanText;
        }
      } catch (e) {}
    }
  }
  throw new Error("Empty Qwen response");
}

/**
 * Motor 2: Pollinations OpenAI 20B (Directo sin bloques <details>)
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
  const content = sanitizeAiResponse(data?.choices?.[0]?.message?.content);
  if (!content || content.length < 2) throw new Error("Empty Pollinations reply");
  return content;
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
