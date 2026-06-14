"use client";

import { useCallback, useEffect, useState } from "react";
import styles from "./cache-debug-dashboard.module.css";

type DebugPayload = {
  snapshot: {
    instanceId: string;
    debugBox?: string;
    redis: { status: string; cooldownMs: number | null; pubSubReady: boolean };
    l1: { size: number; max: number; calculatedSize: number; maxSize: number; ttlMs: number };
    l1Entries: {
      key: string;
      tags: string[];
      ageMs: number;
      size: number;
      createdAt: string;
      cacheLayer?: string | null;
      instanceId?: string;
    }[];
    tagTimestamps: { tag: string; invalidatedAt: number; ageMs: number }[];
    pendingSets: number;
    pendingLocks?: {
      key: string;
      acquiredAt: number;
      instanceId: string;
      cacheLayer?: string | null;
      ageMs: number;
    }[];
  } | null;
  events: {
    ts: number;
    op: string;
    outcome: string;
    summary: string;
    instanceId?: string;
    fields?: Record<string, string | number | boolean | string[]>;
  }[];
  legend?: { ops: Record<string, string>; outcomes: Record<string, string> };
};

const LAYER_CLASS: Record<string, string> = {
  DATA: styles.layerData,
  UI: styles.layerUi,
  SOFT: styles.layerSoft,
  "DATA+UI": styles.layerDataUi,
};

const STORAGE_CLASS: Record<string, string> = {
  L1: styles.storageL1,
  L2: styles.storageL2,
};

const OUTCOME_CLASS: Record<string, string> = {
  HIT: styles.outcomeHit,
  MISS: styles.outcomeMiss,
  STALE: styles.outcomeStale,
  WRITE: styles.outcomeWrite,
  SYNC: styles.outcomeSync,
  CLEAR: styles.outcomeClear,
  ACQUIRED: styles.outcomeAcquired,
  RELEASED: styles.outcomeReleased,
  WAIT: styles.outcomeWait,
  COOLDOWN: styles.outcomeCooldown,
  END: styles.outcomeEnd,
};

const GROUP_CLASS: Record<EventGroupKind, string> = {
  key: styles.groupKey,
  tags: styles.groupTags,
  system: styles.groupSystem,
};

const GROUP_HEADER_CLASS: Record<EventGroupKind, string> = {
  key: styles.groupHeaderKey,
  tags: styles.groupHeaderTags,
  system: styles.groupHeaderSystem,
};

