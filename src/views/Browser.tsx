import { useEffect, useRef, useState } from "react";
import { api, type WebResult } from "../lib/ipc";
import type { BrowserAction, BrowserActivity } from "../lib/chat";

/**
 * The built-in browser. Pages run in sandboxed guests with their own storage
 * and no access to Forge AI. The app can read the visible text of a page or
 * save a screenshot, and only does so when the person presses the button.
 */
type Tab = { id: string; url: string; title: string };

const newId = () => Math.random().toString(36).slice(2, 10);
/** Google is the start page, the same address a new tab opens in a normal browser. */
export const HOME = "https://www.google.com";
const hostOf = (url: string) => url.replace(/^https?:\/\//, "").split("/")[0] ?? url;

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
  compact = false,
  onClose,
  openUrl,
}: {
  onSendToChat: (text: string, images?: string[], activity?: BrowserActivity) => void;
  /** Pane mode: narrower controls, no full-width start screen. */
  compact?: boolean;
  onClose?: () => void;
  /** A page the rest of the app wants shown. Each new value opens a tab. */
  openUrl?: { url: string; at: number } | null;
}) {
  const [tabs, setTabs] = useState<Tab[]>([{ id: newId(), url: HOME, title: "New tab" }]);
  const [activeId, setActiveId] = useState<string>(tabs[0]!.id);
  const [address, setAddress] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<WebResult | null>(null);
  const [searching, setSearching] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [find, setFind] = useState("");
  const [findOpen, setFindOpen] = useState(false);
  const [matches, setMatches] = useState<{ active: number; total: number } | null>(null);
  const webviews = useRef<Map<string, HTMLElement & { getURL?: () => string }>>(new Map());
  const active = tabs.find((t) => t.id === activeId) ?? tabs[0]!;
  // Only what the browser actually did, in order. Drained when a turn is handed to the chat.
  const log = useRef<BrowserAction[]>([]);
  const note = (a: BrowserAction) => {
    const last = log.current[log.current.length - 1];
    if (last && last.kind === a.kind && last.label === a.label) return;
    log.current = [...log.current.slice(-7), a];
  };
  const drain = (page?: BrowserActivity["page"]): BrowserActivity => {
    const actions = log.current;
    log.current = [];
    return { actions, page };
  };

  // A link opened from another app arrives here and opens in a new tab.
  useEffect(() => {
    const off = api.onBrowserOpen(({ url }) => {
      const id = newId();
      setTabs((ts) => [...ts, { id, url, title: url.replace(/^https:\/\//, "").split("/")[0] ?? url }]);
      setActiveId(id);
    });
    return () => void off.then((f) => f()).catch(() => undefined);
  }, []);

  useEffect(() => {
    setAddress(active.url);
  }, [active.id, active.url]);

  // Keyed on `at` rather than the address, so asking for the same page twice
  // still opens it the second time.
  useEffect(() => {
    if (openUrl?.url) openNew(openUrl.url);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openUrl?.at]);

  /** A guest that cannot report its title still sends its text; the host name does instead. */
  const titleOf = (view: { getTitle?: () => string }, url: string) => {
    try { return view.getTitle?.() || hostOf(url); } catch { return hostOf(url); }
  };

  /**
   * A guest page can take a long time or fail outright, and a frame that simply
   * stays blank is indistinguishable from one that is working. These events are
   * the only honest source of that state.
   */
  const attach = (el: HTMLElement | null, id: string) => {
    if (!el) { webviews.current.delete(id); return; }
    webviews.current.set(id, el);
    if ((el as { __forgeBound?: boolean }).__forgeBound) return;
    (el as { __forgeBound?: boolean }).__forgeBound = true;
    el.addEventListener("did-start-loading", () => { setLoading(true); setLoadError(null); });
    el.addEventListener("did-stop-loading", () => setLoading(false));
    el.addEventListener("did-fail-load", (e) => {
      const ev = e as unknown as { errorDescription?: string; errorCode?: number; isMainFrame?: boolean };
      // Sub-resources fail all the time; only the page itself is worth reporting.
      if (ev.isMainFrame === false) return;
      if (ev.errorCode === -3) return; // the load was aborted, usually by navigating away
      setLoading(false);
      setLoadError(ev.errorDescription || "That page could not be loaded.");
    });
    el.addEventListener("page-title-updated", (e) => {
      const t = (e as unknown as { title?: string }).title;
      if (t) setTabs((ts) => ts.map((x) => (x.id === id ? { ...x, title: t.slice(0, 60) } : x)));
    });
    el.addEventListener("found-in-page", (e) => {
      const r = (e as unknown as { result?: { activeMatchOrdinal: number; matches: number } }).result;
      if (r) setMatches({ active: r.activeMatchOrdinal, total: r.matches });
    });
  };

  const wv = () => webviews.current.get(activeId) as unknown as {
    goBack(): void; goForward(): void; reload(): void; canGoBack(): boolean; canGoForward(): boolean;
    executeJavaScript(code: string): Promise<unknown>; capturePage(): Promise<{ toDataURL(): string }>; getURL(): string; getTitle(): string;
    findInPage(text: string, opts?: { forward?: boolean; findNext?: boolean }): void; stopFindInPage(action: string): void;
  } | undefined;

  function go(url: string) {
    setTabs((ts) => ts.map((t) => (t.id === activeId ? { ...t, url, title: hostOf(url) } : t)));
    note({ kind: "opened", label: "Opened", detail: hostOf(url) });
    setNotice(null);
  }

  function openNew(url: string) {
    const id = newId();
    setTabs((ts) => [...ts, { id, url, title: hostOf(url) }]);
    setActiveId(id);
    note({ kind: "opened", label: "Opened", detail: hostOf(url) });
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
      if (!r.ok) setNotice(r.error ?? "That search did not run.");
      note({ kind: "searched", label: "Searched", detail: text });
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
      note({ kind: "read", label: "Read page text" });
      let shot: string | undefined;
      try {
        shot = (await view.capturePage()).toDataURL();
      } catch {
        /* the thumbnail is decoration; a page that will not capture still sends its text */
      }
      onSendToChat(
        `Here is the text of ${url}:\n\n${clipped}\n\nWhat should I know from this page?`,
        [],
        drain({ title: titleOf(view, url), url, shot }),
      );
    } catch (e) {
      setNotice(`Could not read the page: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** Sends the page to the chat with a summarising question already written. */
  async function summarise() {
    const view = wv();
    if (!view || !active.url) { setNotice("The page is not ready yet."); return; }
    try {
      const text = (await view.executeJavaScript("document.body ? document.body.innerText : ''")) as string;
      const url = view.getURL();
      const clipped = String(text ?? "").slice(0, 20_000).trim();
      if (!clipped) { setNotice("This page has no readable text to summarise."); return; }
      note({ kind: "read", label: "Read page text" });
      onSendToChat(
        `Summarise this page in a few sentences, then list its main points. If it is mostly navigation or boilerplate, say so instead of inventing a summary.\n\nFrom ${url}:\n\n${clipped}`,
        [],
        drain({ title: titleOf(view, url), url }),
      );
    } catch (e) {
      setNotice(`Could not read the page: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  function runFind(next = false) {
    const view = wv();
    const q = find.trim();
    if (!view) return;
    if (!q) { view.stopFindInPage("clearSelection"); setMatches(null); return; }
    view.findInPage(q, next ? { findNext: true, forward: true } : undefined);
  }

  function closeFind() {
    setFindOpen(false);
    setFind("");
    setMatches(null);
    try { wv()?.stopFindInPage("clearSelection"); } catch { /* the guest may be gone */ }
  }

  async function saveScreenshot() {
    const view = wv();
    if (!view || !active.url) return;
    try {
      const image = await view.capturePage();
      note({ kind: "captured", label: "Captured page" });
      const saved = await api.saveScreenshot(image.toDataURL());
      setNotice(saved ? `Saved ${saved}` : null);
    } catch (e) {
      setNotice(`Could not take a screenshot: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** Hands the page to the chat as an image, for a vision model to describe. Nothing is sent until the person presses Send. */
  async function askAboutScreenshot() {
    const view = wv();
    if (!view || !active.url) return;
    try {
      const image = await view.capturePage();
      const shot = image.toDataURL();
      note({ kind: "captured", label: "Captured page" });
      const url = view.getURL();
      onSendToChat("What is on this page? Describe what you can see.", [shot], drain({ title: titleOf(view, url), url, shot }));
    } catch (e) {
      setNotice(`Could not take a screenshot: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const resultList = results && (
    <ol className="browser-results">
      {results.results.map((s) => (
        <li key={s.url}>
          <button className="linkbtn" onClick={() => openNew(s.url)}>{s.title}</button>
          <span className="searchcard-host num">{s.source}</span>
          <div className="hint">{s.snippet}</div>
        </li>
      ))}
      {results.results.length === 0 && (
        <li className="hint">{results.ok ? results.note || "Nothing matched." : results.error}</li>
      )}
    </ol>
  );

  return (
    <div className={`browser${compact ? " compact" : ""}`}>
      <div className="browser-tabs" role="tablist" aria-label="Browser tabs">
        {tabs.map((t) => (
          <div key={t.id} className={`browser-tab${t.id === activeId ? " on" : ""}`}>
            <button role="tab" aria-selected={t.id === activeId} className="browser-tab-btn" onClick={() => setActiveId(t.id)}>
              {t.title}
            </button>
            <button className="browser-tab-x" aria-label={`Close ${t.title}`} onClick={() => closeTab(t.id)}>×</button>
          </div>
        ))}
        <button className="browser-tab-new" aria-label="New tab" onClick={() => openNew(HOME)}>+</button>
        {onClose && (
          <button className="browser-tab-x browser-close" aria-label="Close browser" onClick={onClose}>×</button>
        )}
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
        <button type="button" className="browser-action" disabled={!active.url} onClick={() => void readPage()} title="Send page to chat">{compact ? "Send page" : "Send page to chat"}</button>
        <button type="button" className="browser-action" disabled={!active.url} onClick={() => void askAboutScreenshot()} title="Ask about screenshot">{compact ? "Ask" : "Ask about screenshot"}</button>
        <button type="button" className="browser-action" disabled={!active.url} onClick={() => void saveScreenshot()} title="Save screenshot">{compact ? "Save" : "Save screenshot"}</button>
        <button type="button" className="browser-action" disabled={!active.url} onClick={() => void summarise()} title="Summarise this page">{compact ? "Sum" : "Summarise"}</button>
        <button type="button" className="browser-action" aria-pressed={findOpen} onClick={() => (findOpen ? closeFind() : setFindOpen(true))} title="Find in page">Find</button>
      </form>

      {findOpen && (
        <form
          className="browser-find"
          onSubmit={(e) => { e.preventDefault(); runFind(true); }}
        >
          <input
            autoFocus
            aria-label="Find in page"
            placeholder="Find on this page"
            value={find}
            onChange={(e) => { setFind(e.target.value); }}
            onKeyUp={(e) => { if (e.key !== "Enter") runFind(false); }}
          />
          <span className="hint num">
            {find.trim() ? (matches ? `${matches.total ? matches.active : 0}/${matches.total}` : "…") : ""}
          </span>
          <button type="submit" className="browser-nav" aria-label="Next match">↓</button>
          <button type="button" className="browser-nav" aria-label="Close find" onClick={closeFind}>×</button>
        </form>
      )}

      {loading && <div className="browser-loading" role="status" aria-label="Loading"><i /></div>}

      {loadError && (
        <div className="browser-error" role="status">
          <strong>This page did not load.</strong> {loadError}
          <button type="button" className="ghostbtn" onClick={() => { setLoadError(null); wv()?.reload(); }}>Try again</button>
        </div>
      )}

      {notice && <div className="browser-notice" role="status">{notice}</div>}

      {active.url && results && (
        <div className="browser-results-pane" role="region" aria-label="Search results">
          <div className="browser-results-head">
            <span>{results.label ?? "Search"} results for “{query}”</span>
            <button type="button" aria-label="Close results" onClick={() => setResults(null)}>×</button>
          </div>
          {resultList}
        </div>
      )}

      {active.url ? (
        <webview
          key={active.id}
          ref={(el: HTMLElement | null) => attach(el, active.id)}
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
          {resultList}
        </div>
      )}
    </div>
  );
}
