import assert from "node:assert/strict";
import test from "node:test";
import worker from "../src/index.js";

function env() {
  return {
    NOTION_DATA_SOURCE_ID: "9f0d20ce-441c-4d6e-b833-0bfe4bfcca21",
    NOTION_TOKEN: "test-notion-token",
    QFORM_READY_SECRET: "test-ready-secret",
    QFORM_CUSTOM_SECRET: "test-custom-secret"
  };
}
const payload = {
  form_id: 21748,
  lead_data: {
    "Имя": "Тестовый клиент",
    "Телефон": "+70000000000",
    "Удобный способ связи": "Telegram",
    "Город": "Москва",
    "Комментарий": "Тест"
  }
};
function send(kind, key, data = payload) {
  return worker.fetch(
    new Request("https://test.workers.dev/qform/" + kind + "/" + key, {
      method: "POST",
      body: JSON.stringify(data),
      headers: { "content-type": "application/json" }
    }),
    env()
  );
}

test("rejects unknown routes and secrets before reading customer data", async () => {
  const a = await send("ready", "wrong-secret");
  assert.equal(a.status, 404);
  const b = await worker.fetch(new Request("https://test.workers.dev/"), env());
  assert.equal(b.status, 404);
});

test("health check does not expose config", async () => {
  const res = await worker.fetch(new Request("https://test.workers.dev/health"), env());
  assert.equal(res.status, 200);
  assert.equal((await res.json()).ok, true);
});

test("ready form creates a Notion lead and second delivery is duplicate", async () => {
  const originalFetch = globalThis.fetch;
  let created = null;
  let recordExists = false;
  globalThis.fetch = async (url, options) => {
    assert.equal(options.headers.authorization, "Bearer test-notion-token");
    if (url.endsWith("/query")) {
      return new Response(JSON.stringify({ results: recordExists ? [{id: "existing"}] : [] }), { status: 200 });
    }
    if (url.endsWith("/pages")) {
      created = JSON.parse(options.body);
      recordExists = true;
      return new Response(JSON.stringify({ id: "page-test" }), { status: 200 });
    }
    throw Error("Unexpected request");
  };
  try {
    const first = await send("ready", "test-ready-secret");
    assert.equal(first.status, 200);
    assert.equal((await first.json()).created, true);
    assert.equal(created.properties["Имя"].rich_text[0].text.content, "Тестовый клиент");
    assert.equal(created.properties["Телефон"].phone_number, "+70000000000");
    assert.equal(created.properties["Этап"].select.name, "Заявка");
    assert.equal(created.properties["Тип"].select.name, "Готовый светильник");
    assert.equal(created.parent.data_source_id, env().NOTION_DATA_SOURCE_ID);
    assert.equal(created.properties["Комплектующие"], undefined);
    const second = await send("ready", "test-ready-secret");
    assert.equal((await second.json()).duplicate, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("custom form gets the correct product type and neither form books inventory", async () => {
  const originalFetch = globalThis.fetch;
  let created = null;
  globalThis.fetch = async (url, options) => {
    if (url.endsWith("/query")) return new Response('{"results":[]}', { status: 200 });
    created = JSON.parse(options.body);
    return new Response('{"id":"test-page"}', { status: 200 });
  };
  try {
    const res = await send("custom", "test-custom-secret");
    assert.equal(res.status, 200);
    assert.equal(created.properties["Форма QForm"].select.name, "По своему дому");
    assert.equal(created.properties["Сумма, ₽"], undefined);
    assert.equal(created.properties["Количество светильников"], undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("invalid JSON and invalid payload are rejected", async () => {
  const invalid = await worker.fetch(
    new Request("https://test.workers.dev/qform/ready/test-ready-secret", {
      method: "POST", body: '{"not-json":', headers: { "content-type": "application/json" }
    }), env()
  );
  assert.equal(invalid.status, 400);
  const missingLead = await send("ready", "test-ready-secret", {form_id:21748});
  assert.equal(missingLead.status, 422);
});
