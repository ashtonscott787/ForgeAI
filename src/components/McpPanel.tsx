import { useEffect, useState } from "react";
import { api } from "../lib/ipc";

/**
 * Other tools Forge AI can use, over the Model Context Protocol.
 *
 * Adding a server is a two-step thing on purpose: you point at a program,
 * Forge AI starts it, asks what it offers and stops it again, and you read
 * what came back before deciding whether to switch it on. Nothing it offers
 * is ever called during that look.
 */
export interface McpServer {
  id: string;
  name: string;
  command: string;
  args: string[];
  enabled: boolean;
}

export function McpPanel() {
  const [list, setList] = useState<McpServer[]>([]);
  const [command, setCommand] = useState("");
  const [looking, setLooking] = useState(false);
  const [found, setFound] = useState<{ ok: boolean; name: string; description: string; error?: string } | null>(null);

  useEffect(() => { void api.mcpList().then(setList).catch(() => undefined); }, []);

  const save = (next: McpServer[]) => {
    setList(next);
    void api.mcpSave(next).catch(() => undefined);
  };

  /** Splits a command line into a program and its arguments. Quotes hold together. */
  const parse = (line: string): string[] =>
    (line.match(/"[^"]*"|'[^']*'|\S+/g) || []).map((p) => p.replace(/^["']|["']$/g, ""));

  const look = async () => {
    const parts = parse(command.trim());
    const program = parts[0];
    if (!program) return;
    setLooking(true);
    setFound(null);
    try {
      setFound(await api.mcpInspect({ command: program, args: parts.slice(1) }));
    } finally {
      setLooking(false);
    }
  };

  const add = () => {
    const parts = parse(command.trim());
    const program = parts[0];
    if (!program || !found?.ok) return;
    save([...list, {
      id: Math.random().toString(36).slice(2),
      name: found.name || program,
      command: program,
      args: parts.slice(1),
      enabled: false,
    }]);
    setCommand("");
    setFound(null);
  };

  return (
    <div className="panel mcp">
      <div className="panel-h"><span className="t">Other tools (MCP)</span></div>
      <div className="panel-b">
        <p className="hint">
          Connect Forge AI to another program that speaks the Model Context Protocol — a file server,
          a database, your own internal tools. The program runs on this computer. Adding one never
          runs anything it offers.
        </p>

        <div className="mcp-add">
          <input
            className="convsearch"
            aria-label="Command that starts the server"
            placeholder="node /path/to/server.js"
            value={command}
            onChange={(e) => { setCommand(e.target.value); setFound(null); }}
            onKeyDown={(e) => { if (e.key === "Enter") void look(); }}
          />
          <button className="btn ghost" disabled={!command.trim() || looking} onClick={() => void look()}>
            {looking ? "Looking…" : "See what it offers"}
          </button>
        </div>

        {found && (
          <div className={`mcp-found${found.ok ? "" : " bad"}`} role="status">
            {found.ok ? (
              <>
                <pre className="mcp-desc">{found.description}</pre>
                <button className="btn primary small" onClick={add}>Add {found.name}</button>
              </>
            ) : (
              <p>{found.error}</p>
            )}
          </div>
        )}

        {list.length > 0 && (
          <ul className="mcp-list">
            {list.map((s) => (
              <li key={s.id}>
                <span className="mcp-name">{s.name}</span>
                <code className="mcp-cmd">{[s.command, ...s.args].join(" ")}</code>
                <button
                  className="ghostbtn small"
                  onClick={() => save(list.map((x) => (x.id === s.id ? { ...x, enabled: !x.enabled } : x)))}
                >
                  {s.enabled ? "On" : "Off"}
                </button>
                <button className="ghostbtn small danger" onClick={() => save(list.filter((x) => x.id !== s.id))}>
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
