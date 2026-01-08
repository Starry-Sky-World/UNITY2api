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
  
  console.log(`[${requestId}] ========== NEW REQUEST ==========`);
  
  const { model, messages, stream, ...otherParams } = req.body;
  const isStream = stream !== false;
  
  console.log(`[${requestId}] Stream mode:`, isStream);

  let reader = null;
  let aborted = false;

  req.on("close", () => {
    if (!res.writableEnded) {
      console.log(`[${requestId}] Client disconnected`);
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

    // ★★★ 关键修复：先发送响应头，让客户端知道连接已建立 ★★★
    if (isStream) {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders();
      console.log(`[${requestId}] SSE headers sent to client`);
    }

    const targetRequest = {
      model: "x",
      messages,
      stream: true,
      ...otherParams,
    };

    console.log(`[${requestId}] Requesting target API...`);

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

    console.log(`[${requestId}] Target API status:`, response.status);

    if (!response.ok) {
      const errorText = await response.text();
      console.log(`[${requestId}] Target API error:`, errorText);
      
      if (isStream) {
        // 流模式下发送错误
        const errorChunk = {
          id: `chatcmpl-${Date.now()}`,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: "unity",
          choices: [{
            index: 0,
            delta: { content: `Error: ${response.status}` },
            finish_reason: "stop",
          }],
        };
        res.write(`data: ${JSON.stringify(errorChunk)}\n\n`);
        res.write("data: [DONE]\n\n");
        return res.end();
      } else {
        return res.status(response.status).json({
          error: { message: "Target API request failed", type: "api_error" },
        });
      }
    }

    // 非流式响应
    if (!isStream) {
      return await handleNonStreamResponse(response, res, requestId);
    }

    // 流式响应处理
    if (aborted) {
      console.log(`[${requestId}] Client already disconnected, skipping`);
      return;
    }

    reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let isInReasoning = false;
    let isFirstChunk = true;
    let responseId = `chatcmpl-${Date.now()}`;
    let responseCreated = Math.floor(Date.now() / 1000);

    const createChunk = (delta, finishReason = null) => ({
      id: responseId,
      object: "chat.completion.chunk",
      created: responseCreated,
      model: "unity",
      system_fingerprint: "fp_proxy",
      choices: [{
        index: 0,
        delta: delta,
        logprobs: null,
        finish_reason: finishReason,
      }],
    });

    const sendChunk = (delta, finishReason = null) => {
      if (aborted) return false;
      try {
        res.write(`data: ${JSON.stringify(createChunk(delta, finishReason))}\n\n`);
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

    console.log(`[${requestId}] Reading stream...`);

    try {
      while (!aborted) {
        const { done, value } = await reader.read();
        if (done) {
          console.log(`[${requestId}] Stream done`);
          break;
        }

        buffer += decoder.decode(value, { stream: true });

        let eventEnd;
        while ((eventEnd = buffer.indexOf("\n\n")) !== -1) {
          const event = buffer.substring(0, eventEnd);
          buffer = buffer.substring(eventEnd + 2);

          for (const line of event.split("\n")) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith(":")) continue;

            if (trimmed.startsWith("data:")) {
              const data = trimmed.substring(5).trim();
              
              if (data === "[DONE]") {
                closeReasoningIfNeeded();
                res.write("data: [DONE]\n\n");
                continue;
              }

              if (!data) continue;

              try {
                const parsed = JSON.parse(data);
                const choice = parsed.choices?.[0];
                if (!choice) continue;

                if (parsed.id) responseId = parsed.id;
                if (parsed.created) responseCreated = parsed.created;

                const delta = choice.delta || {};
                const finishReason = choice.finish_reason;

                if (isFirstChunk) {
                  sendChunk({ role: "assistant", content: "" }, null);
                  isFirstChunk = false;
                }

                if (delta.reasoning) {
                  let content = "";
                  if (!isInReasoning) {
                    content = THINK_OPEN_TAG;
                    isInReasoning = true;
                  }
                  content += delta.reasoning;
                  sendChunk({ content }, null);
                } else if (delta.content) {
                  let content = "";
                  if (isInReasoning) {
                    content = THINK_CLOSE_TAG;
                    isInReasoning = false;
                  }
                  content += delta.content;
                  sendChunk({ content }, null);
                } else if (finishReason) {
                  closeReasoningIfNeeded();
                  sendChunk({}, finishReason);
                }
              } catch (e) {
                console.error(`[${requestId}] Parse error:`, e.message);
              }
            }
          }
        }
      }

      closeReasoningIfNeeded();

    } finally {
      reader?.releaseLock();
    }

    console.log(`[${requestId}] Completed in ${Date.now() - startTime}ms`);
    res.end();

  } catch (error) {
    console.error(`[${requestId}] Error:`, error.message);

    if (!res.headersSent) {
      res.status(500).json({
        error: { message: error.message, type: "server_error" },
      });
    } else if (!res.writableEnded) {
      res.end();
    }
  }
});

async function handleNonStreamResponse(response, res, requestId) {
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

    for (const event of buffer.split("\n\n")) {
      for (const line of event.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;

        const data = trimmed.substring(5).trim();
        if (!data || data === "[DONE]") continue;

        try {
          const parsed = JSON.parse(data);
          const choice = parsed.choices?.[0];
          if (!choice) continue;

          if (parsed.id) responseId = parsed.id;
          if (parsed.created) responseCreated = parsed.created;

          const delta = choice.delta || {};

          if (delta.reasoning) {
            if (!isInReasoning) {
              fullContent += THINK_OPEN_TAG;
              isInReasoning = true;
            }
            fullContent += delta.reasoning;
          } else if (delta.content) {
            if (isInReasoning) {
              fullContent += THINK_CLOSE_TAG;
              isInReasoning = false;
            }
            fullContent += delta.content;
          }

          if (choice.finish_reason) finishReason = choice.finish_reason;
        } catch (e) {}
      }
    }

    if (isInReasoning) fullContent += THINK_CLOSE_TAG;

    res.json({
      id: responseId,
      object: "chat.completion",
      created: responseCreated,
      model: "unity",
      choices: [{
        index: 0,
        message: { role: "assistant", content: fullContent, refusal: null, annotations: [] },
        logprobs: null,
        finish_reason: finishReason,
      }],
      usage: {
        prompt_tokens: 0, completion_tokens: 0, total_tokens: 0,
        prompt_tokens_details: { cached_tokens: 0, audio_tokens: 0 },
        completion_tokens_details: { reasoning_tokens: 0, audio_tokens: 0, accepted_prediction_tokens: 0, rejected_prediction_tokens: 0 },
      },
      service_tier: "default",
      system_fingerprint: "fp_proxy",
    });

  } finally {
    reader.releaseLock();
  }
}

app.get("/health", (req, res) => res.json({ status: "ok" }));

app.get("/v1/models", (req, res) => {
  res.json({
    object: "list",
    data: [{ id: "unity", object: "model", created: Math.floor(Date.now() / 1000), owned_by: "proxy" }],
  });
});

app.listen(PORT, () => console.log(`Proxy running on port ${PORT}`));
