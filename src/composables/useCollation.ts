import { computed, onMounted, ref, watch } from 'vue';
import { sampleVersions, splitIntoUnits } from '../data';
import type {
  AcceptResult,
  AlignmentRow,
  CollationOpinion,
  ComparisonRules,
  DifferenceStatus,
  OpinionVerdict,
  PersistedCollationState,
  TextUnit,
  VersionDocument
} from '../types';

const STORAGE_KEY = 'sologsb-1023/multi-version-collation/v1';
const SCHEMA_VERSION = 2;
const MAX_HISTORY = 50;

const variantMap: Record<string, string> = {
  為: '为',
  爲: '为',
  識: '识',
  強: '强',
  與: '与',
  猶: '犹',
  鄰: '邻',
  儼: '俨',
  渙: '涣',
  將: '将',
  樸: '朴',
  曠: '旷',
  濁: '浊',
  靜: '静',
  動: '动',
  玅: '妙',
  裏: '里',
  裡: '里',
  說: '说',
  國: '国'
};

function clone<T>(value: T): T {
  return structuredClone(value);
}

function yieldToBrowser() {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, 0);
  });
}

function createId(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function nowIso() {
  return new Date().toISOString();
}

function normalized(value: string, rules: ComparisonRules) {
  let result = value.toLocaleLowerCase().trim();
  if (rules.ignoreVariants) {
    result = Array.from(result, (character) => variantMap[character] ?? character).join('');
  }
  if (rules.ignorePunctuation) {
    result = result.replace(/[\s，。！？；：、“”‘’「」『』（）()《》〈〉·,.!?;:'"[\]{}<>—\-…]/g, '');
  }
  return result;
}

function similarity(left: string, right: string) {
  const a = Array.from(left);
  const b = Array.from(right);
  if (!a.length && !b.length) return 1;
  if (!a.length || !b.length) return 0;
  const previous = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = 0;
    for (let j = 1; j <= b.length; j += 1) {
      const old = previous[j];
      previous[j] = a[i - 1] === b[j - 1] ? diagonal + 1 : Math.max(previous[j], previous[j - 1]);
      diagonal = old;
    }
  }
  return previous[b.length] / Math.max(a.length, b.length);
}

function statusFor(left: TextUnit | undefined, right: TextUnit | undefined, ratio: number): DifferenceStatus {
  if (!left) return 'added';
  if (!right) return 'removed';
  if (ratio > 0.995) return 'same';
  if (ratio >= 0.38) return 'changed';
  return 'misaligned';
}

/**
 * 一行是否具备完成条件：
 * - 相同句段无需校记，自动视为完成；
 * - 差异行必须恰好有一条被采纳的意见，其余意见均已写明否决原因（不得停留在待定）。
 */
export function rowIsReady(row: AlignmentRow): boolean {
  if (row.status === 'same') return true;
  const opinions = row.opinions ?? [];
  if (!opinions.length) return false;
  if (opinions.filter((item) => item.verdict === 'adopted').length !== 1) return false;
  // 其余意见必须已写明否决原因，任何待定意见都会阻塞完成
  return opinions.every(
    (item) => item.verdict === 'adopted' || (item.verdict === 'rejected' && item.rejectReason.trim().length > 0)
  );
}

/** 行内未决问题说明，用于提示为何不能完成；为空表示具备采纳结论。 */
export function rowPendingReason(row: AlignmentRow): string {
  if (row.status === 'same') return '';
  const opinions = row.opinions ?? [];
  if (!opinions.length) return '尚无整理者意见，先追加一条校记意见';
  const adopted = opinions.filter((item) => item.verdict === 'adopted');
  if (!adopted.length) return '尚未选择采纳的意见';
  if (adopted.length > 1) return '存在多条采纳意见，只能保留一条';
  const missingReason = opinions.find((item) => item.verdict === 'rejected' && !item.rejectReason.trim());
  if (missingReason) return '有被否决的意见尚未写明否决原因';
  const undecided = opinions.find((item) => item.verdict === 'pending');
  if (undecided) return '仍有意见未作处理（采纳或否决）';
  return '';
}

/** 把 v1 单行 note/source 草稿迁移为一条带结论的意见 */
function migrateRow(raw: Partial<AlignmentRow>): AlignmentRow {
  const row: AlignmentRow = {
    id: String(raw.id ?? createId('row')),
    left: raw.left,
    right: raw.right,
    status: (raw.status ?? 'misaligned') as DifferenceStatus,
    similarity: typeof raw.similarity === 'number' ? raw.similarity : 0,
    accepted: Boolean(raw.accepted),
    manuallyAdjusted: Boolean(raw.manuallyAdjusted),
    opinions: Array.isArray(raw.opinions) ? raw.opinions : []
  };

  if (!Array.isArray(raw.opinions)) {
    const legacyNote = (raw.note ?? '').trim();
    if (legacyNote) {
      row.opinions.push({
        id: createId('opinion'),
        note: raw.note ?? '',
        source: raw.source ?? '',
        author: '旧稿整理者',
        createdAt: nowIso(),
        verdict: raw.accepted ? 'adopted' : 'pending',
        rejectReason: '',
        judgedAt: raw.accepted ? nowIso() : undefined,
        migrated: true
      });
    }
    // 旧草稿迁移：按新的完成条件重新判定（没有采纳结论一律待处理）
    row.accepted = row.status === 'same' || rowIsReady(row);
  } else {
    // 补齐历史数据中可能缺失的字段；v2 数据保留原始 accepted，保证撤销/重做状态一致
    row.opinions = raw.opinions.map((opinion) => ({
      ...opinion,
      rejectReason: opinion.rejectReason ?? ''
    }));
  }

  return row;
}

async function alignUnits(
  leftUnits: TextUnit[],
  rightUnits: TextUnit[],
  rules: ComparisonRules,
  onProgress: (value: number) => void
): Promise<AlignmentRow[]> {
  const rows: AlignmentRow[] = [];
  let leftIndex = 0;
  let rightIndex = 0;

  while (leftIndex < leftUnits.length || rightIndex < rightUnits.length) {
    const left = leftUnits[leftIndex];
    const right = rightUnits[rightIndex];

    if (!left) {
      rows.push(makeRow(undefined, right, rules));
      rightIndex += 1;
    } else if (!right) {
      rows.push(makeRow(left, undefined, rules));
      leftIndex += 1;
    } else {
      const sameParagraph =
        left.paragraphOrder === right.paragraphOrder || Math.abs(left.paragraphOrder - right.paragraphOrder) <= 1;
      const ratio = similarity(normalized(left.text, rules), normalized(right.text, rules));
      const nextLeftRatio =
        leftUnits[leftIndex + 1] && right
          ? similarity(normalized(leftUnits[leftIndex + 1].text, rules), normalized(right.text, rules))
          : 0;
      const nextRightRatio =
        rightUnits[rightIndex + 1] && left
          ? similarity(normalized(left.text, rules), normalized(rightUnits[rightIndex + 1].text, rules))
          : 0;

      if (sameParagraph && (ratio >= 0.28 || (nextLeftRatio < 0.58 && nextRightRatio < 0.58))) {
        const score = Number(ratio.toFixed(3));
        rows.push({
          id: `row-${rows.length + 1}-${left.id}-${right.id}`,
          left,
          right,
          status: statusFor(left, right, score),
          similarity: score,
          accepted: score > 0.995,
          manuallyAdjusted: false,
          opinions: []
        });
        leftIndex += 1;
        rightIndex += 1;
      } else if (nextRightRatio > ratio && nextRightRatio > nextLeftRatio) {
        rows.push(makeRow(undefined, right, rules));
        rightIndex += 1;
      } else {
        rows.push(makeRow(left, undefined, rules));
        leftIndex += 1;
      }
    }

    if (rows.length % 24 === 0) {
      onProgress(Math.round(((leftIndex + rightIndex) / Math.max(1, leftUnits.length + rightUnits.length)) * 100));
      await yieldToBrowser();
    }
  }
  onProgress(100);
  return rows;
}

function makeRow(left: TextUnit | undefined, right: TextUnit | undefined, rules: ComparisonRules): AlignmentRow {
  const score = left && right ? Number(similarity(normalized(left.text, rules), normalized(right.text, rules)).toFixed(3)) : 0;
  return {
    id: createId('row'),
    left,
    right,
    status: statusFor(left, right, score),
    similarity: score,
    accepted: score > 0.995,
    manuallyAdjusted: false,
    opinions: []
  };
}

function defaultRules(): ComparisonRules {
  return { ignorePunctuation: true, ignoreVariants: true, candidateWindow: 3 };
}

export function useCollation() {
  const versions = ref<VersionDocument[]>(clone(sampleVersions));
  const leftVersionId = ref(versions.value[0].id);
  const rightVersionId = ref(versions.value[1].id);
  const rows = ref<AlignmentRow[]>([]);
  const rules = ref<ComparisonRules>(defaultRules());
  const selectedRowId = ref('');
  const selectedRowIds = ref<(string | number)[]>([]);
  const currentAuthor = ref('');
  const processing = ref(false);
  const progress = ref(0);
  const message = ref('正在载入本地校勘数据…');
  const history = ref<string[]>([]);
  const future = ref<string[]>([]);
  const canUndo = computed(() => history.value.length > 0);
  const canRedo = computed(() => future.value.length > 0);
  const leftVersion = computed(() => versions.value.find((item) => item.id === leftVersionId.value));
  const rightVersion = computed(() => versions.value.find((item) => item.id === rightVersionId.value));
  const selectedRow = computed(() => rows.value.find((item) => item.id === selectedRowId.value));
  const differenceCount = computed(() => rows.value.filter((row) => row.status !== 'same').length);
  const acceptedCount = computed(() => rows.value.filter((row) => row.accepted).length);
  const unresolvedCount = computed(() => rows.value.filter((row) => !row.accepted && row.status !== 'same').length);
  const opinionCount = computed(() => rows.value.reduce((sum, row) => sum + row.opinions.length, 0));

  function snapshot(): string {
    const data: PersistedCollationState = {
      schemaVersion: SCHEMA_VERSION,
      versions: versions.value,
      leftVersionId: leftVersionId.value,
      rightVersionId: rightVersionId.value,
      rows: rows.value,
      rules: rules.value,
      selectedRowId: selectedRowId.value,
      currentAuthor: currentAuthor.value
    };
    return JSON.stringify(data);
  }

  function persist() {
    localStorage.setItem(STORAGE_KEY, snapshot());
  }

  function commit(label: string, mutate: () => void) {
    history.value.push(snapshot());
    if (history.value.length > MAX_HISTORY) history.value.shift();
    future.value = [];
    mutate();
    message.value = label;
    persist();
  }

  function restore(raw: string) {
    const parsed = JSON.parse(raw) as Partial<PersistedCollationState>;
    if (Array.isArray(parsed.versions)) versions.value = parsed.versions;
    if (parsed.leftVersionId) leftVersionId.value = parsed.leftVersionId;
    if (parsed.rightVersionId) rightVersionId.value = parsed.rightVersionId;
    if (Array.isArray(parsed.rows)) rows.value = parsed.rows.map((row) => migrateRow(row));
    if (parsed.rules) rules.value = parsed.rules;
    if (typeof parsed.selectedRowId === 'string') selectedRowId.value = parsed.selectedRowId;
    currentAuthor.value = parsed.currentAuthor ?? '';
    selectedRowIds.value = [];
    persist();
  }

  function undo() {
    const previous = history.value.pop();
    if (!previous) return;
    future.value.push(snapshot());
    restore(previous);
    message.value = '已撤销上一步操作';
  }

  function redo() {
    const next = future.value.pop();
    if (!next) return;
    history.value.push(snapshot());
    restore(next);
    message.value = '已重做上一步操作';
  }

  async function runAlignment(commitHistory = true) {
    if (!leftVersion.value || !rightVersion.value || processing.value) return;
    processing.value = true;
    progress.value = 0;
    message.value = '正在分片执行自动对齐…';
    const previous = commitHistory ? snapshot() : '';
    try {
      const result = await alignUnits(leftVersion.value.units, rightVersion.value.units, rules.value, (value) => {
        progress.value = value;
      });
      if (commitHistory) {
        history.value.push(previous);
        future.value = [];
      }
      rows.value = result;
      selectedRowId.value = result.find((row) => row.status !== 'same')?.id ?? result[0]?.id ?? '';
      selectedRowIds.value = [];
      message.value = `自动对齐完成：${result.filter((row) => row.status !== 'same').length} 处差异`;
      persist();
    } finally {
      processing.value = false;
    }
  }

  /**
   * 意见或类别变化后的完成性校验：
   * - 相同句段自动完成；
   * - 差异行即使意见齐备，也只取消无效的完成标记，不自动完成——须由整理者明确接受。
   */
  function refreshAccepted(row: AlignmentRow) {
    if (row.status === 'same') {
      row.accepted = true;
    } else if (!rowIsReady(row)) {
      row.accepted = false;
    }
  }

  function recalculate() {
    commit('已按比较规则重算差异', () => {
      rows.value.forEach((row) => {
        if (!row.left || !row.right) return;
        row.similarity = Number(
          similarity(normalized(row.left.text, rules.value), normalized(row.right.text, rules.value)).toFixed(3)
        );
        row.status = statusFor(row.left, row.right, row.similarity);
        refreshAccepted(row);
      });
      selectedRowIds.value = [];
    });
  }

  function updateRow(id: string, patch: Partial<Pick<AlignmentRow, 'status' | 'manuallyAdjusted'>>) {
    commit('已更新校勘行', () => {
      const row = rows.value.find((item) => item.id === id);
      if (!row) return;
      if (patch.status) row.status = patch.status;
      row.manuallyAdjusted = true;
      refreshAccepted(row);
    });
  }

  function shiftPairing(id: string, direction: -1 | 1) {
    commit(direction < 0 ? '已向前调整错位' : '已向后调整错位', () => {
      const index = rows.value.findIndex((row) => row.id === id);
      const targetIndex = index + direction;
      if (index < 0 || targetIndex < 0 || targetIndex >= rows.value.length) return;
      const current = rows.value[index];
      const target = rows.value[targetIndex];
      const currentLeft = current.left;
      current.left = target.left;
      target.left = currentLeft;
      for (const row of [current, target]) {
        if (row.left && row.right) {
          row.similarity = Number(
            similarity(normalized(row.left.text, rules.value), normalized(row.right.text, rules.value)).toFixed(3)
          );
          row.status = statusFor(row.left, row.right, row.similarity);
        } else {
          row.similarity = 0;
          row.status = row.left ? 'removed' : 'added';
        }
        row.manuallyAdjusted = true;
        refreshAccepted(row);
      }
    });
  }

  function moveRow(id: string, direction: -1 | 1) {
    commit('已移动校勘顺序', () => {
      const index = rows.value.findIndex((row) => row.id === id);
      const targetIndex = index + direction;
      if (index < 0 || targetIndex < 0 || targetIndex >= rows.value.length) return;
      const [row] = rows.value.splice(index, 1);
      rows.value.splice(targetIndex, 0, row);
      row.manuallyAdjusted = true;
    });
  }

  /**
   * 追加一条校记意见，不覆盖任何已有意见。
   * 首条意见自动作为候选采纳意见；已有采纳意见时，新意见保持待定，由整理者明确选择。
   */
  function addOpinion(id: string, draft: { note: string; source: string; author: string }) {
    const note = draft.note.trim();
    if (!note) return;
    commit('已追加一条校记意见', () => {
      const row = rows.value.find((item) => item.id === id);
      if (!row) return;
      // 首条意见自动作为候选采纳意见；已有意见时保持待定，由整理者明确选择
      const verdict: OpinionVerdict = row.opinions.length === 0 ? 'adopted' : 'pending';
      const createdAt = nowIso();
      row.opinions.push({
        id: createId('opinion'),
        note,
        source: draft.source.trim(),
        author: draft.author.trim() || '未署名整理者',
        createdAt,
        verdict,
        rejectReason: '',
        judgedAt: verdict === 'adopted' ? createdAt : undefined
      });
      row.manuallyAdjusted = true;
      refreshAccepted(row);
    });
  }

  /** 选择采纳一条意见；其余已采纳意见退回待定，被否决的意见及否决原因原样保留 */
  function adoptOpinion(rowId: string, opinionId: string) {
    commit('已标记采纳意见', () => {
      const row = rows.value.find((item) => item.id === rowId);
      if (!row) return;
      row.opinions.forEach((opinion) => {
        if (opinion.id === opinionId) {
          opinion.verdict = 'adopted';
          opinion.rejectReason = '';
          opinion.judgedAt = nowIso();
        } else if (opinion.verdict === 'adopted') {
          opinion.verdict = 'pending';
          opinion.judgedAt = undefined;
        }
      });
      refreshAccepted(row);
    });
  }

  /** 否决一条意见，必须写明否决原因 */
  function rejectOpinion(rowId: string, opinionId: string, reason: string) {
    const trimmed = reason.trim();
    if (!trimmed) return;
    commit('已否决该意见并记录原因', () => {
      const row = rows.value.find((item) => item.id === rowId);
      const opinion = row?.opinions.find((item) => item.id === opinionId);
      if (!row || !opinion) return;
      opinion.verdict = 'rejected';
      opinion.rejectReason = trimmed;
      opinion.judgedAt = nowIso();
      refreshAccepted(row);
    });
  }

  /** 把意见退回待定（清空否决原因或采纳标记），便于重新评定 */
  function resetOpinion(rowId: string, opinionId: string) {
    commit('已将意见退回待定', () => {
      const row = rows.value.find((item) => item.id === rowId);
      const opinion = row?.opinions.find((item) => item.id === opinionId);
      if (!row || !opinion) return;
      opinion.verdict = 'pending';
      opinion.rejectReason = '';
      opinion.judgedAt = undefined;
      refreshAccepted(row);
    });
  }

  /**
   * 接受（完成）指定行。缺少采纳结论的行会被跳过：
   * 没有意见、未选采纳、否决未写原因或仍有待定意见都不能完成。
   */
  function acceptRows(ids: string[]): AcceptResult {
    if (!ids.length) return { accepted: 0, skipped: 0, skippedReason: '' };
    const selected = new Set(ids);
    const targets = rows.value.filter((row) => selected.has(row.id));
    const ready = targets.filter((row) => rowIsReady(row));
    const skipped = targets.length - ready.length;
    if (!ready.length) {
      const firstBlocked = targets.map(rowPendingReason).find(Boolean);
      return { accepted: 0, skipped, skippedReason: firstBlocked ?? '所选行暂无可接受内容' };
    }
    const readyIds = new Set(ready.map((row) => row.id));
    commit(`已接受 ${ready.length} 条校勘结论${skipped ? `，跳过 ${skipped} 条未决行` : ''}`, () => {
      rows.value.forEach((row) => {
        if (readyIds.has(row.id)) row.accepted = true;
      });
      selectedRowIds.value = selectedRowIds.value.filter((key) => !readyIds.has(String(key)));
    });
    return {
      accepted: ready.length,
      skipped,
      skippedReason: skipped ? '部分行缺少采纳结论或否决原因，已跳过' : ''
    };
  }

  function acceptAll(): AcceptResult {
    return acceptRows(rows.value.filter((row) => row.status !== 'same' && !row.accepted).map((row) => row.id));
  }

  /** 撤回行的接受状态，意见与结论全部保留，可继续处理 */
  function unacceptRow(id: string) {
    commit('已撤回接受状态，可继续处理', () => {
      const row = rows.value.find((item) => item.id === id);
      if (row) row.accepted = false;
    });
  }

  function nextDifference() {
    const start = rows.value.findIndex((row) => row.id === selectedRowId.value);
    for (let offset = 1; offset <= rows.value.length; offset += 1) {
      const index = (start + offset) % rows.value.length;
      const row = rows.value[index];
      if (row && row.status !== 'same' && !row.accepted) {
        selectedRowId.value = row.id;
        message.value = `已跳到第 ${index + 1} 条未完成差异`;
        persist();
        return;
      }
    }
    message.value = '没有更多未完成的差异';
  }

  function addVersion(name: string, source: string, text: string) {
    const id = `version-${Date.now().toString(36)}`;
    const item: VersionDocument = {
      id,
      name: name.trim() || `版本 ${versions.value.length + 1}`,
      source: source.trim() || '手工导入',
      text,
      units: splitIntoUnits(text, id),
      createdAt: new Date().toISOString()
    };
    commit(`已导入版本：${item.name}`, () => {
      versions.value.push(item);
    });
    rightVersionId.value = id;
    void runAlignment();
  }

  function formatTime(iso?: string) {
    if (!iso) return '';
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? iso : date.toLocaleString('zh-CN');
  }

  function exportMarkdown() {
    const reported = rows.value.filter((row) => row.status !== 'same' || row.opinions.length);
    const finished = reported.filter((row) => row.accepted).length;
    const lines = [
      '# 校勘记',
      '',
      `- 底本：${leftVersion.value?.name ?? '未选择'}`,
      `- 参校本：${rightVersion.value?.name ?? '未选择'}`,
      `- 比较规则：${rules.value.ignorePunctuation ? '忽略标点；' : ''}${rules.value.ignoreVariants ? '忽略异体字；' : ''}保留正文。`,
      `- 导出行数：${reported.length}（已完成 ${finished}，待处理 ${reported.length - finished}）`,
      `- 意见总数：${reported.reduce((sum, row) => sum + row.opinions.length, 0)}`,
      `- 导出时间：${new Date().toLocaleString('zh-CN')}`,
      ''
    ];

    if (!reported.length) {
      lines.push('暂无需校勘的差异。', '');
    }

    reported.forEach((row, index) => {
      const verdictLabel = (opinion: CollationOpinion) =>
        opinion.verdict === 'adopted' ? '采纳' : opinion.verdict === 'rejected' ? '否决' : '待定';
      lines.push(
        `## ${index + 1}. ${statusLabel(row.status)}${row.accepted ? '（已完成）' : '（待处理）'}`
      );
      lines.push('');
      lines.push(`- 底本：${row.left?.text ? `“${row.left.text}”` : '（无对应句）'}`);
      lines.push(`- 参校本：${row.right?.text ? `“${row.right.text}”` : '（无对应句）'}`);
      lines.push(`- 相似度：${Math.round(row.similarity * 100)}%`);
      if (!row.opinions.length) {
        lines.push('- 校记意见：暂无');
        lines.push('');
        return;
      }
      lines.push('- 校记意见：');
      lines.push('');
      row.opinions.forEach((opinion, opinionIndex) => {
        lines.push(`  ### 意见 ${opinionIndex + 1} · ${verdictLabel(opinion)}${opinion.migrated ? '（旧草稿迁移）' : ''}`);
        lines.push(`  - 处理人：${opinion.author || '未署名'}`);
        if (opinion.source) lines.push(`  - 来源：${opinion.source}`);
        lines.push(`  - 提交时间：${formatTime(opinion.createdAt)}`);
        lines.push(`  - 校记：${opinion.note}`);
        if (opinion.verdict === 'rejected') {
          lines.push(`  - 否决原因：${opinion.rejectReason || '（未填写）'}`);
        }
        if (opinion.judgedAt) lines.push(`  - 结论时间：${formatTime(opinion.judgedAt)}`);
        lines.push('');
      });
    });

    lines.push(`共 ${reported.length} 条校勘记录，意见 ${reported.reduce((sum, row) => sum + row.opinions.length, 0)} 条。`);
    return lines.join('\n');
  }

  function exportJson() {
    return JSON.stringify(
      {
        schemaVersion: SCHEMA_VERSION,
        left: leftVersion.value,
        right: rightVersion.value,
        rules: rules.value,
        summary: {
          totalRows: rows.value.length,
          differences: differenceCount.value,
          finished: rows.value.filter((row) => row.accepted && row.status !== 'same').length,
          unresolved: unresolvedCount.value,
          opinions: opinionCount.value,
          exportedAt: new Date().toISOString()
        },
        rows: rows.value,
        exportedAt: new Date().toISOString()
      },
      null,
      2
    );
  }

  onMounted(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        restore(raw);
        message.value = '已恢复浏览器中的校勘草稿（含全部意见与采纳结论）';
      } else {
        message.value = '已载入示例版本，正在自动对齐…';
        void runAlignment(false);
      }
    } catch {
      message.value = '本地草稿读取失败，已载入示例数据';
      void runAlignment(false);
    }
  });

  watch(
    [leftVersionId, rightVersionId, () => rules.value.ignorePunctuation, () => rules.value.ignoreVariants, currentAuthor],
    () => {
      if (!processing.value) persist();
    }
  );

  return {
    versions,
    leftVersionId,
    rightVersionId,
    rows,
    rules,
    selectedRowId,
    selectedRowIds,
    currentAuthor,
    processing,
    progress,
    message,
    history,
    future,
    canUndo,
    canRedo,
    leftVersion,
    rightVersion,
    selectedRow,
    differenceCount,
    acceptedCount,
    unresolvedCount,
    opinionCount,
    runAlignment,
    recalculate,
    updateRow,
    shiftPairing,
    moveRow,
    addOpinion,
    adoptOpinion,
    rejectOpinion,
    resetOpinion,
    acceptRows,
    acceptAll,
    unacceptRow,
    nextDifference,
    addVersion,
    undo,
    redo,
    exportMarkdown,
    exportJson,
    formatTime,
    commit
  };
}

export function statusLabel(status: DifferenceStatus) {
  return {
    same: '相同',
    changed: '改动',
    added: '右侧新增',
    removed: '左侧删减',
    misaligned: '疑错位'
  }[status];
}
