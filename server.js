import express from "express";

const app = express();
const PORT = process.env.PORT || 3000;
const TARGET_API = "https://xiamenlabs.com/api/chat/";
const TIMEOUT_MS = 120000;

const THINK_OPEN_TAG = String.fromCharCode(60) + "think" + String.fromCharCode(62);
const THINK_CLOSE_TAG = String.fromCharCode(60) + "/think" + String.fromCharCode(62);

app.use(express.json());

app.post("/v1/chat/completions", async (req, res) => {
  const startTime = Date.now();
  const requestId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  console.log(`[${new Date().toISOString()}] [${requestId}] New request`);

  let reader = null;
  let aborted = false;

  req.on("close", () => {
    if (!res.writableEnded) {
      console.log(`[${new Date().toISOString()}] [${requestId}] Client disconnected`);
      aborted = true;
      if (reader) {
        reader.cancel().catch(() => {});
      }
    }
  });

  try {
    const { model, messages, stream = true, ...otherParams } = req.body;

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({
        error: {
          message: "messages is required and must be a non-empty array",
          type: "invalid_request_error",
        },
      });
    }

    const targetRequest = {
      model: "x",
      messages,
      stream: true,
      ...otherParams,
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => {
      console.log(`[${new Date().toISOString()}] [${requestId}] Request timeout`);
      controller.abort();
    }, TIMEOUT_MS);

    let response;
    try {
      response = await fetch(TARGET_API, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "accept": "*/*",
          "accept-language": "zh-CN,zh;q=0.9,en;q=0.8,zh-TW;q=0.7",
          "content-type": "application/json",
          "priority": "u=1, i",
          "sec-ch-ua": '"Microsoft Edge";v="143", "Chromium";v="143", "Not A(Brand";v="24"',
          "sec-ch-ua-mobile": "?0",
          "sec-ch-ua-platform": '"Windows"',
          "sec-fetch-dest": "empty",
          "sec-fetch-mode": "cors",
          "sec-fetch-site": "same-origin",
          "Referer": "https://xiamenlabs.com/",
        },
        body: JSON.stringify(targetRequest),
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      const errorText = await response.text();
      console.log(`[${new Date().toISOString()}] [${requestId}] Target API error: ${response.status}`);
      return res.status(response.status).json({
        error: {
          message: "Target API request failed",
          type: "api_error",
          details: errorText,
        },
      });
    }

    if (!stream) {
      return await handleNonStreamResponse(response, model, res, requestId, startTime);
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");

    reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let isInReasoning = false;
    let isFirstChunk = true;
    let responseId = `chatcmpl-${Date.now()}`;
    let responseCreated = Math.floor(Date.now() / 1000);

    const sendChunk = (content, finishReason = null) => {
      if (aborted) return false;

      const delta = {};

      if (isFirstChunk) {
        delta.role = "assistant";
        isFirstChunk = false;
      }

      if (content !== null && content !== undefined) {
        delta.content = content;
      }

      const chunk = {
        id: responseId,
        object: "chat.completion.chunk",
        created: responseCreated,
        model: "unity",
        choices: [
          {
            index: 0,
            delta,
            finish_reason: finishReason,
          },
        ],
      };

      try {
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        return true;
      } catch (e) {
        console.error(`[${requestId}] Write error:`, e.message);
        return false;
      }
    };

    const closeReasoningIfNeeded = () => {
      if (isInReasoning) {
        sendChunk(THINK_CLOSE_TAG);
        isInReasoning = false;
      }
    };

    // 处理单个 SSE 数据
    const processSSEData = (data) => {
      if (!data || data === "[DONE]") {
        return data === "[DONE]" ? "done" : null;
      }

      try {
        const parsed = JSON.parse(data);
        const choice = parsed.choices?.[0];

        if (!choice) return null;

        if (parsed.id) responseId = parsed.id;
        if (parsed.created) responseCreated = parsed.created;

        const delta = choice.delta || {};
        const finishReason = choice.finish_reason;

        // 处理 reasoning
        if (delta.reasoning !== undefined && delta.reasoning !== null && delta.reasoning !== "") {
          let content = "";

          if (!isInReasoning) {
            content = THINK_OPEN_TAG;
            isInReasoning = true;
          }

          content += delta.reasoning;
          sendChunk(content);
          return "sent";
        }
        // 处理 content
        else if (delta.content !== undefined && delta.content !== null && delta.content !== "") {
          let content = "";

          if (isInReasoning) {
            content = THINK_CLOSE_TAG;
            isInReasoning = false;
          }

          content += delta.content;
          sendChunk(content);
          return "sent";
        }
        // 处理 finish_reason (忽略带 usage 的最终 chunk，只处理 finish_reason)
        else if (finishReason) {
          closeReasoningIfNeeded();

          const finalChunk = {
            id: responseId,
            object: "chat.completion.chunk",
            created: responseCreated,
            model: "unity",
            choices: [
              {
                index: 0,
                delta: {},
                finish_reason: finishReason,
              },
            ],
          };
          res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
          return "finish";
        }

        return null;
      } catch (e) {
        // JSON 解析失败，可能是不完整的数据，返回 null 让它继续缓冲
        console.error(`[${requestId}] Parse error:`, e.message, "Data length:", data.length);
        return "error";
      }
    };

    try {
      while (!aborted) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        
        // 按 "data: " 分割处理
        let dataStart;
        while ((dataStart = buffer.indexOf("data: ")) !== -1) {
          // 找到下一个 "data: " 或者 buffer 结尾
          const nextDataStart = buffer.indexOf("data: ", dataStart + 6);
          
          if (nextDataStart === -1) {
            // 没有下一个 data:，检查是否有完整的行（以 \n\n 结尾）
            const lineEnd = buffer.indexOf("\n\n", dataStart);
            if (lineEnd === -1) {
              // 数据不完整，等待更多数据
              break;
            }
            
            const data = buffer.slice(dataStart + 6, lineEnd).trim();
            buffer = buffer.slice(lineEnd + 2);
            
            if (data === "[DONE]") {
              closeReasoningIfNeeded();
              res.write("data: [DONE]\n\n");
              continue;
            }
            
            if (data) {
              processSSEData(data);
            }
          } else {
            // 有下一个 data:，提取当前数据
            const data = buffer.slice(dataStart + 6, nextDataStart).trim();
            buffer = buffer.slice(nextDataStart);
            
            // 移除可能的换行符
            const cleanData = data.replace(/\n+$/, "").trim();
            
            if (cleanData === "[DONE]") {
              closeReasoningIfNeeded();
              res.write("data: [DONE]\n\n");
              continue;
            }
            
            if (cleanData) {
              processSSEData(cleanData);
            }
          }
        }
      }

      // 处理剩余 buffer
      if (!aborted && buffer.trim()) {
        const remaining = buffer.trim();
        if (remaining.includes("[DONE]")) {
          closeReasoningIfNeeded();
          res.write("data: [DONE]\n\n");
        } else if (remaining.startsWith("data: ")) {
          const data = remaining.slice(6).trim();
          if (data && data !== "[DONE]") {
            processSSEData(data);
          }
        }
      }

      // 确保发送 [DONE]
      closeReasoningIfNeeded();
      
    } finally {
      if (reader) {
        reader.releaseLock();
      }
    }

    console.log(`[${new Date().toISOString()}] [${requestId}] Completed in ${Date.now() - startTime}ms`);
    res.end();

  } catch (error) {
    console.error(`[${new Date().toISOString()}] [${requestId}] Error:`, error.message);

    if (!res.headersSent) {
      if (error.name === "AbortError") {
        res.status(504).json({
          error: { message: "Request timeout", type: "timeout_error" },
        });
      } else {
        res.status(500).json({
          error: { message: error.message || "Internal server error", type: "server_error" },
        });
      }
    } else {
      try { res.end(); } catch (e) {}
    }
  }
});

