import { onRequest } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import { initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { GoogleGenerativeAI } from "@google/generative-ai";

initializeApp();

const ngApiKey = defineSecret("NG_API_KEY");
const anthropicApiKey = defineSecret("ANTHROPIC_API_KEY");
const openaiApiKey = defineSecret("OPENAI_API_KEY");
const geminiApiKey = defineSecret("GEMINI_API_KEY");
const azureOpenaiApiKey = defineSecret("AZURE_OPENAI_API_KEY");
const azureOpenaiEndpoint = defineSecret("AZURE_OPENAI_ENDPOINT");

const NG_API_BASE = "https://api.neuralgraph.app";

type Provider = "anthropic" | "openai" | "gemini" | "azure_openai";

const PROVIDER_MODELS: Record<Provider, string> = {
  anthropic: "claude-sonnet-4-5-20250929",
  openai: "gpt-4o",
  gemini: "gemini-2.0-flash",
  azure_openai: "gpt-4o",
};

// Whitelisted NeuralGraph API paths
const ALLOWED_PATHS: { method: string; pattern: RegExp }[] = [
  // Health
  { method: "GET", pattern: /^\/v1\/health$/ },
  // Spaces (individual only — no list-all)
  { method: "GET", pattern: /^\/v1\/spaces\/[^/]+$/ },
  // Ingestion
  { method: "POST", pattern: /^\/v1\/spaces\/[^/]+\/ingest$/ },
  // Hydration
  { method: "POST", pattern: /^\/v1\/hydrate$/ },
  // Feedback
  { method: "POST", pattern: /^\/v1\/feedback$/ },
  // Jobs
  { method: "GET", pattern: /^\/v1\/jobs$/ },
  { method: "GET", pattern: /^\/v1\/jobs\/[^/]+$/ },
  // Profiles
  { method: "GET", pattern: /^\/v1\/profiles\/[^/]+$/ },
  { method: "PUT", pattern: /^\/v1\/profiles\/[^/]+\/user$/ },
  { method: "PUT", pattern: /^\/v1\/profiles\/[^/]+\/ai$/ },
  { method: "GET", pattern: /^\/v1\/profiles\/[^/]+\/ai\/spaces\/[^/]+$/ },
  { method: "PUT", pattern: /^\/v1\/profiles\/[^/]+\/ai\/spaces\/[^/]+$/ },
];

interface UserClaims {
  ngTenant: string;
  ngUserId: string;
  ngSpaceIds: string[];
}

interface ChatMessage {
  role: string;
  content: string;
}

interface ChatResponse {
  content: string;
  provider: string;
  model: string;
}

async function verifyAuth(
  req: { headers: { authorization?: string } }
): Promise<UserClaims> {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    throw new Error("Missing or invalid Authorization header");
  }

  const token = authHeader.slice(7);
  const decoded = await getAuth().verifyIdToken(token);
  const claims = decoded as Record<string, unknown>;

  if (!claims.ngTenant || !claims.ngUserId || !claims.ngSpaceIds) {
    throw new Error("Missing sandbox claims — contact admin for access");
  }

  return {
    ngTenant: claims.ngTenant as string,
    ngUserId: claims.ngUserId as string,
    ngSpaceIds: claims.ngSpaceIds as string[],
  };
}

function isPathAllowed(method: string, path: string): boolean {
  return ALLOWED_PATHS.some(
    (rule) => rule.method === method && rule.pattern.test(path)
  );
}

function enforceSpaceIds(
  body: Record<string, unknown>,
  allowedSpaceIds: string[]
): void {
  if (Array.isArray(body.space_ids)) {
    const requested = body.space_ids as string[];
    const disallowed = requested.filter((id) => !allowedSpaceIds.includes(id));
    if (disallowed.length > 0) {
      throw new Error(`Access denied to space(s): ${disallowed.join(", ")}`);
    }
  }

  if (typeof body.space_id === "string") {
    if (!allowedSpaceIds.includes(body.space_id)) {
      throw new Error(`Access denied to space: ${body.space_id}`);
    }
  }
}

function extractSpaceIdFromPath(path: string): string | null {
  const match = path.match(/^\/v1\/spaces\/([^/]+)\//);
  return match ? match[1] : null;
}

// ── LLM provider implementations ──

async function chatAnthropic(
  systemPrompt: string,
  messages: ChatMessage[]
): Promise<ChatResponse> {
  const client = new Anthropic({ apiKey: anthropicApiKey.value() });
  const model = PROVIDER_MODELS.anthropic;

  const response = await client.messages.create({
    model,
    max_tokens: 4096,
    system: systemPrompt,
    messages: messages.map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    })),
  });

  const text =
    response.content[0].type === "text" ? response.content[0].text : "";

  return { content: text, provider: "anthropic", model };
}

async function chatOpenAI(
  systemPrompt: string,
  messages: ChatMessage[]
): Promise<ChatResponse> {
  const client = new OpenAI({ apiKey: openaiApiKey.value() });
  const model = PROVIDER_MODELS.openai;

  const response = await client.chat.completions.create({
    model,
    max_tokens: 4096,
    messages: [
      { role: "system" as const, content: systemPrompt },
      ...messages.map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      })),
    ],
  });

  return {
    content: response.choices[0]?.message?.content || "",
    provider: "openai",
    model,
  };
}

