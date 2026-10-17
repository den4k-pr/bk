/**
 * Чи показується зараз "зовнішнє" повноекранне вікно поверх застосунку:
 * реклама (interstitial) або системне вікно оплати App Store / Google Play.
 *
 * Такі вікна переводять застосунок у 'inactive'/'background' (на Android
 * реклама й Google Play — окремі Activity; на iOS аркуш оплати з Face ID
 * робить застосунок inactive), і повернення з них App.tsx сприймав як
 * "довгий фон": обривав УСІ запити (зокрема перевірку покупки на сервері —
 * звідси хибна помилка, після якої покупка все одно проходила), клав
 * Preloader поверх екрана і перезапускав initializeApp.
 * Цей модуль дозволяє App.tsx відрізнити такий "фон" від справжнього.
 */

export type ExternalFlowKind = 'ad' | 'purchase';

// Якщо подія завершення так і не прийде — не вважаємо вікно відкритим вічно.
const MAX_FLOW_DURATION_MS: Record<ExternalFlowKind, number> = {
  ad: 3 * 60 * 1000,
  purchase: 5 * 60 * 1000,
};

let nextFlowId = 1;
const activeFlows = new Map<number, { kind: ExternalFlowKind; since: number }>();
let lastEndedAt = 0;

const pruneStaleFlows = (): void => {
  const now = Date.now();
  activeFlows.forEach((flow, id) => {
    if (now - flow.since > MAX_FLOW_DURATION_MS[flow.kind]) activeFlows.delete(id);
  });
};

/** Позначає початок зовнішнього вікна. Повертає функцію завершення (можна викликати кілька разів). */
export const beginExternalFlow = (kind: ExternalFlowKind): (() => void) => {
  const id = nextFlowId++;
  activeFlows.set(id, { kind, since: Date.now() });
  return () => {
    if (activeFlows.delete(id)) lastEndedAt = Date.now();
  };
};

/** Чи було зовнішнє вікно на екрані в будь-який момент після `since` (мс). */
export const wasExternalFlowActiveSince = (since: number): boolean => {
  pruneStaleFlows();
  if (activeFlows.size > 0) return true;
  return lastEndedAt >= since;
};

// ── Реклама (сумісний API) ─────────────────────────────────────────────
let endAdFlow: (() => void) | null = null;

export const markFullscreenAdStart = (): void => {
  endAdFlow?.();
  endAdFlow = beginExternalFlow('ad');
};

export const markFullscreenAdEnd = (): void => {
  endAdFlow?.();
  endAdFlow = null;
};

export const wasFullscreenAdActiveSince = wasExternalFlowActiveSince;
