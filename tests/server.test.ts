import { describe, expect, it } from "vitest";
import { connectClient } from "./helpers.js";

describe("server", () => {
  it("lists exactly the implemented tools", async () => {
    const client = await connectClient();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["health", "probe"]);
    await client.close();
  });

  it("health returns a structured report", async () => {
    const client = await connectClient();
    const res = await client.callTool({ name: "health", arguments: {} });
    const data = JSON.parse((res.content as { text: string }[])[0].text);
    expect(data).toHaveProperty("ok");
    expect(data.ffmpeg).toHaveProperty("available");
    await client.close();
  });
});
