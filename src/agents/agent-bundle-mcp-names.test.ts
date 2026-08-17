/** Tests MCP server/tool name sanitization, truncation, and collision handling. */
import { describe, expect, it } from "vitest";
import {
  assignSafeServerNames,
  buildSafeToolName,
  normalizeReservedToolNames,
  sanitizeServerName,
  TOOL_NAME_SEPARATOR,
} from "./agent-bundle-mcp-names.js";

describe("agent bundle MCP names", () => {
  it("sanitizes and disambiguates server names", () => {
    const usedNames = new Set<string>();

    expect(sanitizeServerName("vigil-harbor", usedNames)).toBe("vigil-harbor");
    expect(sanitizeServerName("vigil:harbor", usedNames)).toBe("vigil-harbor-2");
  });

  it.each([
    ["reserved bare name", "mcp", "mcp-server"],
    ["reserved namespace prefix", "mcp__reader", "mcp-reader"],
    ["empty sanitized name", "   ", "mcp-server"],
  ])("renames %s away from reserved native MCP tool forms", (_label, raw, expected) => {
    const safeServerName = sanitizeServerName(raw, new Set<string>());
    const safeToolName = buildSafeToolName({
      serverName: safeServerName,
      toolName: "read",
      reservedNames: new Set(),
    });

    expect(safeServerName).toBe(expected);
    expect(safeToolName).toBe(`${expected}${TOOL_NAME_SEPARATOR}read`);
    expect(safeToolName).not.toMatch(/^mcp__/);
  });

  it.each([
    [["mcp", "mcp-server"], { mcp: "mcp-server-2", "mcp-server": "mcp-server" }],
    [["mcp-server", "mcp"], { "mcp-server": "mcp-server", mcp: "mcp-server-2" }],
    [["mcp__reader", "mcp-reader"], { mcp__reader: "mcp-reader-2", "mcp-reader": "mcp-reader" }],
    [["mcp-reader", "mcp__reader"], { "mcp-reader": "mcp-reader", mcp__reader: "mcp-reader-2" }],
    [
      ["mcp", "mcp-server", "mcp server"],
      { mcp: "mcp-server-3", "mcp-server": "mcp-server", "mcp server": "mcp-server-2" },
    ],
  ])("does not let reserved fallbacks displace safe siblings: %j", (serverNames, expected) => {
    expect(Object.fromEntries(assignSafeServerNames(serverNames))).toEqual(expected);
  });

  it("keeps server and tool fragments provider-safe when they start with digits", () => {
    const usedNames = new Set<string>();
    const serverName = sanitizeServerName("12306", usedNames);

    expect(serverName).toBe("mcp-12306");
    expect(
      buildSafeToolName({
        serverName,
        toolName: "2024-query",
        reservedNames: new Set(),
      }),
    ).toBe(`mcp-12306${TOOL_NAME_SEPARATOR}tool-2024-query`);
  });

  it("builds provider-safe tool names and avoids collisions", () => {
    const reservedNames = normalizeReservedToolNames(["memory__status"]);

    const safeToolName = buildSafeToolName({
      serverName: "memory",
      toolName: "status",
      reservedNames,
    });
    expect(safeToolName).toBe(`memory${TOOL_NAME_SEPARATOR}status-2`);
  });

  it("uses the bundle server name for Link MCP tools", () => {
    const usedServerNames = new Set<string>();
    const serverName = sanitizeServerName("link", usedServerNames);

    expect(
      buildSafeToolName({
        serverName,
        toolName: "auth_login",
        reservedNames: new Set(),
      }),
    ).toBe(`link${TOOL_NAME_SEPARATOR}auth_login`);
    expect(
      buildSafeToolName({
        serverName,
        toolName: "spend-request_create",
        reservedNames: new Set(),
      }),
    ).toBe(`link${TOOL_NAME_SEPARATOR}spend-request_create`);
  });

  it("truncates overlong tool names while keeping the server prefix", () => {
    const safeToolName = buildSafeToolName({
      serverName: "memory",
      toolName: "x".repeat(200),
      reservedNames: new Set(),
    });

    expect(safeToolName.startsWith(`memory${TOOL_NAME_SEPARATOR}`)).toBe(true);
    expect(safeToolName.length).toBeLessThanOrEqual(64);
  });
});
