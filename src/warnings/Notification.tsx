import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";

// ─── Types ────────────────────────────────────────────────────────────────────

export type NotifyType = "info" | "success" | "error" | "warning";

export interface NotifyOptions {
  type?: NotifyType;
  duration?: number; // ms — 0 for persistent
  action?: { label: string; onClick: () => void };
}

interface NotificationItem extends NotifyOptions {
  id: string;
  message: string;
  exiting: boolean;
}

// ─── Context ──────────────────────────────────────────────────────────────────

interface NotifyContextValue {
  add: (message: string, options?: NotifyOptions) => string;
  dismiss: (id: string) => void;
}

const NotifyContext = createContext<NotifyContextValue | null>(null);

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useNotify() {
  const ctx = useContext(NotifyContext);
  if (!ctx) throw new Error("useNotify must be used inside <NotificationProvider>");

  return {
    notify:  (msg: string, opts?: NotifyOptions) => ctx.add(msg, opts),
    success: (msg: string, opts?: Omit<NotifyOptions, "type">) => ctx.add(msg, { ...opts, type: "success" }),
    error:   (msg: string, opts?: Omit<NotifyOptions, "type">) => ctx.add(msg, { ...opts, type: "error" }),
    warning: (msg: string, opts?: Omit<NotifyOptions, "type">) => ctx.add(msg, { ...opts, type: "warning" }),
    info:    (msg: string, opts?: Omit<NotifyOptions, "type">) => ctx.add(msg, { ...opts, type: "info" }),
    dismiss: ctx.dismiss,
  };
}

// ─── Provider ─────────────────────────────────────────────────────────────────

