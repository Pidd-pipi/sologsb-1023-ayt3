import { computed, onMounted, ref, watch } from 'vue';
import { sampleVersions, splitIntoUnits } from '../data';
import type {
  AlignmentRow,
  CollationOpinion,
  ComparisonRules,
  DifferenceStatus,
  PersistedCollationState,
  TextUnit,
  VersionDocument
} from '../types';

const STORAGE_KEY = 'sologsb-1023/multi-version-collation/v1';

/** 自动对齐生成的对齐说明（旧草稿中曾写入 source 字段，迁移时据此识别） */
const AUTO_HINTS = new Set([
  '自动补齐右侧新增内容',
  '自动标记左侧缺失内容',
  '右侧有段落或句子插入',
  '左侧有段落或句子缺失'
]);

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
      rows.push(makeRow(undefined, right, rules, '自动补齐右侧新增内容'));
      rightIndex += 1;
    } else if (!right) {
      rows.push(makeRow(left, undefined, rules, '自动标记左侧缺失内容'));
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
          systemNote: '',
          opinions: [],
          adoptedOpinionId: null,
          accepted: score > 0.995,
          manuallyAdjusted: false
        });
        leftIndex += 1;
        rightIndex += 1;
      } else if (nextRightRatio > ratio && nextRightRatio > nextLeftRatio) {
        rows.push(makeRow(undefined, right, rules, '右侧有段落或句子插入'));
        rightIndex += 1;
      } else {
        rows.push(makeRow(left, undefined, rules, '左侧有段落或句子缺失'));
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

function makeRow(
  left: TextUnit | undefined,
  right: TextUnit | undefined,
  rules: ComparisonRules,
  systemNote: string
): AlignmentRow {
  const score = left && right ? Number(similarity(normalized(left.text, rules), normalized(right.text, rules)).toFixed(3)) : 0;
  return {
    id: `row-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    left,
    right,
    status: statusFor(left, right, score),
    similarity: score,
    systemNote,
    opinions: [],
    adoptedOpinionId: null,
    accepted: score > 0.995,
    manuallyAdjusted: false
  };
}

function newOpinionId() {
  return `opinion-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 该行是否已有采纳结论；差异行没有结论就不能算完成 */
export function rowHasConclusion(row: AlignmentRow) {
  return row.status === 'same' || row.opinions.some((opinion) => opinion.id === row.adoptedOpinionId);
}

/** 维护不变式：差异行的 accepted 必须有采纳结论支撑，否则回退为未完成 */
function normalizeCompletion(row: AlignmentRow) {
  if (row.status !== 'same' && !rowHasConclusion(row)) {
    row.accepted = false;
  }
}

function migrateOpinion(raw: Partial<CollationOpinion>, fallbackId: string): CollationOpinion {
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : fallbackId,
    note: typeof raw.note === 'string' ? raw.note : '',
    source: typeof raw.source === 'string' ? raw.source : '',
    handler: typeof raw.handler === 'string' && raw.handler.trim() ? raw.handler : '未署名',
    createdAt: typeof raw.createdAt === 'string' && raw.createdAt ? raw.createdAt : new Date().toISOString(),
    rejectionReason: typeof raw.rejectionReason === 'string' ? raw.rejectionReason : ''
  };
}

/**
 * 旧草稿迁移：单行的 note/source 升级为一条意见；
 * 旧版已接受但没有结论的差异行，补记一条迁移意见并采纳，保持“已完成”状态。
 */
function migrateRow(raw: Partial<AlignmentRow>, index: number): AlignmentRow {
  const row = raw as AlignmentRow;
  const opinions: CollationOpinion[] = Array.isArray(raw.opinions)
    ? raw.opinions.map((opinion, opinionIndex) =>
        migrateOpinion(opinion ?? {}, `opinion-migrated-${index}-${opinionIndex}`)
      )
    : [];

  const legacyNote = (raw.note ?? '').trim();
  const legacySource = (raw.source ?? '').trim();
  const isAutoHint = AUTO_HINTS.has(legacySource);
  if (isAutoHint && !raw.systemNote) {
    row.systemNote = legacySource;
  }
  const migratedSource = isAutoHint ? '' : legacySource;
  if ((legacyNote || migratedSource) && !opinions.length) {
    opinions.push({
      id: `opinion-migrated-${index}`,
      note: legacyNote || '（旧草稿仅记录了来源，无校记正文）',
      source: migratedSource,
      handler: '旧草稿迁移',
      createdAt: new Date().toISOString(),
      rejectionReason: ''
    });
  }

  let adoptedOpinionId =
    typeof raw.adoptedOpinionId === 'string' &&
    opinions.some((opinion) => opinion.id === raw.adoptedOpinionId)
      ? raw.adoptedOpinionId
      : null;

  if (raw.accepted && row.status !== 'same' && !adoptedOpinionId) {
    if (!opinions.length) {
      opinions.push({
        id: `opinion-migrated-${index}`,
        note: '旧草稿中此行已接受，迁移时补记为采纳结论。',
        source: migratedSource,
        handler: '旧草稿迁移',
        createdAt: new Date().toISOString(),
        rejectionReason: ''
      });
    }
    adoptedOpinionId = opinions[0].id;
  }

  row.opinions = opinions;
  row.adoptedOpinionId = adoptedOpinionId;
  normalizeCompletion(row);
  row.note = '';
  row.source = '';
  return row;
}

function isLegacyState(raw: unknown) {
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(parsed?.rows) && parsed.rows.some((row: unknown) => typeof row === 'object' && row !== null && !('opinions' in row));
  } catch {
    return false;
  }
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

  function snapshot(): string {
    const data: PersistedCollationState = {
      versions: versions.value,
      leftVersionId: leftVersionId.value,
      rightVersionId: rightVersionId.value,
      rows: rows.value,
      rules: rules.value,
      selectedRowId: selectedRowId.value
    };
    return JSON.stringify(data);
  }

  function persist() {
    localStorage.setItem(STORAGE_KEY, snapshot());
  }

  function commit(label: string, mutate: () => void) {
    history.value.push(snapshot());
    if (history.value.length > 50) history.value.shift();
    future.value = [];
    mutate();
    message.value = label;
    persist();
  }

  function restore(raw: string) {
    const parsed = JSON.parse(raw) as PersistedCollationState;
    versions.value = parsed.versions;
    leftVersionId.value = parsed.leftVersionId;
    rightVersionId.value = parsed.rightVersionId;
    rows.value = (parsed.rows ?? []).map((row, index) => migrateRow(row as Partial<AlignmentRow>, index));
    rules.value = parsed.rules;
    selectedRowId.value = parsed.selectedRowId;
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

  function recalculate() {
    commit('已按比较规则重算差异', () => {
      rows.value = rows.value.map((row) => {
        if (!row.left || !row.right) return row;
        const score = Number(
          similarity(normalized(row.left.text, rules.value), normalized(row.right.text, rules.value)).toFixed(3)
        );
        const next: AlignmentRow = { ...row, similarity: score, status: statusFor(row.left, row.right, score) };
        normalizeCompletion(next);
        return next;
      });
      selectedRowIds.value = [];
    });
  }

  function updateRow(id: string, patch: Partial<AlignmentRow>) {
    commit('已更新校勘行', () => {
      const row = rows.value.find((item) => item.id === id);
      if (row) {
        Object.assign(row, patch, { manuallyAdjusted: true });
        normalizeCompletion(row);
      }
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
          row.status = row.left ? 'removed' : 'added';
          row.similarity = 0;
        }
        row.manuallyAdjusted = true;
        normalizeCompletion(row);
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

  function addOpinion(rowId: string, payload: { note: string; source: string; handler: string }) {
    const note = payload.note.trim();
    if (!note) return false;
    const opinion: CollationOpinion = {
      id: newOpinionId(),
      note,
      source: payload.source.trim(),
      handler: payload.handler.trim() || '未署名',
      createdAt: new Date().toISOString(),
      rejectionReason: ''
    };
    commit('已追加一条校勘意见', () => {
      const row = rows.value.find((item) => item.id === rowId);
      if (!row) return;
      row.opinions.push(opinion);
      row.manuallyAdjusted = true;
    });
    return true;
  }

  function removeOpinion(rowId: string, opinionId: string) {
    commit('已删除一条校勘意见', () => {
      const row = rows.value.find((item) => item.id === rowId);
      if (!row) return;
      row.opinions = row.opinions.filter((opinion) => opinion.id !== opinionId);
      if (row.adoptedOpinionId === opinionId) {
        row.adoptedOpinionId = null;
        normalizeCompletion(row);
      }
    });
  }

  function adoptOpinion(rowId: string, opinionId: string) {
    commit('已采纳一条校勘意见，此行判定为完成', () => {
      const row = rows.value.find((item) => item.id === rowId);
      if (!row || !row.opinions.some((opinion) => opinion.id === opinionId)) return;
      row.adoptedOpinionId = opinionId;
      row.accepted = true;
      row.manuallyAdjusted = true;
    });
  }

  function unadoptOpinion(rowId: string) {
    commit('已撤销采纳结论，此行重新待处理', () => {
      const row = rows.value.find((item) => item.id === rowId);
      if (!row) return;
      row.adoptedOpinionId = null;
      normalizeCompletion(row);
    });
  }

  function setRejectionReason(rowId: string, opinionId: string, reason: string) {
    const target = rows.value.find((item) => item.id === rowId);
    const opinion = target?.opinions.find((item) => item.id === opinionId);
    if (!opinion || opinion.rejectionReason === reason.trim()) return;
    commit('已填写否决原因', () => {
      opinion.rejectionReason = reason.trim();
    });
  }

  /**
   * 批量接受只会确认已有采纳结论（或相同）的行；
   * 没有采纳结论的差异行直接跳过，不能算完成。
   */
  function acceptRows(ids: string[]) {
    if (!ids.length) return;
    const selected = new Set(ids);
    const targets = rows.value.filter((row) => selected.has(row.id));
    const acceptable = targets.filter((row) => rowHasConclusion(row));
    const skipped = targets.length - acceptable.length;
    if (!acceptable.length) {
      message.value = '所选行均无采纳结论，已跳过：请先为每行采纳一条意见';
      return;
    }
    const label = `已接受 ${acceptable.length} 条建议` + (skipped ? `，跳过 ${skipped} 条无采纳结论的行` : '');
    commit(label, () => {
      acceptable.forEach((row) => {
        row.accepted = true;
      });
      selectedRowIds.value = [];
    });
  }

  function acceptAll() {
    const targets = rows.value.filter((row) => row.status !== 'same' || !row.accepted);
    const acceptable = targets.filter((row) => rowHasConclusion(row));
    const skipped = targets.length - acceptable.length;
    if (!acceptable.length) {
      message.value = '批量接受已跳过：差异行均无采纳结论，请先逐条采纳意见';
      return;
    }
    const label = `已批量接受 ${acceptable.length} 条建议` + (skipped ? `，跳过 ${skipped} 条无采纳结论的行` : '');
    commit(label, () => {
      acceptable.forEach((row) => {
        row.accepted = true;
      });
      selectedRowIds.value = [];
    });
  }

  function nextDifference() {
    const start = rows.value.findIndex((row) => row.id === selectedRowId.value);
    for (let offset = 1; offset <= rows.value.length; offset += 1) {
      const index = (start + offset) % rows.value.length;
      const row = rows.value[index];
      if (row && row.status !== 'same' && !row.accepted) {
        selectedRowId.value = row.id;
        message.value = `已跳到第 ${index + 1} 条未接受差异`;
        persist();
        return;
      }
    }
    message.value = '没有更多未接受的差异';
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

  function exportMarkdown() {
    const changed = rows.value.filter((row) => row.status !== 'same' || row.opinions.length || row.systemNote);
    const resolved = changed.filter(rowHasConclusion).length;
    const lines = [
      '# 校勘记',
      '',
      `- 底本：${leftVersion.value?.name ?? '未选择'}`,
      `- 参校本：${rightVersion.value?.name ?? '未选择'}`,
      `- 比较规则：${rules.value.ignorePunctuation ? '忽略标点；' : ''}${rules.value.ignoreVariants ? '忽略异体字；' : ''}保留正文。`,
      `- 导出时间：${new Date().toLocaleString('zh-CN')}`,
      `- 结论统计：共 ${changed.length} 条记录，${resolved} 条已采纳结论，${changed.length - resolved} 条未完成`,
      ''
    ];
    changed.forEach((row, index) => {
      const adopted = row.opinions.find((opinion) => opinion.id === row.adoptedOpinionId) ?? null;
      lines.push(`## ${index + 1}. ${statusLabel(row.status)}（相似度 ${Math.round(row.similarity * 100)}%）`, '');
      lines.push(`- 底本：${row.left?.text ?? '（无）'}`);
      lines.push(`- 参校本：${row.right?.text ?? '（无）'}`);
      if (row.systemNote) lines.push(`- 对齐说明：${row.systemNote}`);
      if (adopted) {
        const adoptedIndex = row.opinions.findIndex((opinion) => opinion.id === adopted.id) + 1;
        lines.push(`- 结论：**已采纳第 ${adoptedIndex} 条意见**（处理人：${adopted.handler}）`);
      } else {
        lines.push('- 结论：**尚未采纳任何意见，此行未完成，批量接受会跳过**');
      }
      if (row.opinions.length) {
        lines.push('- 全部意见：');
        row.opinions.forEach((opinion, opinionIndex) => {
          const rejected = adopted !== null && opinion.id !== adopted.id;
          const state = adopted?.id === opinion.id ? '已采纳' : rejected ? '已否决' : '未表态';
          const detail = [
            `${opinionIndex + 1}. 【${state}】${opinion.note}`,
            `来源：${opinion.source || '未注明'}`,
            `处理人：${opinion.handler}`,
            `提交时间：${new Date(opinion.createdAt).toLocaleString('zh-CN')}`
          ];
          if (rejected) detail.push(`否决原因：${opinion.rejectionReason.trim() || '（未填写）'}`);
          lines.push('  - ' + detail.join('；'));
        });
      } else {
        lines.push('- 全部意见：（暂无）');
      }
      lines.push('');
    });
    lines.push(
      `共 ${changed.length} 条校勘记录，其中 ${resolved} 条已有采纳结论，${changed.length - resolved} 条待处理。`
    );
    return lines.join('\n');
  }

  function exportJson() {
    return JSON.stringify(
      {
        left: leftVersion.value,
        right: rightVersion.value,
        rules: rules.value,
        summary: {
          totalRows: rows.value.length,
          differenceRows: rows.value.filter((row) => row.status !== 'same').length,
          resolvedRows: rows.value.filter(rowHasConclusion).length,
          unresolvedRows: rows.value.filter((row) => !rowHasConclusion(row)).length,
          opinionCount: rows.value.reduce((sum, row) => sum + row.opinions.length, 0)
        },
        rows: rows.value.map((row) => ({
          ...row,
          adoptedOpinion: row.opinions.find((opinion) => opinion.id === row.adoptedOpinionId) ?? null,
          rejectedOpinions: row.adoptedOpinionId
            ? row.opinions.filter((opinion) => opinion.id !== row.adoptedOpinionId)
            : [],
          complete: rowHasConclusion(row)
        })),
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
        const legacy = isLegacyState(raw);
        restore(raw);
        message.value = legacy
          ? '已恢复浏览器中的校勘草稿，旧版单条校记已迁移为可追加的意见列表'
          : '已恢复浏览器中的校勘草稿';
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
    [leftVersionId, rightVersionId, () => rules.value.ignorePunctuation, () => rules.value.ignoreVariants],
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
    runAlignment,
    recalculate,
    updateRow,
    shiftPairing,
    moveRow,
    addOpinion,
    removeOpinion,
    adoptOpinion,
    unadoptOpinion,
    setRejectionReason,
    acceptRows,
    acceptAll,
    nextDifference,
    addVersion,
    undo,
    redo,
    exportMarkdown,
    exportJson,
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
