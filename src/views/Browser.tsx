import { useEffect, useRef, useState } from "react";
import { api, type WebResult } from "../lib/ipc";

/**
 * The built-in browser. Pages run in sandboxed guests with their own storage
 * and no access to Forge AI. The app can read the visible text of a page or
 * save a screenshot, and only does so when the person presses the button.
 */
type Tab = { id: string; url: string; title: string };

const newId = () => Math.random().toString(36).slice(2, 10);
const HOME = "";

/** Turns what was typed into an https address, or null when it is not an address. */
export function toAddress(input: string): string | null {
  const t = input.trim();
  if (!t) return null;
  if (/^https?:\/\//i.test(t)) return t.replace(/^http:\/\//i, "https://");
  if (/\s/.test(t) || !/\./.test(t)) return null;
  return `https://${t}`;
}

const ORIGIN_NOTE = "Pages open in a separate, sandboxed browser. Forge AI reads a page only when you ask it to.";

export function Browser({
  onSendToChat,
}: {
  onSendToChat: (text: string) => void;
}) {
  const [tabs, setTabs] = useState<Tab[]>([{ id: newId(), url: HOME, title: "New tab" }]);
  const [activeId, setActiveId] = useState<string>(tabs[0]!.id);
  const [address, setAddress] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<WebResult | null>(null);
  const [searching, setSearching] = useState(false);
  const webviews = useRef<Map<string, HTMLElement & { getURL?: () => string }>>(new Map());
  const active = tabs.find((t) => t.id === activeId) ?? tabs[0]!;

  useEffect(() => {
    setAddress(active.url);
  }, [active.id, active.url]);

  const wv = () => webviews.current.get(activeId) as unknown as {
    goBack(): void; goForward(): void; reload(): void; canGoBack(): boolean; canGoForward(): boolean;
    executeJavaScript(code: string): Promise<unknown>; capturePage(): Promise<{ toDataURL(): string }>; getURL(): string; getTitle(): string;
  } | undefined;

  function go(url: string) {
    setTabs((ts) => ts.map((t) => (t.id === activeId ? { ...t, url, title: url.replace(/^https:\/\//, "").split("/")[0] ?? url } : t)));
    setNotice(null);
  }

  function openNew(url: string) {
    const id = newId();
    setTabs((ts) => [...ts, { id, url, title: url.replace(/^https:\/\//, "").split("/")[0] ?? url }]);
    setActiveId(id);
  }

  function closeTab(id: string) {
    setTabs((ts) => {
      const next = ts.filter((t) => t.id !== id);
      if (next.length === 0) {
        const fresh = { id: newId(), url: HOME, title: "New tab" };
        setActiveId(fresh.id);
        return [fresh];
      }
      if (id === activeId) setActiveId(next[next.length - 1]!.id);
      return next;
    });
    webviews.current.delete(id);
  }

  function submitAddress(e: React.FormEvent) {
    e.preventDefault();
    const url = toAddress(address);
    if (!url) {
      // Not an address: search the open sources instead.
      void runSearch(address);
      return;
    }
    go(url);
  }

  async function runSearch(q: string) {
    const text = q.trim();
    if (!text) return;
    setSearching(true);
    setNotice(null);
    try {
      const r = await api.webSearch(text);
      setResults(r);
      setQuery(text);
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    } finally {
      setSearching(false);
    }
  }

  async function readPage() {
    const view = wv();
    if (!view || !active.url) {
      setNotice("The page is not ready yet. Try again in a moment.");
      return;
    }
    try {
      const text = (await view.executeJavaScript("document.body ? document.body.innerText : ''")) as string;
      const url = view.getURL();
      const clipped = String(text ?? "").slice(0, 20_000).trim();
      if (!clipped) {
        setNotice("This page has no readable text.");
        return;
      }
      onSendToChat(`Here is the text of ${url}:\n\n${clipped}\n\nWhat should I know from this page?`);
    } catch (e) {
      setNotice(`Could not read the page: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function saveScreenshot() {
    const view = wv();
    if (!view || !active.url) return;
    try {
      const image = await view.capturePage();
      const saved = await api.saveScreenshot(image.toDataURL());
      setNotice(saved ? `Saved ${saved}` : null);
    } catch (e) {
      setNotice(`Could not take a screenshot: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return (
    <div className="browser">
      <div className="browser-tabs" role="tablist" aria-label="Browser tabs">
        {tabs.map((t) => (
          <div key={t.id} className={`browser-tab${t.id === activeId ? " on" : ""}`}>
            <button role="tab" aria-selected={t.id === activeId} className="browser-tab-btn" onClick={() => setActiveId(t.id)}>
              {t.title}
            </button>
            <button className="browser-tab-x" aria-label={`Close ${t.title}`} onClick={() => closeTab(t.id)}>×</button>
          </div>
        ))}
        <button className="browser-tab-new" aria-label="New tab" onClick={() => { const id = newId(); setTabs((ts) => [...ts, { id, url: HOME, title: "New tab" }]); setActiveId(id); }}>+</button>
      </div>

      <form className="browser-bar" onSubmit={submitAddress}>
        <button type="button" className="browser-nav" aria-label="Back" disabled={!active.url} onClick={() => wv()?.goBack()}>←</button>
        <button type="button" className="browser-nav" aria-label="Forward" disabled={!active.url} onClick={() => wv()?.goForward()}>→</button>
        <button type="button" className="browser-nav" aria-label="Reload" disabled={!active.url} onClick={() => wv()?.reload()}>↻</button>
        <input
          className="browser-address"
          aria-label="Address or search"
          placeholder="Type an address, or words to search open sources"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          spellCheck={false}
        />
        <button className="browser-go" type="submit">Go</button>
        <button type="button" className="browser-action" disabled={!active.url} onClick={() => void readPage()}>Send page to chat</button>
        <button type="button" className="browser-action" disabled={!active.url} onClick={() => void saveScreenshot()}>Screenshot</button>
      </form>

      {notice && <div className="browser-notice" role="status">{notice}</div>}

      {active.url ? (
        <webview
          key={active.id}
          ref={(el: HTMLElement | null) => {
            if (el) webviews.current.set(active.id, el);
            else webviews.current.delete(active.id);
          }}
          className="browser-page"
          src={active.url}
          partition="persist:forge-browser"
          aria-label={`Page: ${active.title}`}
        />
      ) : (
        <div className="browser-start">
          <h2>Browse, or search open sources</h2>
          <p className="hint">{ORIGIN_NOTE}</p>
          <form
            className="browser-search"
            onSubmit={(e) => {
              e.preventDefault();
              void runSearch(query);
            }}
          >
            <input
              aria-label="Search open sources"
              placeholder="Search Wikipedia"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <button type="submit" disabled={searching || !query.trim()}>{searching ? "Searching…" : "Search"}</button>
          </form>
          {results && (
            <ol className="browser-results">
              {results.sources.map((s) => (
                <li key={s.url}>
                  <button className="linkbtn" onClick={() => openNew(s.url)}>{s.title}</button>
                  <div className="hint">{s.snippet}</div>
                </li>
              ))}
              {results.sources.length === 0 && <li className="hint">No articles matched.</li>}
            </ol>
          )}
        </div>
      )}
    </div>
  );
}