export function NotificationProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<NotificationItem[]>([]);
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const active = useRef<Map<string, string>>(new Map()); // dedupKey -> id

  const dismiss = useCallback((id: string) => {
    clearTimeout(timers.current.get(id));
    timers.current.delete(id);
    for (const [key, val] of active.current.entries()) {
      if (val === id) { active.current.delete(key); break; }
    }
    setItems((prev) => prev.map((n) => (n.id === id ? { ...n, exiting: true } : n)));
    setTimeout(() => setItems((prev) => prev.filter((n) => n.id !== id)), 300);
  }, []);

  const add = useCallback(
    (message: string, options: NotifyOptions = {}): string => {
      const type = options.type ?? "info";
      const dedupKey = `${type}::${message}`;

      if (active.current.has(dedupKey)) return active.current.get(dedupKey)!;

      const id = `n-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const duration = options.duration ?? 4500;

      active.current.set(dedupKey, id);
      setItems((prev) => [...prev, { id, message, exiting: false, ...options }]);
      if (duration > 0) {
        timers.current.set(id, setTimeout(() => dismiss(id), duration));
      }
      return id;
    },
    [dismiss]
  );

  useEffect(() => {
    const t = timers.current;
    return () => t.forEach((timer) => clearTimeout(timer));
  }, []);

  return (
    <NotifyContext.Provider value={{ add, dismiss }}>
      {children}
      <style>{CSS}</style>
      <div className="notify-stack" role="region" aria-label="Notifications" aria-live="polite">
        {items.map((item) => (
          <NotificationBanner key={item.id} item={item} onDismiss={dismiss} />
        ))}
      </div>
    </NotifyContext.Provider>
  );
}

// ─── Banner ───────────────────────────────────────────────────────────────────

function NotificationBanner({
  item,
  onDismiss,
}: {
  item: NotificationItem;
  onDismiss: (id: string) => void;
}) {
  const type = item.type ?? "info";

  return (
    <div
      className={`notify-item notify-${type}${item.exiting ? " notify-exit" : ""}`}
      role="alert"
    >
      <span className="notify-icon" aria-hidden="true" dangerouslySetInnerHTML={{ __html: ICONS[type] }} />
      <div className="notify-body">
        <span className="notify-message">{item.message}</span>
        {item.action && (
          <button
            className="notify-action"
            onClick={() => { item.action!.onClick(); onDismiss(item.id); }}
          >
            {item.action.label}
          </button>
        )}
      </div>
      <button className="notify-close" onClick={() => onDismiss(item.id)} aria-label="Dismiss">
        <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
          <path d="M2 2l10 10M12 2L2 12" />
        </svg>
      </button>
    </div>
  );
}

// ─── Icons ────────────────────────────────────────────────────────────────────

const ICONS: Record<NotifyType, string> = {
  success: `<svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.857-9.809a.75.75 0 00-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 10-1.06 1.061l2.5 2.5a.75.75 0 001.137-.089l4-5.5z" clip-rule="evenodd"/></svg>`,
  error:   `<svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.28 7.22a.75.75 0 00-1.06 1.06L8.94 10l-1.72 1.72a.75.75 0 101.06 1.06L10 11.06l1.72 1.72a.75.75 0 101.06-1.06L11.06 10l1.72-1.72a.75.75 0 00-1.06-1.06L10 8.94 8.28 7.22z" clip-rule="evenodd"/></svg>`,
  warning: `<svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 5zm0 9a1 1 0 100-2 1 1 0 000 2z" clip-rule="evenodd"/></svg>`,
  info:    `<svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a.75.75 0 000 1.5h.253a.25.25 0 01.244.304l-.459 2.066A1.75 1.75 0 0010.747 15H11a.75.75 0 000-1.5h-.253a.25.25 0 01-.244-.304l.459-2.066A1.75 1.75 0 009.253 9H9z" clip-rule="evenodd"/></svg>`,
};

// ─── Styles ───────────────────────────────────────────────────────────────────

const CSS = `
  @keyframes notify-in {
    from { opacity: 0; transform: translateY(-10px) scale(0.97); }
    to   { opacity: 1; transform: translateY(0)     scale(1);    }
  }
  @keyframes notify-out {
    from { opacity: 1; transform: scale(1);    max-height: 80px; margin-bottom: 10px; }
    to   { opacity: 0; transform: scale(0.96); max-height: 0;    margin-bottom: 0;   }
  }
  .notify-stack {
    position: fixed;
    top: 20px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 9999;
    display: flex;
    flex-direction: column;
    gap: 10px;
    align-items: center;
    width: max-content;
    max-width: min(460px, calc(100vw - 32px));
    pointer-events: none;
  }
  .notify-item {
    pointer-events: all;
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 12px 14px;
    border-radius: 10px;
    width: 100%;
    background: #fff;
    border: 1px solid rgba(0,0,0,0.08);
    box-shadow: 0 4px 16px rgba(0,0,0,0.1), 0 1px 3px rgba(0,0,0,0.06);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    font-size: 14px;
    line-height: 1.45;
    animation: notify-in 0.25s cubic-bezier(0.16, 1, 0.3, 1) both;
    overflow: hidden;
  }
  .notify-item.notify-exit {
    animation: notify-out 0.28s ease both;
  }
  .notify-icon { flex-shrink: 0; width: 18px; height: 18px; margin-top: 1px; }
  .notify-icon svg { width: 100%; height: 100%; display: block; }
  .notify-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
  .notify-message { color: #111; font-weight: 500; }
  .notify-action {
    background: none; border: none; padding: 0; cursor: pointer;
    font-size: 13px; font-weight: 600; text-decoration: underline;
    text-underline-offset: 2px; text-align: left;
  }
  .notify-close {
    flex-shrink: 0; background: none; border: none; cursor: pointer;
    padding: 2px; border-radius: 4px; color: #aaa; display: flex;
    transition: color 0.15s, background 0.15s;
  }
  .notify-close:hover { color: #333; background: rgba(0,0,0,0.06); }
  .notify-close svg { width: 14px; height: 14px; }
  .notify-success .notify-icon, .notify-success .notify-action { color: #16a34a; }
  .notify-error   .notify-icon, .notify-error   .notify-action { color: #dc2626; }
  .notify-warning .notify-icon, .notify-warning .notify-action { color: #d97706; }
  .notify-info    .notify-icon, .notify-info    .notify-action { color: #2563eb; }
  @media (prefers-color-scheme: dark) {
    .notify-item { background: #1c1c1e; border-color: rgba(255,255,255,0.1); }
    .notify-message { color: #f2f2f7; }
    .notify-close { color: #555; }
    .notify-close:hover { color: #ccc; background: rgba(255,255,255,0.08); }
  }
  @media (prefers-reduced-motion: reduce) {
    .notify-item, .notify-item.notify-exit { animation: none; }
  }
`;