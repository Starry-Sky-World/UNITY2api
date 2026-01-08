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
  
  // 打印完整请求信息
  console.log(`[${requestId}] ========== NEW REQUEST ==========`);
  console.log(`[${requestId}] Body:`, JSON.stringify(req.body, null, 2));
  
  const { model, messages, stream, ...otherParams } = req.body;
  const isStream = stream !== false; // 默认 true
  
  console.log(`[${requestId}] Stream mode:`, isStream);

  let reader = null;
  let aborted = false;

  req.on("close", () => {
    if (!res.writableEnded) {
      console.log(`[${requestId}] Client disconnected (aborted)`);
      aborted = true;
      if (reader) {
        reader.cancel().catch(() => {});
      }
    }
  });

  try {
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

    console.log(`[${requestId}] Sending to target API...`);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

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

    console.log(`[${requestId}] Target API response status:`, response.status);
    console.log(`[${requestId}] Target API response headers:`, Object.fromEntries(response.headers.entries()));

    if (!response.ok) {
      const errorText = await response.text();
      console.log(`[${requestId}] Target API error body:`, errorText);
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
    if (!isStream) {
      console.log(`[${requestId}] Handling non-stream response...`);
      return await handleNonStreamResponse(response, res, requestId, startTime);
    }

    // 流式响应
    console.log(`[${requestId}] Setting SSE headers...`);
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders(); // 立即发送 headers

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
        const data = `data: ${JSON.stringify(chunk)}\n\n`;
        console.log(`[${requestId}] Sending chunk:`, data.substring(0, 150));
        res.write(data);
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

      console.log(`[${requestId}] Processing SSE data:`, data.substring(0, 200));

      let parsed;
      try {
        parsed = JSON.parse(data);
      } catch (e) {
        console.error(`[${requestId}] JSON parse error:`, e.message);
        console.error(`[${requestId}] Failed data:`, data);
        return "error";
      }

      const choice = parsed.choices?.[0];
      if (!choice) {
        console.log(`[${requestId}] No choice in parsed data`);
        return null;
      }

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
    };

    console.log(`[${requestId}] Starting to read stream...`);

    try {
      while (!aborted) {
        const { done, value } = await reader.read();
        
        if (done) {
          console.log(`[${requestId}] Stream ended (done=true)`);
          break;
        }

        const chunk = decoder.decode(value, { stream: true });
        console.log(`[${requestId}] Received chunk (${chunk.length} bytes):`, chunk.substring(0, 100));
        
        buffer += chunk;

        // 使用双换行符分割 SSE 事件
        let eventEnd;
        while ((eventEnd = buffer.indexOf("\n\n")) !== -1) {
          const event = buffer.substring(0, eventEnd);
          buffer = buffer.substring(eventEnd + 2);

          const lines = event.split("\n");
          for (const line of lines) {
            const trimmedLine = line.trim();
            if (!trimmedLine || trimmedLine.startsWith(":")) continue;

            if (trimmedLine.startsWith("data:")) {
              const data = trimmedLine.substring(5).trim();
              if (data === "[DONE]") {
                console.log(`[${requestId}] Received [DONE]`);
                closeReasoningIfNeeded();
                res.write("data: [DONE]\n\n");
              } else if (data) {
                processSSEData(data);
              }
            }
          }
        }
      }

      // 处理剩余 buffer
      if (!aborted && buffer.trim()) {
        console.log(`[${requestId}] Processing remaining buffer:`, buffer);
        const lines = buffer.split("\n");
        for (const line of lines) {
          const trimmedLine = line.trim();
          if (trimmedLine.startsWith("data:")) {
            const data = trimmedLine.substring(5).trim();
            if (data === "[DONE]") {
              closeReasoningIfNeeded();
              res.write("data: [DONE]\n\n");
            } else if (data) {
              processSSEData(data);
            }
          }
        }
      }

      closeReasoningIfNeeded();

    } finally {
      if (reader) {
        reader.releaseLock();
      }
    }

    console.log(`[${requestId}] Completed in ${Date.now() - startTime}ms`);
    res.end();

  } catch (error) {
    console.error(`[${requestId}] Error:`, error);

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

// 非流式响应
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

    console.log(`[${requestId}] Non-stream buffer length:`, buffer.length);
    console.log(`[${requestId}] Non-stream first 500 chars:`, buffer.substring(0, 500));

    const events = buffer.split("\n\n");

    for (const event of events) {
      const lines = event.split("\n");
      
      for (const line of lines) {
        const trimmedLine = line.trim();
        if (!trimmedLine || trimmedLine.startsWith(":")) continue;

        if (trimmedLine.startsWith("data:")) {
          const data = trimmedLine.substring(5).trim();
          if (!data || data === "[DONE]") continue;

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
            console.error(`[${requestId}] Non-stream parse error:`, e.message);
          }
        }
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

    console.log(`[${requestId}] Sending non-stream response, content length:`, fullContent.length);
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
  res.status(404).json({
    error: { message: "Not found", type: "not_found_error", param: null, code: null },
  });
});

app.listen(PORT, () => {
  console.log(`Proxy running on port ${PORT}`);
});