async function chatGemini(
  systemPrompt: string,
  messages: ChatMessage[]
): Promise<ChatResponse> {
  const genAI = new GoogleGenerativeAI(geminiApiKey.value());
  const model = PROVIDER_MODELS.gemini;
  const genModel = genAI.getGenerativeModel({
    model,
    systemInstruction: systemPrompt,
  });

  // Convert message history to Gemini format
  const history = messages.slice(0, -1).map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));

  const chat = genModel.startChat({ history });
  const lastMessage = messages[messages.length - 1];
  const result = await chat.sendMessage(lastMessage.content);

  return {
    content: result.response.text(),
    provider: "gemini",
    model,
  };
}

async function chatAzureOpenAI(
  systemPrompt: string,
  messages: ChatMessage[]
): Promise<ChatResponse> {
  const endpoint = azureOpenaiEndpoint.value();
  const model = PROVIDER_MODELS.azure_openai;

  // The deployment name is typically the model name in Azure
  const client = new OpenAI({
    apiKey: azureOpenaiApiKey.value(),
    baseURL: `${endpoint}/openai/deployments/${model}`,
    defaultQuery: { "api-version": "2024-10-21" },
    defaultHeaders: { "api-key": azureOpenaiApiKey.value() },
  });

  const response = await client.chat.completions.create({
    model,
    max_tokens: 4096,
    messages: [
      { role: "system" as const, content: systemPrompt },
      ...messages.map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      })),
    ],
  });

  return {
    content: response.choices[0]?.message?.content || "",
    provider: "azure_openai",
    model,
  };
}

const CHAT_HANDLERS: Record<
  Provider,
  (system: string, messages: ChatMessage[]) => Promise<ChatResponse>
> = {
  anthropic: chatAnthropic,
  openai: chatOpenAI,
  gemini: chatGemini,
  azure_openai: chatAzureOpenAI,
};

// ── Cloud Function ──

export const api = onRequest(
  {
    secrets: [
      ngApiKey,
      anthropicApiKey,
      openaiApiKey,
      geminiApiKey,
      azureOpenaiApiKey,
      azureOpenaiEndpoint,
    ],
    cors: false,
  },
  async (req, res) => {
    const path = req.path.replace(/^\/api/, "");

    if (path === "/chat") {
      await handleChat(req, res);
      return;
    }

    await handleProxy(req, res, path);
  }
);

async function handleProxy(
  req: { method: string; headers: Record<string, unknown>; body: unknown },
  res: {
    status: (code: number) => { json: (body: unknown) => void };
    set: (headers: Record<string, string>) => void;
  },
  path: string
): Promise<void> {
  try {
    const claims = await verifyAuth(
      req as { headers: { authorization?: string } }
    );

    if (!isPathAllowed(req.method, path)) {
      res.status(403).json({ error: "Endpoint not allowed" });
      return;
    }

    const pathSpaceId = extractSpaceIdFromPath(path);
    if (pathSpaceId && !claims.ngSpaceIds.includes(pathSpaceId)) {
      res.status(403).json({ error: `Access denied to space: ${pathSpaceId}` });
      return;
    }

    const body =
      typeof req.body === "object" && req.body !== null
        ? (req.body as Record<string, unknown>)
        : {};
    enforceSpaceIds(body, claims.ngSpaceIds);

    const url = `${NG_API_BASE}${path}`;
    const headers: Record<string, string> = {
      "X-API-Key": ngApiKey.value(),
      "Content-Type": "application/json",
      "X-User-ID": claims.ngUserId,
    };

    const fetchOptions: RequestInit = {
      method: req.method,
      headers,
    };

    if (req.method !== "GET" && req.method !== "HEAD") {
      fetchOptions.body = JSON.stringify(body);
    }

    const upstream = await fetch(url, fetchOptions);
    const responseBody = await upstream.text();

    res.set({
      "Content-Type":
        upstream.headers.get("content-type") || "application/json",
    });
    res
      .status(upstream.status)
      .json(responseBody ? JSON.parse(responseBody) : {});
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal error";
    const status =
      message.includes("Access denied") || message.includes("not allowed")
        ? 403
        : message.includes("Missing") || message.includes("invalid")
          ? 401
          : 500;
    res.status(status).json({ error: message });
  }
}

async function handleChat(
  req: { method: string; headers: Record<string, unknown>; body: unknown },
  res: {
    status: (code: number) => { json: (body: unknown) => void };
  }
): Promise<void> {
  try {
    if (req.method !== "POST") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }

    await verifyAuth(req as { headers: { authorization?: string } });

    const body = req.body as {
      system_prompt?: string;
      messages?: ChatMessage[];
      provider?: string;
    };

    if (!body.messages || !Array.isArray(body.messages)) {
      res.status(400).json({ error: "messages array is required" });
      return;
    }

    const provider = (body.provider || "anthropic") as Provider;
    const handler = CHAT_HANDLERS[provider];

    if (!handler) {
      const valid = Object.keys(CHAT_HANDLERS).join(", ");
      res.status(400).json({ error: `Unknown provider: ${body.provider}. Valid: ${valid}` });
      return;
    }

    const result = await handler(body.system_prompt || "", body.messages);

    res.status(200).json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal error";
    const status =
      message.includes("Missing") || message.includes("invalid") ? 401 : 500;
    res.status(status).json({ error: message });
  }
}
