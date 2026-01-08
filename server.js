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
          param: null,
          code: null,
        },
      });
    }

    // 非流式响应
    if (!stream) {
      return await handleNonStreamResponse(response, res, requestId, startTime);
    }

    // 流式响应
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

    const createChunk = (delta, finishReason = null) => {
      return {
        id: responseId,
        object: "chat.completion.chunk",
        created: responseCreated,
        model: "unity",
        system_fingerprint: "fp_proxy",
        choices: [
          {
            index: 0,
            delta: delta,
            logprobs: null,
            finish_reason: finishReason,
          },
        ],
      };
    };

    const sendChunk = (delta, finishReason = null) => {
      if (aborted) return false;
      try {
        const chunk = createChunk(delta, finishReason);
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        return true;
      } catch (e) {
        console.error(`[${requestId}] Write error:`, e.message);
        return false;
      }
    };

    const closeReasoningIfNeeded = () => {
      if (isInReasoning) {
        sendChunk({ content: THINK_CLOSE_TAG }, null);
        isInReasoning = false;
      }
    };

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

        // 第一个 chunk: 发送 role
        if (isFirstChunk) {
          sendChunk({ role: "assistant", content: "" }, null);
          isFirstChunk = false;
        }

        // 处理 reasoning
        if (delta.reasoning !== undefined && delta.reasoning !== null && delta.reasoning !== "") {
          let content = "";
          if (!isInReasoning) {
            content = THINK_OPEN_TAG;
            isInReasoning = true;
          }
          content += delta.reasoning;
          sendChunk({ content: content }, null);
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
          sendChunk({ content: content }, null);
          return "sent";
        }
        // 处理 finish_reason
        else if (finishReason) {
          closeReasoningIfNeeded();
          sendChunk({}, finishReason);
          return "finish";
        }

        return null;
      } catch (e) {
        console.error(`[${requestId}] Parse error:`, e.message);
        return "error";
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
          const trimmedLine = line.trim();
          if (!trimmedLine || trimmedLine.startsWith(":")) continue;

          if (trimmedLine.startsWith("data:")) {
            const data = trimmedLine.slice(5).trim();
            if (data === "[DONE]") {
              closeReasoningIfNeeded();
              res.write("data: [DONE]\n\n");
              continue;
            }
            if (data) {
              processSSEData(data);
            }
          }
        }
      }

      if (!aborted && buffer.trim()) {
        const trimmedBuffer = buffer.trim();
        if (trimmedBuffer.startsWith("data:")) {
          const data = trimmedBuffer.slice(5).trim();
          if (data === "[DONE]") {
            closeReasoningIfNeeded();
            res.write("data: [DONE]\n\n");
          } else if (data) {
            processSSEData(data);
          }
        }
      }

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
          error: { message: "Request timeout", type: "timeout_error", param: null, code: null },
        });
      } else {
        res.status(500).json({
          error: { message: error.message || "Internal server error", type: "server_error", param: null, code: null },
        });
      }
    } else {
      try { res.end(); } catch (e) {}
    }
  }
});

// 非流式响应处理 - 符合 OpenAI 官方格式
async function handleNonStreamResponse(response, res, requestId, startTime) {
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

    const lines = buffer.split("\n");

    for (const line of lines) {
      const trimmedLine = line.trim();
      if (!trimmedLine || !trimmedLine.startsWith("data:")) continue;

      const data = trimmedLine.slice(5).trim();
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

    // 符合 OpenAI 官方格式的响应
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
            refusal: null,
            annotations: [],
          },
          logprobs: null,
          finish_reason: finishReason,
        },
      ],
      usage: {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
        prompt_tokens_details: {
          cached_tokens: 0,
          audio_tokens: 0,
        },
        completion_tokens_details: {
          reasoning_tokens: 0,
          audio_tokens: 0,
          accepted_prediction_tokens: 0,
          rejected_prediction_tokens: 0,
        },
      },
      service_tier: "default",
      system_fingerprint: "fp_proxy",
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
      {
        id: "unity",
        object: "model",
        created: Math.floor(Date.now() / 1000),
        owned_by: "proxy",
      },
    ],
  });
});

app.use((req, res) => {
  res.status(404).json({
    error: { message: "Not found", type: "not_found_error", param: null, code: null },
  });
});

app.listen(PORT, () => {
  console.log(`Proxy running on port ${PORT}`);
});
