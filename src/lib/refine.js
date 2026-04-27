import { config } from "../config.js";
import { httpFetch } from "./http.js";

const modes = {
  chat: "把口述整理成适合发给 AI 助手或协作对象的清晰指令。保留意图、约束和上下文，去掉口头停顿，让文本更像经过思考后的输入。",
  formal: "把口述整理成正式、自然、可直接发送的中文文本。改善断句、标点和语序，但不要扩写事实。",
  bullet: "把口述整理成结构化要点。适合计划、需求、会议纪要或任务拆解。",
  email: "把口述整理成礼貌、清晰、可发送的邮件或消息。不要编造称呼、事实或承诺。",
  verbatim: "尽量保留原话，只修正明显识别错误、标点、空白和重复口头词。"
};

export function getRefineStatus() {
  const provider = resolveRefineProvider();
  return {
    provider,
    model: provider === "ollama" ? config.refine.ollamaModel : config.refine.llmModel,
    openaiCompatibleConfigured: Boolean(config.refine.llmApiKey),
    volcengineConfigured: config.refine.volcengineConfigured,
    ollamaBaseUrl: config.refine.ollamaBaseUrl
  };
}

export async function refineTranscript({ rawText, mode = "chat", contextHint = "", history = [] }) {
  const normalized = String(rawText || "").trim();
  if (!normalized) return "";

  const provider = resolveRefineProvider();
  if (provider === "none") return normalized;
  if (provider === "rules") return ruleBasedCleanup(normalized, mode);

  const messages = buildMessages({ rawText: normalized, mode, contextHint, history });

  try {
    if (provider === "ollama") {
      return await refineWithOllama(messages);
    }
    return await refineWithOpenAICompatible(messages);
  } catch (error) {
    console.warn("Refinement provider failed, using rule fallback:", error.message);
    return ruleBasedCleanup(normalized, mode);
  }
}

function resolveRefineProvider() {
  if (config.refine.provider === "volcengine") return config.refine.llmApiKey ? "volcengine" : "rules";
  if (config.refine.provider === "openai") return config.refine.llmApiKey ? "openai" : "rules";
  if (config.refine.provider === "ollama") return "ollama";
  if (config.refine.provider === "rules") return "rules";
  if (config.refine.provider === "none") return "none";
  if (config.refine.volcengineConfigured) return "volcengine";
  if (config.refine.llmApiKey) return "openai";
  return "rules";
}

function buildMessages({ rawText, mode, contextHint, history }) {
  const recent = history
    .slice(0, 6)
    .map((item, index) => `${index + 1}. ${item.refined || item.raw}`)
    .join("\n");

  const modeInstruction = modes[mode] || modes.chat;

  return [
    {
      role: "system",
      content: [
        "你是一个中文语音输入后处理器。",
        "你的任务是把语音转写稿整理成用户真正想输入到电脑光标处的文本。",
        "只输出最终文本，不要解释，不要回答用户的问题，不要添加原文没有表达的新事实。",
        "优先修正中文断句、标点、ASR 同音误识别、重复口头词、无意义停顿。",
        "如果原文是给 AI 助手的指令，保留约束、偏好、目标和上下文。",
        "中英混合、代码名、产品名、人名、路径、变量名要谨慎保留。"
      ].join("\n")
    },
    {
      role: "user",
      content: [
        `处理模式：${modeInstruction}`,
        contextHint ? `用户补充上下文：${contextHint}` : "",
        recent ? `最近输入上下文：\n${recent}` : "",
        `原始转写：\n${rawText}`
      ]
        .filter(Boolean)
        .join("\n\n")
    }
  ];
}

async function refineWithOpenAICompatible(messages) {
  const response = await httpFetch(`${config.refine.llmBaseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.refine.llmApiKey}`
    },
    body: JSON.stringify({
      model: config.refine.llmModel,
      messages,
      temperature: 0.2
    }),
    timeoutMs: 120000
  });

  const json = await parseJsonResponse(response, "Text refinement failed");
  return cleanModelText(json.choices?.[0]?.message?.content || "");
}

async function refineWithOllama(messages) {
  const response = await httpFetch(`${config.refine.ollamaBaseUrl}/api/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: config.refine.ollamaModel,
      messages,
      stream: false,
      options: {
        temperature: 0.2
      }
    }),
    timeoutMs: 120000
  });

  const json = await parseJsonResponse(response, "Ollama refinement failed");
  return cleanModelText(json.message?.content || json.response || "");
}

async function parseJsonResponse(response, prefix) {
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${prefix}: ${response.status} ${text.slice(0, 500)}`);
  }
  return JSON.parse(text);
}

function cleanModelText(text) {
  return String(text || "")
    .replace(/<think>[\s\S]*?<\/think>/g, "")
    .replace(/^```[a-z]*\n?/i, "")
    .replace(/```$/i, "")
    .trim();
}

function ruleBasedCleanup(text, mode) {
  if (mode === "bullet") {
    const parts = text
      .replace(/\s+/g, " ")
      .replace(/([一-龥])\s+([一-龥])/g, "$1$2")
      .split(/(?:。|；|;|然后|另外|还有|第一|第二|第三|首先|其次|最后)/)
      .map((part) => cleanupSentence(part))
      .filter(Boolean);
    if (parts.length > 1) {
      return parts.map((part) => `- ${part.replace(/[。！？!?]$/g, "")}`).join("\n");
    }
  }

  let output = cleanupSentence(text);

  if (!/[。！？!?]$/.test(output)) output += "。";
  return output;
}

function cleanupSentence(text) {
  return text
    .replace(/\s+/g, " ")
    .replace(/([一-龥])\s+([一-龥])/g, "$1$2")
    .replace(/(嗯|呃|额|啊|这个|那个|就是|然后)\s*/g, "")
    .replace(/，{2,}/g, "，")
    .replace(/。{2,}/g, "。")
    .trim();
}
