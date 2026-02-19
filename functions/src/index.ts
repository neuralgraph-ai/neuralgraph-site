import { onRequest } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import { initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import OpenAI from "openai";

initializeApp();

const ngApiKey = defineSecret("NG_API_KEY");
const azureOpenaiApiKey = defineSecret("AZURE_OPENAI_API_KEY");
const azureOpenaiEndpoint = defineSecret("AZURE_OPENAI_ENDPOINT");

const NG_API_BASE = "https://api.neuralgraph.app";

const AZURE_MODEL = "gpt-4o";

// Whitelisted NeuralGraph API paths
const ALLOWED_PATHS: { method: string; pattern: RegExp }[] = [
  // Health
  { method: "GET", pattern: /^\/v1\/health$/ },
  // Spaces
  { method: "POST", pattern: /^\/v1\/spaces$/ },
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

// ── LLM ──

async function chatAzureOpenAI(
  systemPrompt: string,
  messages: ChatMessage[]
): Promise<ChatResponse> {
  const endpoint = azureOpenaiEndpoint.value();

  const client = new OpenAI({
    apiKey: azureOpenaiApiKey.value(),
    baseURL: `${endpoint}/openai/deployments/${AZURE_MODEL}`,
    defaultQuery: { "api-version": "2024-10-21" },
    defaultHeaders: { "api-key": azureOpenaiApiKey.value() },
  });

  const response = await client.chat.completions.create({
    model: AZURE_MODEL,
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
    model: AZURE_MODEL,
  };
}

// ── Cloud Function ──

export const api = onRequest(
  {
    secrets: [
      ngApiKey,
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

    if (path === "/create-space") {
      await handleCreateSpace(req, res);
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
      "X-Tenant-ID": claims.ngTenant,
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

    res.set({ "Content-Type": "application/json" });

    if (!responseBody) {
      res.status(upstream.status).json({});
      return;
    }

    try {
      res.status(upstream.status).json(JSON.parse(responseBody));
    } catch {
      res.status(upstream.status).json({
        error: `Upstream returned non-JSON (HTTP ${upstream.status})`,
      });
    }
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

async function handleCreateSpace(
  req: { method: string; headers: Record<string, unknown>; body: unknown },
  res: {
    status: (code: number) => { json: (body: unknown) => void };
    set: (headers: Record<string, string>) => void;
  }
): Promise<void> {
  try {
    if (req.method !== "POST") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }

    const authHeader = (req.headers.authorization || "") as string;
    if (!authHeader.startsWith("Bearer ")) {
      throw new Error("Missing or invalid Authorization header");
    }
    const token = authHeader.slice(7);
    const decoded = await getAuth().verifyIdToken(token);
    const uid = decoded.uid;
    const claims = decoded as Record<string, unknown>;

    if (!claims.ngTenant || !claims.ngUserId) {
      throw new Error("Missing sandbox claims — contact admin for access");
    }

    const ngTenant = claims.ngTenant as string;
    const ngUserId = claims.ngUserId as string;
    const ngSpaceIds = (claims.ngSpaceIds as string[]) || [];

    const body =
      typeof req.body === "object" && req.body !== null
        ? (req.body as Record<string, unknown>)
        : {};

    // Forward to NeuralGraph API
    const upstream = await fetch(`${NG_API_BASE}/v1/spaces`, {
      method: "POST",
      headers: {
        "X-API-Key": ngApiKey.value(),
        "Content-Type": "application/json",
        "X-User-ID": ngUserId,
        "X-Tenant-ID": ngTenant,
      },
      body: JSON.stringify({
        name: body.name || "Untitled Space",
        space_type: body.space_type || "memory",
        owner_id: ngUserId,
      }),
    });

    const respText = await upstream.text();
    let respBody: Record<string, unknown>;
    try {
      respBody = JSON.parse(respText);
    } catch {
      res.status(upstream.status).json({
        error: `Upstream returned non-JSON (HTTP ${upstream.status})`,
      });
      return;
    }

    if (!upstream.ok) {
      res.status(upstream.status).json(respBody);
      return;
    }

    // Add new space ID to user's claims
    const newSpaceId = respBody.id as string;
    if (newSpaceId && !ngSpaceIds.includes(newSpaceId)) {
      const updatedSpaceIds = [...ngSpaceIds, newSpaceId];
      await getAuth().setCustomUserClaims(uid, {
        ngTenant,
        ngUserId,
        ngSpaceIds: updatedSpaceIds,
      });
    }

    res.set({ "Content-Type": "application/json" });
    res.status(201).json(respBody);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal error";
    const status =
      message.includes("Missing") || message.includes("invalid") ? 401 : 500;
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
    };

    if (!body.messages || !Array.isArray(body.messages)) {
      res.status(400).json({ error: "messages array is required" });
      return;
    }

    const result = await chatAzureOpenAI(body.system_prompt || "", body.messages);

    res.status(200).json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal error";
    const status =
      message.includes("Missing") || message.includes("invalid") ? 401 : 500;
    res.status(status).json({ error: message });
  }
}
