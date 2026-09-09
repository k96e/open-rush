/**
 * `(created_at, id)` keyset 分页游标（M2 抽出，M3 的三个 store 共用）。
 *
 * 游标 = base64url("<createdAtISO>|<id>")，对客户端不透明。`id` 是并列时的
 * tiebreaker，避免同毫秒创建的两行互相顶掉（与 `AgentDefinitionService` 同款）。
 */

export interface KeysetCursor {
  createdAt: Date;
  id: string;
}

export function encodeKeysetCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`, 'utf8').toString('base64url');
}

/** 解析失败一律返回 null（回落到「第一页」），不因为一个装饰性字段报 400。 */
export function decodeKeysetCursor(cursor: string | undefined): KeysetCursor | null {
  if (!cursor) return null;
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    const sep = raw.indexOf('|');
    if (sep < 0) return null;
    const iso = raw.slice(0, sep);
    const id = raw.slice(sep + 1);
    if (!iso || !id) return null;
    const createdAt = new Date(iso);
    if (Number.isNaN(createdAt.getTime())) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}

/** 1..200，默认 50。 */
export function clampLimit(raw: number | undefined): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 1) return 50;
  return Math.min(Math.floor(raw), 200);
}
