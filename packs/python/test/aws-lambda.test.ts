import { describe, expect, it } from "vitest";
import { getPack } from "./support/pack.js";

describe("AWS Lambda event handlers (A10 item 3): entry point from the event envelope shape", () => {
  it("a module-level function reading a parameter's Records key is a queue_subscriber", async () => {
    const pack = await getPack();
    const r = pack.parse(
      "r",
      "infra/handlers/embed_worker/embed_worker.py",
      [
        "import json",
        "from services.embedding_service import EmbeddingService",
        "def _process(memory_id):",
        "    return EmbeddingService().embed(memory_id)",
        "def handler(event: dict, context) -> dict:",
        '    for record in event.get("Records", []):',
        '        body = json.loads(record["body"])',
        '        _process(body["memory_id"])',
        '    return {"statusCode": 200}',
        "def indexer(evt):",
        '    for rec in evt["Records"]:',
        "        _process(rec)",
        "",
      ].join("\n"),
    );
    const byName = new Map(r.nodes.map((n) => [n.id.split("#")[1], n]));
    expect(byName.get("handler")).toMatchObject({
      is_entry_point: true,
      entry_point_kind: "queue_subscriber",
      tags: ["aws_lambda:event_handler"],
    });
    expect(byName.get("indexer")).toMatchObject({
      is_entry_point: true,
      entry_point_kind: "queue_subscriber",
    });
    expect(byName.get("_process")).toMatchObject({ is_entry_point: false });
  });

  it("the name `handler` alone is not a signal, and a local dict's Records key is not either", async () => {
    const pack = await getPack();
    const r = pack.parse(
      "r",
      "infra/handlers/memory/memory.py",
      [
        "from mangum import Mangum",
        "from fastapi import FastAPI",
        "app = FastAPI()",
        "_http_handler = Mangum(app)",
        "def handler(event, context):",
        "    return _http_handler(event, context)",
        "def summarize(path):",
        '    data = {"Records": []}',
        '    for r in data["Records"]:',
        "        pass",
        "class Worker:",
        "    def handler(self, event):",
        '        return event["Records"]',
        "",
      ].join("\n"),
    );
    for (const n of r.nodes) expect(n.is_entry_point, n.id).toBe(false);
  });
});
