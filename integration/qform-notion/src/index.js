// QForm -> Notion. Runs on Cloudflare Workers Free.
// Never place tokens or webhook URLs in the public repository.
const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2025-09-03";
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_TEXT = 1900;

const FIELD_ALIASES = {
  name: ["имя", "ваше имя", "фио", "как вас зовут", "name", "full name"],
  phone: ["телефон", "номер телефона", "ваш телефон", "phone", "mobile", "tel"],
  contactMethod: ["удобный способ связи", "способ связи", "как с вами связаться", "мессенджер", "contact method"],
  city: ["город", "ваш город", "населенный пункт", "city"],
  comment: ["комментарий", "сообщение", "пожелания", "комментарии", "расскажите о вашем доме", "comment", "message"]
};

function respond(status, data) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
  });
}
function normalizedKey(value) {
  return String(value).normalize("NFKC").toLowerCase().replace(/[^a-zа-яё0-9]/g, "");
}
function toText(value) {
  if (value == null) return "";
  if (Array.isArray(value)) return value.map(toText).filter(Boolean).join(", ");
  if (typeof value === "object") {
    if ("value" in value) return toText(value.value);
    if ("values" in value) return toText(value.values);
    return JSON.stringify(value);
  }
  return String(value);
}
function findAnswer(answers, keys) {
  const exact = new Map(Object.entries(answers).map(([key, value]) => [normalizedKey(key), value]));
  for (const key of keys) {
    const value = exact.get(normalizedKey(key));
    if (value !== undefined && value !== null && toText(value).trim()) return toText(value).trim();
  }
  return "";
}
function readAliases(env) {
  // FIELD_ALIASES_JSON is optional; its keys are name, phone, contactMethod, city, comment.
  if (!env.FIELD_ALIASES_JSON) return FIELD_ALIASES;
  const supplied = JSON.parse(env.FIELD_ALIASES_JSON);
  return Object.fromEntries(
    Object.entries(FIELD_ALIASES).map(([key, defaults]) => [
      key, Array.isArray(supplied[key]) ? supplied[key].concat(defaults) : defaults
    ])
  );
}
function stableStringify(value) {
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
  if (value !== null && typeof value === "object") {
    return "{" + Object.keys(value).sort().map(key =>
      JSON.stringify(key) + ":" + stableStringify(value[key])
    ).join(",") + "}";
  }
  return JSON.stringify(value);
}
async function sha256(text) {
  const data = new TextEncoder().encode(text);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  return Array.from(hash, byte => byte.toString(16).padStart(2, "0")).join("");
}
async function readPayload(request) {
  if (Number(request.headers.get("content-length") || 0) > MAX_REQUEST_BYTES) {
    throw { status: 413, message: "Payload too large" };
  }
  const reader = request.body?.getReader();
  if (!reader) throw { status: 400, message: "Empty request body" };
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_REQUEST_BYTES) {
      await reader.cancel();
      throw { status: 413, message: "Payload too large" };
    }
    chunks.push(value);
  }
  const raw = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    raw.set(chunk, offset);
    offset += chunk.length;
  }
  let json;
  try {
    json = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    throw { status: 400, message: "Invalid JSON" };
  }
  if (!json || typeof json !== "object" || Array.isArray(json) ||
      !json.lead_data || typeof json.lead_data !== "object" || Array.isArray(json.lead_data)) {
    throw { status: 422, message: "Expected QForm payload with lead_data" };
  }
  return json;
}
async function notion(path, body, env) {
  let response;
  try {
    response = await fetch(NOTION_API + path, {
      method: "POST",
      headers: {
        authorization: "Bearer " + env.NOTION_TOKEN,
        "notion-version": NOTION_VERSION,
        "content-type": "application/json"
      },
      body: JSON.stringify(body)
    });
  } catch {
    throw { status: 502, message: "Notion network error" };
  }
  if (!response.ok) {
    // Do not log the Notion response body: it could contain customer information.
    throw {
      status: 502,
      message: response.status === 401 || response.status === 403
        ? "Notion connection or permissions problem"
        : "Notion API failed",
      upstreamStatus: response.status
    };
  }
  return response.json();
}
function rich(value) {
  return { rich_text: [{ type: "text", text: { content: String(value).slice(0, MAX_TEXT) } }] };
}
function rawAnswerBlocks(payload) {
  // Keep the original QForm answers in the private Notion page so no unknown fields are lost.
  // This is intentional personal-data processing: see README before activating.
  const text = JSON.stringify({
    form_id: payload.form_id ?? null,
    lead_data: payload.lead_data,
    lead_files: payload.lead_files ?? []
  }, null, 2);
  const blocks = [{
    object: "block", type: "heading_2",
    heading_2: { rich_text: [{ type: "text", text: { content: "Ответы из QForm" } }] }
  }];
  for (let i = 0; i < text.length; i += MAX_TEXT) {
    blocks.push({
      object: "block", type: "paragraph",
      paragraph: { rich_text: [{ type: "text", text: { content: text.slice(i, i + MAX_TEXT) } }] }
    });
  }
  return blocks;
}
async function dedupeKey(payload, kind) {
  const leadId = payload.lead_id ?? payload.leadId ?? payload.application_id ?? payload.applicationId;
  if (leadId !== undefined && leadId !== null && String(leadId).trim()) {
    return "qform:" + kind + ":lead:" + String(leadId).slice(0, 150);
  }
  // QForm's documented webhook example contains no lead ID. Identical answer sets
  // therefore have the same fingerprint. They will be treated as one submission.
  const fingerprint = await sha256(stableStringify({
    kind, form_id: payload.form_id ?? null,
    lead_data: payload.lead_data,
    lead_files: payload.lead_files ?? []
  }));
  return "qform:" + kind + ":sha256:" + fingerprint;
}
async function processWebhook(request, env, kind) {
  const payload = await readPayload(request);
  const expectedFormId = kind === "ready" ? env.QFORM_READY_FORM_ID : env.QFORM_CUSTOM_FORM_ID;
  if (expectedFormId && String(payload.form_id ?? "") !== String(expectedFormId)) {
    throw { status: 403, message: "Unexpected QForm form_id" };
  }
  const sourceId = await dedupeKey(payload, kind);
  const query = await notion("/data_sources/" + encodeURIComponent(env.NOTION_DATA_SOURCE_ID) + "/query", {
    page_size: 1,
    filter: { property: "ID заявки QForm", rich_text: { equals: sourceId } }
  }, env);
  if (Array.isArray(query.results) && query.results.length > 0) {
    return respond(200, { ok: true, duplicate: true });
  }

  const aliases = readAliases(env);
  const answers = payload.lead_data;
  const type = kind === "ready" ? "Готовый светильник" : "По своему дому";
  const values = {
    name: findAnswer(answers, aliases.name),
    phone: findAnswer(answers, aliases.phone),
    contactMethod: findAnswer(answers, aliases.contactMethod),
    city: findAnswer(answers, aliases.city),
    comment: findAnswer(answers, aliases.comment)
  };
  const properties = {
    "Заказ": { title: [{ type: "text", text: { content: "Заявка с сайта · " + (kind === "ready" ? "Дом №13" : "Свой дом") + " · " + sourceId.slice(-8) } }] },
    "Источник": { select: { name: "Сайт" } },
    "Этап": { select: { name: "Заявка" } },
    "Тип": { select: { name: type } },
    "Форма QForm": { select: { name: type } },
    "ID заявки QForm": rich(sourceId),
    "Дата заявки": { date: { start: new Date().toISOString() } }
  };
  if (values.name) properties["Имя"] = rich(values.name);
  if (values.phone) properties["Телефон"] = { phone_number: values.phone.slice(0, 200) };
  if (values.contactMethod) properties["Способ связи"] = rich(values.contactMethod);
  if (values.city) properties["Город"] = rich(values.city);
  if (values.comment) properties["Комментарий"] = rich(values.comment);

  const page = await notion("/pages", {
    parent: { type: "data_source_id", data_source_id: env.NOTION_DATA_SOURCE_ID },
    properties, children: rawAnswerBlocks(payload)
  }, env);
  return respond(200, { ok: true, created: true, page_id: page.id });
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return respond(200, { ok: true, service: "dom13-qform-notion" });
    }
    const match = /^\/qform\/(ready|custom)\/([^/]+)$/.exec(url.pathname);
    if (!match || request.method !== "POST") return respond(404, { error: "Not found" });
    const kind = match[1];
    const secret = kind === "ready" ? env.QFORM_READY_SECRET : env.QFORM_CUSTOM_SECRET;
    // QForm has no documented webhook signature. The long random URL is the bearer secret.
    if (!secret || match[2] !== secret) return respond(404, { error: "Not found" });
    if (!env.NOTION_TOKEN || !env.NOTION_DATA_SOURCE_ID) {
      return respond(503, { error: "Worker is not configured" });
    }
    try {
      return await processWebhook(request, env, kind);
    } catch (error) {
      // Never log URLs, tokens, request bodies or customer details.
      return respond(error.status || 500, {
        ok: false,
        error: error.message && error.status ? error.message : "Internal error",
        ...(error.upstreamStatus ? { upstreamStatus: error.upstreamStatus } : {})
      });
    }
  }
};
export { dedupeKey, stableStringify, findAnswer, normalizedKey };
