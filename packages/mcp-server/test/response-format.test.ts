import { beforeEach, describe, expect, it, vi } from "vitest";

const toonCodec = vi.hoisted(() => ({
  decode: vi.fn(),
  encode: vi.fn(),
}));

vi.mock("@toon-format/toon", () => toonCodec);

import { formatResponseContent } from "../src/response-format.js";

const responseFixture = {
  summary: "Example local-ydb response.",
  ok: true,
};
const jsonText = JSON.stringify(responseFixture, null, 2);
const toonText = "summary: Example local-ydb response.\nok: true";

describe("response content fallback", () => {
  beforeEach(() => {
    toonCodec.decode.mockReset();
    toonCodec.encode.mockReset();
    toonCodec.encode.mockReturnValue(toonText);
  });

  it("falls back to JSON when TOON decoding fails", () => {
    toonCodec.decode.mockImplementation(() => {
      throw new SyntaxError("Invalid TOON fixture");
    });

    const result = formatResponseContent(responseFixture, {
      responseContentFormat: "toon",
    });

    expect(toonCodec.encode).toHaveBeenCalledWith(responseFixture);
    expect(toonCodec.decode).toHaveBeenCalledWith(toonText);
    expect(result).toBe(jsonText);
  });

  it("falls back to JSON when TOON decoding changes the JSON model", () => {
    toonCodec.decode.mockReturnValue({
      summary: "Different response.",
      ok: true,
    });

    const result = formatResponseContent(responseFixture, {
      responseContentFormat: "toon",
    });

    expect(toonCodec.encode).toHaveBeenCalledWith(responseFixture);
    expect(toonCodec.decode).toHaveBeenCalledWith(toonText);
    expect(result).toBe(jsonText);
  });
});