async function handleNonStreamResponse(response, model, res, requestId, startTime) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let isInReasoning = false;
  let fullContent = "";
  let responseId = `chatcmpl-${Date.now()}`;
  let responseCreated = Math.floor(Date.now() / 1000);
  let finishReason = "stop";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
    }

    // 处理完整的 buffer
    const lines = buffer.split("\n");
    
    for (const line of lines) {
      if (!line.trim() || !line.startsWith("data: ")) continue;
      
      const data = line.slice(6).trim();
      if (data === "[DONE]") continue;

      try {
        const parsed = JSON.parse(data);
        const choice = parsed.choices?.[0];

        if (!choice) continue;

        if (parsed.id) responseId = parsed.id;
        if (parsed.created) responseCreated = parsed.created;

        const delta = choice.delta || {};

        if (delta.reasoning !== undefined && delta.reasoning !== null && delta.reasoning !== "") {
          if (!isInReasoning) {
            fullContent += THINK_OPEN_TAG;
            isInReasoning = true;
          }
          fullContent += delta.reasoning;
        } else if (delta.content !== undefined && delta.content !== null && delta.content !== "") {
          if (isInReasoning) {
            fullContent += THINK_CLOSE_TAG;
            isInReasoning = false;
          }
          fullContent += delta.content;
        }

        if (choice.finish_reason) {
          finishReason = choice.finish_reason;
        }
      } catch (e) {
        // 忽略解析错误
      }
    }

    if (isInReasoning) {
      fullContent += THINK_CLOSE_TAG;
    }

    const result = {
      id: responseId,
      object: "chat.completion",
      created: responseCreated,
      model: "unity",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: fullContent,
          },
          finish_reason: finishReason,
        },
      ],
      usage: {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
      },
    };

    console.log(`[${new Date().toISOString()}] [${requestId}] Non-stream completed in ${Date.now() - startTime}ms`);
    res.json(result);

  } finally {
    reader.releaseLock();
  }
}

app.get("/health", (req, res) => {
  res.json({ status: "ok", uptime: process.uptime() });
});

app.get("/v1/models", (req, res) => {
  res.json({
    object: "list",
    data: [
      { id: "unity", object: "model", created: Math.floor(Date.now() / 1000), owned_by: "proxy" },
    ],
  });
});

app.use((req, res) => {
  res.status(404).json({ error: { message: "Not found", type: "not_found_error" } });
});

app.listen(PORT, () => {
  console.log(`Proxy running on port ${PORT}`);
});
