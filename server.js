import express from "express";

const app = express();
const PORT = process.env.PORT || 3000;
const TARGET_API = "https://xiamenlabs.com/api/chat/";

const THINK_OPEN_TAG = String.fromCharCode(60) + "think" + String.fromCharCode(62);
const THINK_CLOSE_TAG = String.fromCharCode(60) + "/think" + String.fromCharCode(62);

app.use(express.json());

app.post("/v1/chat/completions", async (req, res) => {
  try {
    const { model, messages, stream, ...otherParams } = req.body;
    
    // ★ 调试：打印 stream 的实际值和类型
    console.log("stream value:", stream, "type:", typeof stream);
    
    // ★ 修复：正确判断 stream 参数（处理字符串 "false" 的情况）
    const isStream = stream !== false && stream !== "false";
    console.log("isStream:", isStream);

    const targetRequest = {
      model: "x",
      messages,
      stream: true,
      ...otherParams,
    };

    const response = await fetch(TARGET_API, {
      method: "POST",
      headers: {
        accept: "*/*",
        "accept-language": "zh-CN,zh;q=0.9,en;q=0.8,zh-TW;q=0.7",
        "content-type": "application/json",
        priority: "u=1, i",
        "sec-ch-ua": '"Microsoft Edge";v="143", "Chromium";v="143", "Not A(Brand";v="24"',
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"Windows"',
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "same-origin",
        Referer: "https://xiamenlabs.com/",
      },
      body: JSON.stringify(targetRequest),
    });

    if (!response.ok) {
      return res.status(response.status).json({ error: "Target API request failed" });
    }

    // ★★★ 非流式响应 ★★★
    if (!isStream) {
      console.log("Handling non-stream response...");
      
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let isInReasoning = false;
      let fullContent = "";
      let responseId = `chatcmpl-${Date.now()}`;
      let responseCreated = Math.floor(Date.now() / 1000);
      let finishReason = "stop";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
      }

      console.log("Raw buffer length:", buffer.length);

      const lines = buffer.split("\n");
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();
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
        } catch (e) {
          console.error("Parse error in non-stream:", e.message);
        }
      }

      if (isInReasoning) fullContent += THINK_CLOSE_TAG;

      console.log("Sending non-stream JSON response, content length:", fullContent.length);

      // ★ 返回纯 JSON，不是 SSE
      return res.json({
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
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0,
          prompt_tokens_details: { cached_tokens: 0, audio_tokens: 0 },
          completion_tokens_details: { reasoning_tokens: 0, audio_tokens: 0, accepted_prediction_tokens: 0, rejected_prediction_tokens: 0 },
        },
        service_tier: "default",
        system_fingerprint: "fp_proxy",
      });
    }

    // ★★★ 流式响应 ★★★
    console.log("Handling stream response...");
    
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let isInReasoning = false;
    let isFirstChunk = true;
    let responseId = `chatcmpl-${Date.now()}`;
    let responseCreated = Math.floor(Date.now() / 1000);

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.trim() || line === ": connected") continue;

        if (line.startsWith("data: ")) {
          const data = line.slice(6);

          if (data === "[DONE]") {
            if (isInReasoning) {
              const chunk = {
                id: responseId,
                object: "chat.completion.chunk",
                created: responseCreated,
                model: "unity",
                system_fingerprint: "fp_proxy",
                choices: [{ index: 0, delta: { content: THINK_CLOSE_TAG }, logprobs: null, finish_reason: null }],
              };
              res.write(`data: ${JSON.stringify(chunk)}\n\n`);
              isInReasoning = false;
            }
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

            if (isFirstChunk) {
              const firstChunk = {
                id: responseId,
                object: "chat.completion.chunk",
                created: responseCreated,
                model: "unity",
                system_fingerprint: "fp_proxy",
                choices: [{ index: 0, delta: { role: "assistant", content: "" }, logprobs: null, finish_reason: null }],
              };
              res.write(`data: ${JSON.stringify(firstChunk)}\n\n`);
              isFirstChunk = false;
            }

            if (delta.reasoning) {
              let content = "";
              if (!isInReasoning) {
                content = THINK_OPEN_TAG;
                isInReasoning = true;
              }
              content += delta.reasoning;

              const chunk = {
                id: responseId,
                object: "chat.completion.chunk",
                created: responseCreated,
                model: "unity",
                system_fingerprint: "fp_proxy",
                choices: [{ index: 0, delta: { content }, logprobs: null, finish_reason: null }],
              };
              res.write(`data: ${JSON.stringify(chunk)}\n\n`);
            }
            else if (delta.content) {
              let content = "";
              if (isInReasoning) {
                content = THINK_CLOSE_TAG;
                isInReasoning = false;
              }
              content += delta.content;

              const chunk = {
                id: responseId,
                object: "chat.completion.chunk",
                created: responseCreated,
                model: "unity",
                system_fingerprint: "fp_proxy",
                choices: [{ index: 0, delta: { content }, logprobs: null, finish_reason: null }],
              };
              res.write(`data: ${JSON.stringify(chunk)}\n\n`);
            }
            else if (finishReason) {
              if (isInReasoning) {
                const closeChunk = {
                  id: responseId,
                  object: "chat.completion.chunk",
                  created: responseCreated,
                  model: "unity",
                  system_fingerprint: "fp_proxy",
                  choices: [{ index: 0, delta: { content: THINK_CLOSE_TAG }, logprobs: null, finish_reason: null }],
                };
                res.write(`data: ${JSON.stringify(closeChunk)}\n\n`);
                isInReasoning = false;
              }

              const finalChunk = {
                id: responseId,
                object: "chat.completion.chunk",
                created: responseCreated,
                model: "unity",
                system_fingerprint: "fp_proxy",
                choices: [{ index: 0, delta: {}, logprobs: null, finish_reason: finishReason }],
              };
              res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
            }
          } catch (e) {
            console.error("Parse error:", e.message);
          }
        }
      }
    }

    res.end();
  } catch (error) {
    console.error("Proxy error:", error);
    if (!res.headersSent) {
      res.status(500).json({ error: "Proxy error", message: error.message });
    }
  }
});

app.get("/health", (req, res) => res.json({ status: "ok" }));

app.get("/v1/models", (req, res) => {
  res.json({
    object: "list",
    data: [{ id: "unity", object: "model", created: Math.floor(Date.now() / 1000), owned_by: "proxy" }],
  });
});

app.listen(PORT, () => console.log(`Proxy running on port ${PORT}`));
