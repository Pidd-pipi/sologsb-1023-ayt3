export type DifferenceStatus = 'same' | 'changed' | 'added' | 'removed' | 'misaligned';

/** 一条校记意见的处理结论：待定 / 采纳 / 否决 */
export type OpinionVerdict = 'pending' | 'adopted' | 'rejected';

export interface TextUnit {
  id: string;
  paragraphId: string;
  paragraphOrder: number;
  sentenceOrder: number;
  paragraphText: string;
  text: string;
}

export interface VersionDocument {
  id: string;
  name: string;
  source: string;
  createdAt: string;
  text: string;
  units: TextUnit[];
}

/**
 * 同一处异文可以有多位整理者先后追加意见，互不覆盖。
 * 每条意见独立保留校记内容、出处来源、处理人以及采纳/否决结论。
 */
export interface CollationOpinion {
  id: string;
  note: string;
  source: string;
  author: string;
  createdAt: string;
  verdict: OpinionVerdict;
  /** 否决时必须写明的否决原因 */
  rejectReason: string;
  judgedAt?: string;
  /** 由 v1 单行校记草稿迁移而来的意见 */
  migrated?: boolean;
}

export interface AlignmentRow {
  id: string;
  left?: TextUnit;
  right?: TextUnit;
  status: DifferenceStatus;
  similarity: number;
  /** 行是否已完成：相同行自动完成；差异行须具备有效采纳结论并经接受确认 */
  accepted: boolean;
  manuallyAdjusted: boolean;
  opinions: CollationOpinion[];
  /** 仅用于读取 v1 旧草稿，新数据不再写入 */
  note?: string;
  source?: string;
}

export interface ComparisonRules {
  ignorePunctuation: boolean;
  ignoreVariants: boolean;
  candidateWindow: number;
}

export interface PersistedCollationState {
  schemaVersion: number;
  versions: VersionDocument[];
  leftVersionId: string;
  rightVersionId: string;
  rows: AlignmentRow[];
  rules: ComparisonRules;
  selectedRowId: string;
  currentAuthor: string;
}

export interface AcceptResult {
  accepted: number;
  skipped: number;
  skippedReason: string;
}
