export type DifferenceStatus = 'same' | 'changed' | 'added' | 'removed' | 'misaligned';

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

export interface CollationOpinion {
  id: string;
  note: string;
  source: string;
  handler: string;
  createdAt: string;
  /** 未被采纳时填写的否决原因 */
  rejectionReason: string;
}

export interface AlignmentRow {
  id: string;
  left?: TextUnit;
  right?: TextUnit;
  status: DifferenceStatus;
  similarity: number;
  /** @deprecated 旧草稿的单条校记，迁移后清空，仅用于读取旧数据 */
  note?: string;
  /** @deprecated 旧草稿的单一来源，迁移后清空，仅用于读取旧数据 */
  source?: string;
  /** 自动对齐时生成的对齐说明（非校勘意见） */
  systemNote?: string;
  opinions: CollationOpinion[];
  adoptedOpinionId: string | null;
  accepted: boolean;
  manuallyAdjusted: boolean;
}

export interface ComparisonRules {
  ignorePunctuation: boolean;
  ignoreVariants: boolean;
  candidateWindow: number;
}

export interface PersistedCollationState {
  versions: VersionDocument[];
  leftVersionId: string;
  rightVersionId: string;
  rows: AlignmentRow[];
  rules: ComparisonRules;
  selectedRowId: string;
}
