import { describe, expect, it } from "vitest";
import { connectClient, toolJson } from "./helpers.js";

describe("server", () => {
  it("lists exactly the implemented tools", async () => {
    const client = await connectClient();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["captions.generate", "captions.render", "health", "probe", "reframe"]);
    await client.close();
  });

  it("health returns a structured report", async () => {
    const client = await connectClient();
    const res = await client.callTool({ name: "health", arguments: {} });
    const data = toolJson(res);
    expect(data).toHaveProperty("ok");
    expect(data.ffmpeg).toHaveProperty("available");
    await client.close();
  });
});
