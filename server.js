import express from "express";

const app = express();
const PORT = process.env.PORT || 3000;
const TARGET_API = "https://xiamenlabs.com/api/chat/";
const TIMEOUT_MS = 120000;

// 标签常量 - 使用拼接避免渲染问题
const THINK_OPEN_TAG = String.fromCharCode(60) + "think" + String.fromCharCode(62);
const THINK_CLOSE_TAG = String.fromCharCode(60) + "/think" + String.fromCharCode(62);

app.use(express.json());

app.post("/v1/chat/completions", async (req, res) => {
  const startTime = Date.now();
  const requestId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  console.log(`[${new Date().toISOString()}] [${requestId}] New request`);

  let reader = null;
  let aborted = false;

  // 客户端断开处理
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

    // 参数校验
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({
        error: {
          message: "messages is required and must be a non-empty array",
          type: "invalid_request_error",
          param: "messages",
          code: null,
        },
      });
    }

    const targetRequest = {
      model: "x",
      messages,
      stream: true,
      ...otherParams,
    };

    // 超时控制
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

    // 非流式响应处理
    if (!stream) {
      return await handleNonStreamResponse(response, model, res, requestId, startTime);
    }

    // 流式响应处理
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
        model: model || "gpt-4",
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

    try {
      while (!aborted) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (aborted) break;
          if (!line.trim() || line === ": connected" || line.startsWith(":")) continue;

          if (line.startsWith("data: ")) {
            const data = line.slice(6).trim();

            if (data === "[DONE]") {
              closeReasoningIfNeeded();
              res.write("data: [DONE]\n\n");
              continue;
            }

            try {
              const parsed = JSON.parse(data);
              const choice = parsed.choices?.[0];

              if (!choice) continue;

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
              }
              // 处理 finish_reason
              else if (finishReason) {
                closeReasoningIfNeeded();

                const finalChunk = {
                  id: responseId,
                  object: "chat.completion.chunk",
                  created: responseCreated,
                  model: model || "gpt-4",
                  choices: [
                    {
                      index: 0,
                      delta: {},
                      finish_reason: finishReason,
                    },
                  ],
                };
                res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
              }
            } catch (e) {
              console.error(`[${requestId}] Parse error:`, e.message, "Data:", data.slice(0, 100));
            }
          }
        }
      }

      // 处理剩余 buffer
      if (!aborted && buffer.trim()) {
        if (buffer.includes("[DONE]")) {
          closeReasoningIfNeeded();
          res.write("data: [DONE]\n\n");
        }
      }
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
          error: {
            message: "Request timeout",
            type: "timeout_error",
          },
        });
      } else {
        res.status(500).json({
          error: {
            message: error.message || "Internal server error",
            type: "server_error",
          },
        });
      }
    } else {
      try {
        res.end();
      } catch (e) {
        // ignore
      }
    }
  }
});

// 非流式响应处理函数
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
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.trim() || line === ": connected" || line.startsWith(":")) continue;

        if (line.startsWith("data: ")) {
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
            console.error(`[${requestId}] Parse error:`, e.message);
          }
        }
      }
    }

    // 确保关闭 reasoning 标签
    if (isInReasoning) {
      fullContent += THINK_CLOSE_TAG;
    }

    const result = {
      id: responseId,
      object: "chat.completion",
      created: responseCreated,
      model: model || "gpt-4",
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

// 健康检查
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

// 模型列表
app.get("/v1/models", (req, res) => {
  res.json({
    object: "list",
    data: [
      {
        id: "gpt-4",
        object: "model",
        created: Math.floor(Date.now() / 1000),
        owned_by: "proxy",
      },
    ],
  });
});

// 404 处理
app.use((req, res) => {
  res.status(404).json({
    error: {
      message: `Not found: ${req.method} ${req.path}`,
      type: "not_found_error",
    },
  });
});

// 全局错误处理
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({
    error: {
      message: "Internal server error",
      type: "server_error",
    },
  });
});

app.listen(PORT, () => {
  console.log("=".repeat(50));
  console.log(`OpenAI Proxy Server Started`);
  console.log("=".repeat(50));
  console.log(`Port:     ${PORT}`);
  console.log(`Target:   ${TARGET_API}`);
  console.log(`Timeout:  ${TIMEOUT_MS / 1000}s`);
  console.log("=".repeat(50));
  console.log(`Endpoints:`);
  console.log(`  POST /v1/chat/completions`);
  console.log(`  GET  /v1/models`);
  console.log(`  GET  /health`);
  console.log("=".repeat(50));
});