function formatAge(ms: number) {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${(ms / 60_000).toFixed(1)} min`;
}

function formatTime(ts: number) {
  return new Date(ts).toISOString().slice(11, 23);
}

function MonoBlock({
  text,
  wrap = false,
  size = "xs",
}: {
  text: string;
  wrap?: boolean;
  size?: "xs" | "sm";
}) {
  const codeClass = wrap
    ? styles.monoCodeWrap
    : size === "sm"
      ? styles.monoCodeSm
      : styles.monoCodeScroll;

  return (
    <div className={styles.monoBlock} title={text}>
      <code className={codeClass}>{text}</code>
    </div>
  );
}

type DebugEvent = DebugPayload["events"][number];

type EventGroupKind = "key" | "tags" | "system";

type EventGroup = {
  id: string;
  kind: EventGroupKind;
  label: string;
  events: DebugEvent[];
};

function fieldTags(value: string | number | boolean | string[] | undefined): string | null {
  if (value == null) return null;
  if (Array.isArray(value)) return value.length ? value.join(", ") : null;
  const s = String(value);
  return s && s !== "(none)" ? s : null;
}

function eventGroupMeta(event: DebugEvent): { id: string; kind: EventGroupKind; label: string } {
  const f = event.fields;

  if (f?.key) {
    const key = String(f.key);
    return { id: `key:${key}`, kind: "key", label: key };
  }

  const tags = fieldTags(f?.tags);
  if (tags) {
    return { id: `tags:${tags}`, kind: "tags", label: tags };
  }

  if (event.op === "INVALIDATE" && f?.deletedEntries != null) {
    return { id: "tags:invalidation", kind: "tags", label: "invalidation (no tag in fields)" };
  }

  if (event.op === "PUBSUB") {
    const pubTags = fieldTags(f?.tags);
    if (pubTags) return { id: `tags:${pubTags}`, kind: "tags", label: `Pub/Sub · ${pubTags}` };
  }

  if (event.op === "REFRESH") {
    return { id: "system:refresh", kind: "system", label: "refreshTags() — sync before request" };
  }

  if (event.op === "REDIS") {
    const role = f?.role ? String(f.role) : "connection";
    return { id: `system:redis:${role}`, kind: "system", label: `Redis · ${role}` };
  }

  return { id: `system:${event.op}`, kind: "system", label: event.op };
}

function groupEventsAggregate(events: DebugEvent[]): EventGroup[] {
  const map = new Map<string, EventGroup>();

  for (const event of events) {
    const meta = eventGroupMeta(event);
    const group = map.get(meta.id) ?? { id: meta.id, kind: meta.kind, label: meta.label, events: [] };
    group.events.push(event);
    map.set(meta.id, group);
  }

  return [...map.values()]
    .map((group) => ({
      ...group,
      events: [...group.events].sort((a, b) => a.ts - b.ts),
    }))
    .sort((a, b) => (a.events[0]?.ts ?? 0) - (b.events[0]?.ts ?? 0));
}

function eventFlowSummary(events: DebugEvent[]): string {
  const counts = new Map<string, number>();
  for (const event of events) {
    const label = `${event.op} ${event.outcome}`;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([label, count]) => (count > 1 ? `${label}×${count}` : label))
    .join(" → ");
}

function groupCacheLayer(events: DebugEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const layer = events[i].fields?.cacheLayer;
    if (layer) return String(layer);
  }
  return null;
}

function CacheLayerBadge({ layer }: { layer: string }) {
  return (
    <span className={LAYER_CLASS[layer] ?? styles.layerDefault}>{layer}</span>
  );
}

function StorageLayerBadge({ layer }: { layer: string }) {
  return (
    <span className={STORAGE_CLASS[layer] ?? styles.layerDefault}>{layer}</span>
  );
}

type L1TagGroup = {
  tags: string;
  entries: NonNullable<DebugPayload["snapshot"]>["l1Entries"];
};

function groupL1ByTags(entries: NonNullable<DebugPayload["snapshot"]>["l1Entries"]): L1TagGroup[] {
  const map = new Map<string, L1TagGroup["entries"]>();

  for (const entry of entries) {
    const tags = entry.tags.length ? entry.tags.join(", ") : "(no tags)";
    const list = map.get(tags) ?? [];
    list.push(entry);
    map.set(tags, list);
  }

  return [...map.entries()]
    .map(([tags, groupEntries]) => ({ tags, entries: groupEntries }))
    .sort((a, b) => b.entries.length - a.entries.length);
}

type Props = {
  token: string;
};

export function CacheDebugDashboard({ token }: Props) {
  const [data, setData] = useState<DebugPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);

  const fetchDebug = useCallback(async () => {
    try {
      const res = await fetch(`/api/cache-debug?token=${encodeURIComponent(token)}`, {
        cache: "no-store",
      });
      if (!res.ok) {
        setError("Unauthorized or debug disabled");
        return;
      }
      setData(await res.json());
      setError(null);
    } catch {
      setError("Failed to fetch debug data");
    }
  }, [token]);

  useEffect(() => {
    fetchDebug();
    if (paused) return;
    const id = setInterval(fetchDebug, 2000);
    return () => clearInterval(id);
  }, [fetchDebug, paused]);

  const snap = data?.snapshot;

  return (
    <div className={styles.root}>
      <div className={styles.spacer}>
        <header className={styles.header}>
          <div className={styles.headerRow}>
            <h1 className={styles.title}>Remote cache debug</h1>
            <span className={styles.instanceBadge}>per instance</span>
          </div>
          <p className={styles.description}>
            Live view of this container. Events and L1 are merged from all Node workers (main +
            render workers) via Redis{" "}
            <code className={styles.inlineCode}>meta:debug-*</code>. With nginx, check{" "}
            <code className={styles.inlineCode}>X-Upstream</code> or ports 3000–3007. Badges:{" "}
            <CacheLayerBadge layer="DATA" /> data tags · <CacheLayerBadge layer="UI" /> ui tags ·{" "}
            <CacheLayerBadge layer="SOFT" /> soft path tags.
          </p>
          <div className={styles.actions}>
            <button type="button" onClick={() => fetchDebug()} className={styles.btn}>
              Refresh now
            </button>
            <button type="button" onClick={() => setPaused((p) => !p)} className={styles.btn}>
              {paused ? "Resume auto-refresh" : "Pause auto-refresh"}
            </button>
            <a
              href={`/api/cache-debug?token=${encodeURIComponent(token)}`}
              className={styles.btn}
              target="_blank"
              rel="noreferrer"
            >
              JSON
            </a>
            <a
              href={`/api/cache-debug?token=${encodeURIComponent(token)}`}
              className={styles.btn}
              onClick={(e) => {
                e.preventDefault();
                void fetch(`/api/cache-debug?token=${encodeURIComponent(token)}`, {
                  headers: { Accept: "text/plain" },
                })
                  .then((r) => r.text())
                  .then((t) => {
                    const w = window.open("", "_blank");
                    if (w) {
                      w.document.write(
                        `<pre style="font:13px/1.5 monospace;padding:1rem">${t.replace(/</g, "&lt;")}</pre>`,
                      );
                    }
                  });
              }}
            >
              Plain text log
            </a>
          </div>
          {error && <p className={styles.error}>{error}</p>}
        </header>

        {snap && (
          <section className={styles.stats}>
            <StatCard label="Instance" value={snap.instanceId} mono />
            <StatCard
              label="Redis"
              value={`${snap.redis.status}${snap.redis.cooldownMs ? ` · cooldown ${formatAge(snap.redis.cooldownMs)}` : ""}`}
              sub={snap.redis.pubSubReady ? "Pub/Sub active" : "Pub/Sub not connected"}
            />
            <StatCard
              label="L1 LRU"
              value={`${snap.l1.size} / ${snap.l1.max} entries`}
              sub={`${Math.round(snap.l1.calculatedSize / 1024)} / ${Math.round(snap.l1.maxSize / 1024)} KB · TTL ${snap.l1.ttlMs} ms`}
            />
            <StatCard label="In-flight set()" value={String(snap.pendingSets)} />
            {snap.debugBox && <StatCard label="Debug box" value={snap.debugBox} mono />}
          </section>
        )}

        {snap && snap.pendingLocks && snap.pendingLocks.length > 0 && (
          <section className={styles.pendingSection}>
            <h2 className={styles.sectionTitle}>
              Pending render locks
              <span className={styles.sectionSubtitle}>GET ACQUIRED — awaiting set()</span>
            </h2>
            <ul className={styles.pendingList}>
              {snap.pendingLocks.map((row) => (
                <li key={row.key} className={styles.pendingItem}>
                  <MonoBlock text={row.key} />
                  <div className={styles.pendingMeta}>
                    <span className={styles.fieldValueMono}>{row.instanceId}</span>
                    <span>· {formatAge(row.ageMs)}</span>
                    {row.cacheLayer && <CacheLayerBadge layer={row.cacheLayer} />}
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}

        {snap && (
          <section className={styles.panels}>
            <div className={styles.panel}>
              <h2 className={styles.panelHeader}>Tag invalidation timestamps (local)</h2>
              <div className={styles.panelBody}>
                {snap.tagTimestamps.length === 0 ? (
                  <p className={styles.empty}>No tags invalidated on this instance yet.</p>
                ) : (
                  <table className={styles.table}>
                    <thead className={styles.tableHead}>
                      <tr>
                        <th>Tag</th>
                        <th>Invalidated</th>
                        <th>Age</th>
                      </tr>
                    </thead>
                    <tbody className={styles.tableBody}>
                      {snap.tagTimestamps.map((row) => (
                        <tr key={row.tag} className={styles.tableRow}>
                          <td>{row.tag}</td>
                          <td>{new Date(row.invalidatedAt).toISOString()}</td>
                          <td>{formatAge(row.ageMs)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>

            <div className={styles.panel}>
              <h2 className={styles.panelHeader}>
                L1 entries (hot cache)
                <span className={styles.panelHeaderHint}>grouped by tags</span>
              </h2>
              <div className={styles.panelBody}>
                {snap.l1Entries.length === 0 ? (
                  <p className={styles.empty}>L1 is empty.</p>
                ) : (
                  <ul className={styles.l1Groups}>
                    {groupL1ByTags(snap.l1Entries).map((group) => (
                      <li key={group.tags} className={styles.l1Group}>
                        <div className={styles.l1GroupHeader}>
                          <span className={styles.l1GroupTagsMuted}>tags · </span>
                          <span className={styles.l1GroupTagsMono}>{group.tags}</span>
                          <span className={styles.l1GroupCount}>
                            ({group.entries.length}{" "}
                            {group.entries.length === 1 ? "wpis" : "wpisy"})
                          </span>
                        </div>
                        <ul className={styles.l1Entries}>
                          {group.entries.map((row) => (
                            <li key={row.key} className={styles.l1Entry}>
                              <MonoBlock text={row.key} />
                              <div className={styles.l1EntryMeta}>
                                <span>
                                  {formatAge(row.ageMs)} · {row.size} B · {row.createdAt}
                                </span>
                                {row.cacheLayer && <CacheLayerBadge layer={row.cacheLayer} />}
                                {row.instanceId && (
                                  <span className={styles.l1EntryInstance}>{row.instanceId}</span>
                                )}
                              </div>
                            </li>
                          ))}
                        </ul>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </section>
        )}

        <section className={styles.timelineSection}>
          <h2 className={styles.panelHeader}>
            Event timeline
            <span className={styles.panelHeaderHint}>
              aggregated by key or tags · full lock flow (GET ACQUIRED → SET WRITE → RELEASED)
            </span>
          </h2>
          <div className={styles.timelineBody}>
            {!data?.events.length ? (
              <p className={styles.empty}>
                No events yet — try a dynamic locale (e.g. /fr/fr/cache-lab).
              </p>
            ) : (
              <ol className={styles.timeline}>
                {groupEventsAggregate(data.events).map((group) => {
                  const cacheLayer = groupCacheLayer(group.events);
                  const flow = eventFlowSummary(group.events);
                  return (
                    <li key={group.id} className={GROUP_CLASS[group.kind]}>
                      <div className={GROUP_HEADER_CLASS[group.kind]}>
                        <div className={styles.groupHeaderRow}>
                          <span className={styles.groupKind}>
                            {group.kind === "key"
                              ? "cache key"
                              : group.kind === "tags"
                                ? "tags"
                                : "system"}
                          </span>
                          {cacheLayer && <CacheLayerBadge layer={cacheLayer} />}
                          <span className={styles.groupCount}>
                            {group.events.length}{" "}
                            {group.events.length === 1 ? "zdarzenie" : "zdarzenia"}
                          </span>
                        </div>
                        {flow && <div className={styles.flowSummary}>{flow}</div>}
                        {group.kind === "key" ? (
                          <MonoBlock text={group.label} size="sm" />
                        ) : (
                          <MonoBlock text={group.label} wrap />
                        )}
                      </div>

                      <ol className={styles.eventList}>
                        {group.events.map((event, i) => (
                          <EventRow
                            key={`${event.ts}-${event.instanceId ?? ""}-${i}`}
                            event={event}
                            compact
                          />
                        ))}
                      </ol>
                    </li>
                  );
                })}
              </ol>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

function StatCard({
  label,
  value,
  sub,
  mono,
}: {
  label: string;
  value: string;
  sub?: string;
  mono?: boolean;
}) {
  return (
    <div className={styles.statCard}>
      <div className={styles.statLabel}>{label}</div>
      <div className={mono ? styles.statValueMono : styles.statValue}>{value}</div>
      {sub && <div className={styles.statSub}>{sub}</div>}
    </div>
  );
}

const HIDDEN_IN_GROUP_FIELDS = new Set(["key", "tags", "cacheLayer"]);

function EventRow({ event, compact }: { event: DebugEvent; compact?: boolean }) {
  const visibleFields = event.fields
    ? Object.entries(event.fields).filter(([k]) => !compact || !HIDDEN_IN_GROUP_FIELDS.has(k))
    : [];
  const cacheLayer = event.fields?.cacheLayer ? String(event.fields.cacheLayer) : null;
  const storageLayer = event.fields?.layer ? String(event.fields.layer) : null;

  return (
    <li className={`${styles.eventRow} ${compact ? styles.eventRowCompact : ""}`}>
      <div className={styles.eventMeta}>
        <span className={styles.eventTime}>{formatTime(event.ts)}</span>
        <span className={styles.eventOp}>{event.op}</span>
        <span className={OUTCOME_CLASS[event.outcome] ?? styles.outcomeDefault}>
          {event.outcome}
        </span>
        {cacheLayer && <CacheLayerBadge layer={cacheLayer} />}
        {storageLayer && storageLayer !== "cooldown" && storageLayer !== "none" && (
          <StorageLayerBadge layer={storageLayer} />
        )}
        {event.instanceId && <span className={styles.eventInstance}>{event.instanceId}</span>}
      </div>
      <p className={styles.eventSummary}>{event.summary}</p>
      {visibleFields.length > 0 && (
        <dl className={styles.fieldList}>
          {visibleFields.map(([k, v]) => (
            <div key={k}>
              <dt className={styles.fieldLabel}>{k}</dt>
              <dd>
                {k === "key" || k === "keys" ? (
                  <MonoBlock
                    text={Array.isArray(v) ? v.join("\n") : String(v)}
                    wrap={k === "keys"}
                  />
                ) : (
                  <span className={styles.fieldValueMono}>
                    {Array.isArray(v) ? v.join(", ") : String(v)}
                  </span>
                )}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </li>
  );
}
