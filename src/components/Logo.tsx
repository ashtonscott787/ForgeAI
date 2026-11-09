import { useEffect, useState } from "react";
import { api } from "../lib/ipc";
import { Mark, markFor } from "./Marks";

/**
 * The model publisher's own logo.
 *
 * It is fetched from the publisher's page when the card is shown and cached
 * for a week — not bundled into the app, because these are other companies'
 * trade marks and redistributing them is not ours to do. Showing one the way a
 * browser shows a site's icon is a different matter. If the lookup fails, or
 * the publisher has no avatar, the built-in family mark is used instead, so a
 * card is never left blank.
 */
const CACHE = "forge.avatars.v1";
const WEEK = 7 * 24 * 60 * 60 * 1000;

type Row = { url: string | null; at: number };

function readCache(): Record<string, Row> {
  try {
    const raw = localStorage.getItem(CACHE);
    const v = raw ? JSON.parse(raw) : {};
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

function writeCache(author: string, url: string | null) {
  try {
    const all = readCache();
    all[author] = { url, at: Date.now() };
    localStorage.setItem(CACHE, JSON.stringify(all));
  } catch {
    /* a cache miss is not worth an error */
  }
}

export function Logo({ author, name, size = 26 }: { author: string; name: string; size?: number }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const key = author.trim().toLowerCase();
    if (!key) return;
    const cached = readCache()[key];
    if (cached && Date.now() - cached.at < WEEK) {
      setUrl(cached.url);
      return;
    }
    let live = true;
    void api
      .publisherAvatar(author)
      .then((r) => {
        if (!live) return;
        setUrl(r.avatar);
        writeCache(key, r.avatar);
      })
      .catch(() => {
        if (live) writeCache(key, null);
      });
    return () => {
      live = false;
    };
  }, [author]);

  if (!url || failed) return <Mark kind={markFor(`${name} ${author}`)} size={size} />;

  return (
    <span className="mark logo" style={{ width: size, height: size }}>
      <img src={url} alt="" width={size} height={size} onError={() => setFailed(true)} />
    </span>
  );
}
