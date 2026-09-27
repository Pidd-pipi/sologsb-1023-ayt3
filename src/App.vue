<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { Message } from '@arco-design/web-vue';
import { rowIsReady, rowPendingReason, statusLabel, useCollation } from './composables/useCollation';
import type { AlignmentRow, CollationOpinion, DifferenceStatus, OpinionVerdict } from './types';

const {
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
  canUndo,
  canRedo,
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
  formatTime
} = useCollation();

const importVisible = ref(false);
const onlyDifferences = ref(false);
const rowQuery = ref('');
const opinionDraft = ref({ note: '', source: '' });
const rejectingId = ref('');
const rejectDraft = ref('');
const importForm = ref({ name: '', source: '', text: '' });
const fileInput = ref<HTMLInputElement | null>(null);

const columns = [
  { title: '状态', dataIndex: 'status', slotName: 'status', width: 122, fixed: 'left' as const },
  { title: '底本', dataIndex: 'left', slotName: 'left', width: 300 },
  { title: '对准操作', dataIndex: 'align', slotName: 'align', width: 112, align: 'center' as const },
  { title: '参校本', dataIndex: 'right', slotName: 'right', width: 300 },
  { title: '校记意见 / 结论', dataIndex: 'opinions', slotName: 'opinions', width: 300 }
];

const filteredRows = computed(() => {
  const query = rowQuery.value.trim().toLocaleLowerCase();
  return rows.value.filter((row) => {
    if (onlyDifferences.value && row.status === 'same') return false;
    if (!query) return true;
    const searchable = [
      row.left?.text,
      row.right?.text,
      statusLabel(row.status),
      ...row.opinions.flatMap((opinion) => [opinion.note, opinion.source, opinion.author])
    ]
      .filter(Boolean)
      .map((value) => value!.toLocaleLowerCase());
    return searchable.some((value) => value.includes(query));
  });
});

const rowSelection = computed(() => ({
  type: 'checkbox' as const,
  showCheckedAll: true,
  selectedRowKeys: selectedRowIds.value,
  onlyCurrent: false
}));

watch(
  selectedRow,
  (row) => {
    opinionDraft.value = { note: '', source: '' };
    rejectingId.value = '';
    rejectDraft.value = '';
  },
  { immediate: true }
);

const selectedReadyReason = computed(() => (selectedRow.value ? rowPendingReason(selectedRow.value) : ''));
const selectedReady = computed(() => (selectedRow.value ? rowIsReady(selectedRow.value) : false));
const adoptedOpinion = computed(() => selectedRow.value?.opinions.find((item) => item.verdict === 'adopted'));

function statusColor(status: DifferenceStatus) {
  return {
    same: 'gray',
    changed: 'orange',
    added: 'green',
    removed: 'red',
    misaligned: 'arcoblue'
  }[status] as 'gray' | 'orange' | 'green' | 'red' | 'arcoblue';
}

function verdictColor(verdict: OpinionVerdict) {
  return { adopted: 'green', rejected: 'red', pending: 'orange' }[verdict] as 'green' | 'red' | 'orange';
}

function verdictText(verdict: OpinionVerdict) {
  return { adopted: '采纳', rejected: '否决', pending: '待定' }[verdict];
}

function rowClass(record: AlignmentRow) {
  return record.id === selectedRowId.value ? 'row-active' : '';
}

function onSelectionChange(keys: (string | number)[]) {
  selectedRowIds.value = keys;
}

function updateStatus(status: unknown) {
  if (!selectedRow.value) return;
  updateRow(selectedRow.value.id, { status: String(status) as DifferenceStatus });
}

function onRowClick(record: Record<string, unknown>) {
  const row = record as unknown as AlignmentRow;
  selectedRowId.value = row.id;
}

function submitOpinion() {
  if (!selectedRow.value) return;
  if (!opinionDraft.value.note.trim()) {
    Message.warning('请先填写这条校记意见的内容');
    return;
  }
  addOpinion(selectedRow.value.id, {
    note: opinionDraft.value.note,
    source: opinionDraft.value.source,
    author: currentAuthor.value
  });
  opinionDraft.value = { note: '', source: '' };
  Message.success('意见已追加，原有意见均已保留');
}

function startReject(opinion: CollationOpinion) {
  rejectingId.value = opinion.id;
  rejectDraft.value = opinion.rejectReason;
}

function cancelReject() {
  rejectingId.value = '';
  rejectDraft.value = '';
}

function confirmReject(opinion: CollationOpinion) {
  if (!selectedRow.value) return;
  if (!rejectDraft.value.trim()) {
    Message.warning('否决意见必须写明否决原因');
    return;
  }
  rejectOpinion(selectedRow.value.id, opinion.id, rejectDraft.value);
  cancelReject();
  Message.success('已记录否决意见与原因');
}

function acceptOne(row: AlignmentRow) {
  reportAccept(acceptRows([row.id]));
}

function reportAccept(result: ReturnType<typeof acceptRows>) {
  if (result.accepted > 0) {
    Message.success(`已接受 ${result.accepted} 条${result.skipped ? `，跳过 ${result.skipped} 条未决行` : ''}`);
  } else if (result.skipped > 0) {
    Message.warning(`已跳过 ${result.skipped} 条：${result.skippedReason}`);
  }
}

function acceptChecked() {
  if (!selectedRowIds.value.length) return;
  reportAccept(acceptRows(selectedRowIds.value.map(String)));
}

function acceptAllRows() {
  const before = rows.value.filter((row) => row.status !== 'same' && !row.accepted).length;
  const result = acceptAll();
  if (result.accepted > 0) {
    Message.success(`已接受 ${result.accepted} 条${result.skipped ? `，${result.skipped} 条未决行已跳过` : '，全部差异处理完毕'}`);
  } else if (before > 0) {
    Message.warning(`已跳过 ${result.skipped} 条未决行：${result.skippedReason}`);
  }
}

function withdrawAccept() {
  if (!selectedRow.value) return;
  unacceptRow(selectedRow.value.id);
}

function download(filename: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function handleExport(kind: 'markdown' | 'json') {
  if (kind === 'markdown') {
    download('校勘记.md', exportMarkdown(), 'text/markdown;charset=utf-8');
  } else {
    download('校勘数据.json', exportJson(), 'application/json;charset=utf-8');
  }
}

function openImport() {
  importForm.value = { name: `导入版本 ${versions.value.length + 1}`, source: '', text: '' };
  importVisible.value = true;
}

function confirmImport() {
  if (!importForm.value.text.trim()) {
    Message.warning('请粘贴版本正文或选择文本文件');
    return;
  }
  addVersion(importForm.value.name, importForm.value.source, importForm.value.text.trim());
  importVisible.value = false;
}

function handleFile(event: Event) {
  const target = event.target as HTMLInputElement;
  const file = target.files?.[0];
  if (!file) return;
  file.text().then((text) => {
    importForm.value.text = text;
    if (!importForm.value.name || importForm.value.name.startsWith('导入版本')) {
      importForm.value.name = file.name.replace(/\.[^.]+$/, '');
    }
  });
}

function handleKeydown(event: KeyboardEvent) {
  const target = event.target as HTMLElement | null;
  const typing = target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.isContentEditable;
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
    event.preventDefault();
    event.shiftKey ? redo() : undo();
    return;
  }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'y') {
    event.preventDefault();
    redo();
    return;
  }
  if (typing) return;
  if (event.altKey && event.key === 'ArrowDown') {
    event.preventDefault();
    nextDifference();
  } else if (event.key.toLowerCase() === 'a' && selectedRowIds.value.length) {
    reportAccept(acceptRows(selectedRowIds.value.map(String)));
  }
}

window.addEventListener('keydown', handleKeydown);

const beforeUnload = (event: BeforeUnloadEvent) => {
  if (unresolvedCount.value > 0) {
    event.preventDefault();
    event.returnValue = '';
  }
};
window.addEventListener('beforeunload', beforeUnload);
</script>

<template>
  <a-layout class="workbench-shell">
    <a-layout-header class="topbar">
      <div style="display: flex; align-items: center; gap: 12px; width: 100%">
        <div class="brand-mark">校</div>
        <div>
          <h1 class="brand-title">校异斋 · 多版本校勘台</h1>
          <div class="brand-subtitle">同一处异文汇集多位整理者意见，择一采纳，其余留档否决</div>
        </div>
        <a-space style="margin-left: auto" wrap>
          <a-button :disabled="!canUndo" @click="undo">撤销</a-button>
          <a-button :disabled="!canRedo" @click="redo">重做</a-button>
          <a-button type="primary" :loading="processing" @click="runAlignment()">重新自动对齐</a-button>
          <a-button @click="openImport">导入版本</a-button>
          <a-dropdown>
            <a-button>导出校勘记</a-button>
            <template #content>
              <a-doption @click="handleExport('markdown')">Markdown 校勘记</a-doption>
              <a-doption @click="handleExport('json')">JSON 校勘数据</a-doption>
            </template>
          </a-dropdown>
        </a-space>
      </div>
    </a-layout-header>

    <a-layout class="main-layout">
      <a-layout-sider class="left-panel" :width="282">
        <section class="panel-section">
          <h2 class="panel-title">比对版本</h2>
          <div style="display: grid; gap: 10px">
            <a-select v-model="leftVersionId" aria-label="底本">
              <template #prefix>底本</template>
              <a-option v-for="version in versions" :key="version.id" :value="version.id">{{ version.name }}</a-option>
            </a-select>
            <a-select v-model="rightVersionId" aria-label="参校本">
              <template #prefix>参校</template>
              <a-option v-for="version in versions" :key="version.id" :value="version.id">{{ version.name }}</a-option>
            </a-select>
            <a-button long type="outline" @click="runAlignment()">执行分片自动对齐</a-button>
          </div>
          <a-progress v-if="processing" :percent="progress" size="small" style="margin-top: 12px" />
          <div v-if="processing" style="margin-top: 6px; color: #86909c; font-size: 12px">
            正在让出主线程，长文本编辑不会一直卡住
          </div>
        </section>

        <section class="panel-section">
          <h2 class="panel-title">比较规则</h2>
          <a-space direction="vertical" fill>
            <a-checkbox v-model="rules.ignorePunctuation" @change="recalculate">忽略标点差异</a-checkbox>
            <a-checkbox v-model="rules.ignoreVariants" @change="recalculate">忽略常见异体字</a-checkbox>
          </a-space>
          <div style="margin-top: 10px; color: #86909c; font-size: 12px; line-height: 1.6">
            规则只影响相同/改动判断，原始正文始终保留；重算会进入撤销历史。
          </div>
        </section>

        <section class="panel-section">
          <h2 class="panel-title">处理进度</h2>
          <div class="stats-grid">
            <div class="stat-card">
              <div class="stat-number">{{ differenceCount }}</div>
              <div class="stat-label">全部差异</div>
            </div>
            <div class="stat-card">
              <div class="stat-number" style="color: #d25f00">{{ unresolvedCount }}</div>
              <div class="stat-label">待完成</div>
            </div>
            <div class="stat-card">
              <div class="stat-number" style="color: #00875a">{{ acceptedCount }}</div>
              <div class="stat-label">已完成</div>
            </div>
            <div class="stat-card">
              <div class="stat-number" style="color: #165dff">{{ opinionCount }}</div>
              <div class="stat-label">校记意见</div>
            </div>
          </div>
          <a-button long type="primary" status="success" style="margin-top: 12px" :disabled="!unresolvedCount" @click="acceptAllRows">
            批量接受已决行
          </a-button>
          <div style="margin-top: 6px; color: #86909c; font-size: 11px; line-height: 1.6">
            没有采纳结论（意见未决或否决未写原因）的行会自动跳过。
          </div>
          <a-button long style="margin-top: 8px" @click="nextDifference">跳到下一处未完成差异</a-button>
        </section>

        <section class="panel-section">
          <h2 class="panel-title">键盘辅助</h2>
          <div style="color: #4e5969; font-size: 12px; line-height: 2">
            <div><a-tag size="small">Alt ↓</a-tag> 下一处差异</div>
            <div><a-tag size="small">A</a-tag> 接受勾选已决行</div>
            <div><a-tag size="small">Ctrl/⌘ Z</a-tag> 撤销</div>
            <div><a-tag size="small">Ctrl/⌘ Y</a-tag> 重做</div>
          </div>
        </section>
      </a-layout-sider>

      <a-layout-content class="center-panel">
        <a-card :bordered="false" style="margin-bottom: 12px">
          <div style="display: flex; align-items: center; gap: 12px; flex-wrap: wrap">
            <a-input-search v-model="rowQuery" placeholder="搜索正文、意见、来源或处理人" allow-clear style="max-width: 360px" />
            <a-checkbox v-model="onlyDifferences">只看差异</a-checkbox>
            <a-tag color="arcoblue">{{ filteredRows.length }} / {{ rows.length }} 行</a-tag>
            <a-tag color="arcoblue">{{ opinionCount }} 条意见</a-tag>
            <a-tag v-if="selectedRowIds.length" color="green">{{ selectedRowIds.length }} 行已勾选</a-tag>
            <a-button
              v-if="selectedRowIds.length"
              type="primary"
              status="success"
              size="small"
              style="margin-left: auto"
              @click="acceptChecked"
            >
              接受勾选已决行
            </a-button>
          </div>
        </a-card>

        <a-card :bordered="false" :body-style="{ padding: 0 }">
          <a-alert :show-icon="processing" :type="unresolvedCount ? 'warning' : 'success'" style="border-radius: 0">
            {{ message }}<span v-if="unresolvedCount"> · {{ unresolvedCount }} 条差异尚无采纳结论</span>
          </a-alert>
          <a-table
            class="virtual-table"
            row-key="id"
            :columns="columns"
            :data="filteredRows"
            :pagination="false"
            :row-selection="rowSelection"
            :row-class="rowClass"
            :scroll="{ x: 1180, y: 'calc(100vh - 260px)' }"
            :virtual-list-props="{ height: 590, threshold: 40 }"
            @selection-change="onSelectionChange"
            @row-click="onRowClick"
          >
            <template #status="{ record }">
              <a-tag :color="statusColor(record.status)">
                {{ statusLabel(record.status) }}
              </a-tag>
              <div style="margin-top: 6px; color: #86909c; font-size: 11px">
                相似度 {{ Math.round(record.similarity * 100) }}%
              </div>
              <div v-if="record.manuallyAdjusted" style="margin-top: 4px; color: #165dff; font-size: 11px">人工调整</div>
            </template>

            <template #left="{ record }">
              <div v-if="record.left">
                <div class="paragraph-label">段 {{ record.left.paragraphOrder }} · 句 {{ record.left.sentenceOrder }}</div>
                <div class="diff-text" :class="record.status === 'removed' ? 'removed' : record.status === 'changed' || record.status === 'misaligned' ? 'changed' : 'same'">
                  {{ record.left.text }}
                </div>
              </div>
              <div v-else style="padding: 20px 8px; color: #86909c; text-align: center">无对应底本句</div>
            </template>

            <template #align="{ record }">
              <a-space direction="vertical" size="mini">
                <a-button size="mini" @click.stop="shiftPairing(record.id, -1)">配对上移</a-button>
                <a-button size="mini" @click.stop="shiftPairing(record.id, 1)">配对下移</a-button>
                <a-button size="mini" @click.stop="moveRow(record.id, -1)">整行上移</a-button>
                <a-button size="mini" @click.stop="moveRow(record.id, 1)">整行下移</a-button>
                <span style="display: inline-block">
                  <a-tooltip content="仅当该行已有采纳结论时才能完成">
                    <a-button size="mini" status="success" :disabled="!rowIsReady(record)" @click.stop="acceptOne(record)">接受</a-button>
                  </a-tooltip>
                </span>
              </a-space>
            </template>

            <template #right="{ record }">
              <div v-if="record.right">
                <div class="paragraph-label">段 {{ record.right.paragraphOrder }} · 句 {{ record.right.sentenceOrder }}</div>
                <div class="diff-text" :class="record.status === 'added' ? 'added' : record.status === 'changed' || record.status === 'misaligned' ? 'changed' : 'same'">
                  {{ record.right.text }}
                </div>
              </div>
              <div v-else style="padding: 20px 8px; color: #86909c; text-align: center">无对应参校本句</div>
            </template>

            <template #opinions="{ record }">
              <div style="font-size: 12px; line-height: 1.6; color: #4e5969">
                <template v-if="record.opinions.length">
                  <div v-for="opinion in record.opinions" :key="opinion.id" class="opinion-line">
                    <a-tag size="small" :color="verdictColor(opinion.verdict)">{{ verdictText(opinion.verdict) }}</a-tag>
                    <span class="opinion-note">{{ opinion.note }}</span>
                    <div style="color: #86909c; margin-top: 2px">
                      {{ opinion.author || '未署名' }}<span v-if="opinion.source"> · 来源：{{ opinion.source }}</span>
                    </div>
                    <div v-if="opinion.verdict === 'rejected'" style="color: #cb2634; margin-top: 2px">
                      否决原因：{{ opinion.rejectReason || '（未填写）' }}
                    </div>
                  </div>
                </template>
                <div v-else style="color: #86909c">尚未追加校记意见</div>
                <a-tag v-if="record.accepted" size="small" color="green" style="margin-top: 7px">已完成</a-tag>
                <a-tooltip v-else :content="rowPendingReason(record)">
                  <a-tag size="small" color="orange" style="margin-top: 7px">待处理：{{ rowPendingReason(record) }}</a-tag>
                </a-tooltip>
              </div>
            </template>

            <template #empty>
              <a-empty description="没有符合条件的对齐行" />
            </template>
          </a-table>
        </a-card>
      </a-layout-content>

      <a-layout-sider class="right-panel" :width="360">
        <section class="panel-section">
          <div style="display: flex; align-items: center">
            <h2 class="panel-title" style="margin: 0">校勘详情</h2>
            <a-tag v-if="selectedRow" color="arcoblue" style="margin-left: auto">{{ statusLabel(selectedRow.status) }}</a-tag>
          </div>
          <a-input
            v-model="currentAuthor"
            placeholder="当前处理人姓名（追加意见时自动署名）"
            style="margin-top: 10px"
            aria-label="当前处理人"
          >
            <template #prefix>处理人</template>
          </a-input>
        </section>

        <template v-if="selectedRow">
          <section class="panel-section">
            <div style="margin-bottom: 10px; color: #86909c; font-size: 12px">判断类别</div>
            <a-select :model-value="selectedRow.status" style="width: 100%" @change="updateStatus">
              <a-option value="same">相同</a-option>
              <a-option value="changed">改动</a-option>
              <a-option value="added">右侧新增</a-option>
              <a-option value="removed">左侧删减</a-option>
              <a-option value="misaligned">疑错位</a-option>
            </a-select>
          </section>

          <section class="panel-section">
            <div style="margin-bottom: 10px; color: #86909c; font-size: 12px">底本 / 参校本</div>
            <div class="diff-text same">{{ selectedRow.left?.text || '（无）' }}</div>
            <div style="height: 8px" />
            <div class="diff-text changed">{{ selectedRow.right?.text || '（无）' }}</div>
          </section>

          <section class="panel-section">
            <div style="display: flex; align-items: center; margin-bottom: 10px">
              <h2 class="panel-title" style="margin: 0">全部校记意见（{{ selectedRow.opinions.length }}）</h2>
              <a-tag
                :color="selectedRow.accepted ? 'green' : selectedReady ? 'orange' : 'red'"
                size="small"
                style="margin-left: auto"
              >
                {{ selectedRow.accepted ? '已完成' : selectedReady ? '可接受' : '缺采纳结论' }}
              </a-tag>
            </div>

            <a-empty v-if="!selectedRow.opinions.length" description="还没有整理者意见，请在下方追加第一条" style="padding: 8px 0" />

            <div v-for="opinion in selectedRow.opinions" :key="opinion.id" class="opinion-card">
              <div style="display: flex; align-items: center; gap: 6px; flex-wrap: wrap">
                <a-tag size="small" :color="verdictColor(opinion.verdict)">{{ verdictText(opinion.verdict) }}</a-tag>
                <strong style="font-size: 12px">{{ opinion.author || '未署名整理者' }}</strong>
                <a-tag v-if="opinion.migrated" size="small" color="gray">旧草稿迁移</a-tag>
                <span style="margin-left: auto; color: #86909c; font-size: 11px">{{ formatTime(opinion.createdAt) }}</span>
              </div>
              <div class="opinion-card-note">{{ opinion.note }}</div>
              <div v-if="opinion.source" class="opinion-card-meta">来源：{{ opinion.source }}</div>
              <div v-if="opinion.verdict === 'rejected'" class="opinion-card-reject">
                否决原因：{{ opinion.rejectReason || '（未填写）' }}
              </div>

              <template v-if="rejectingId === opinion.id">
                <a-textarea
                  v-model="rejectDraft"
                  placeholder="请写明否决原因（必填），该意见仍会保留在列表中"
                  :auto-size="{ minRows: 2, maxRows: 5 }"
                  style="margin-top: 8px"
                />
                <a-space style="margin-top: 6px">
                  <a-button size="mini" type="primary" status="danger" @click="confirmReject(opinion)">确认否决</a-button>
                  <a-button size="mini" @click="cancelReject">取消</a-button>
                </a-space>
              </template>
              <a-space v-else style="margin-top: 8px" size="small">
                <a-button
                  size="mini"
                  type="primary"
                  status="success"
                  :disabled="opinion.verdict === 'adopted'"
                  @click="adoptOpinion(selectedRow.id, opinion.id)"
                >
                  采纳此条
                </a-button>
                <a-button
                  size="mini"
                  status="danger"
                  :disabled="opinion.verdict === 'rejected'"
                  @click="startReject(opinion)"
                >
                  否决并写原因
                </a-button>
                <a-button
                  v-if="opinion.verdict !== 'pending'"
                  size="mini"
                  @click="resetOpinion(selectedRow.id, opinion.id)"
                >
                  退回待定
                </a-button>
              </a-space>
            </div>
          </section>

          <section class="panel-section">
            <div style="margin-bottom: 10px; color: #86909c; font-size: 12px">追加新意见（不会覆盖已有意见）</div>
            <a-textarea
              v-model="opinionDraft.note"
              placeholder="记录字形、词句、标点或语义差异的判断依据"
              :auto-size="{ minRows: 4, maxRows: 9 }"
            />
            <a-input v-model="opinionDraft.source" placeholder="本条意见的出处来源，如：某刻本、某论著" style="margin-top: 10px">
              <template #prefix>来源</template>
            </a-input>
            <div style="margin-top: 6px; color: #86909c; font-size: 11px">
              署名将使用上方「当前处理人」：{{ currentAuthor || '（留空记为未署名整理者）' }}
            </div>
            <a-button long type="primary" style="margin-top: 10px" @click="submitOpinion">追加意见</a-button>
          </section>

          <section class="panel-section">
            <div style="margin-bottom: 10px; color: #86909c; font-size: 12px">错位修正</div>
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px">
              <a-button @click="shiftPairing(selectedRow.id, -1)">配对向前</a-button>
              <a-button @click="shiftPairing(selectedRow.id, 1)">配对向后</a-button>
              <a-button @click="moveRow(selectedRow.id, -1)">整行上移</a-button>
              <a-button @click="moveRow(selectedRow.id, 1)">整行下移</a-button>
            </div>
            <a-alert type="info" style="margin-top: 10px" :show-icon="true">
              配对移动只交换左栏句段，不会改写底本或参校本原文，已保存的意见全部保留。
            </a-alert>
          </section>

          <section class="panel-section">
            <div style="margin-bottom: 8px; color: #4e5969; font-size: 12px; line-height: 1.7">
              完成条件：差异行须选定一条采纳意见，其余意见或采纳、或写明否决原因，待定意见不能遗留。
            </div>
            <div v-if="adoptedOpinion" style="margin-bottom: 8px; color: #00875a; font-size: 12px; line-height: 1.7">
              当前采纳：{{ adoptedOpinion.author }}「{{ adoptedOpinion.note }}」
            </div>
            <a-alert v-if="!selectedReady && selectedRow.status !== 'same'" type="warning" style="margin-bottom: 8px" :show-icon="true">
              {{ selectedReadyReason }}
            </a-alert>
            <a-button
              v-if="selectedRow.status !== 'same'"
              long
              :status="selectedRow.accepted ? 'normal' : 'success'"
              :type="selectedRow.accepted ? 'outline' : 'primary'"
              :disabled="!selectedReady"
              @click="selectedRow.accepted ? withdrawAccept() : acceptOne(selectedRow)"
            >
              {{ selectedRow.accepted ? '撤回接受状态（意见保留）' : '接受并标记本行完成' }}
            </a-button>
            <a-alert v-else type="success" :show-icon="true">相同句段自动视为完成，无需校记。</a-alert>
          </section>
        </template>

        <div v-else class="inspector-empty">
          <div>
            <div style="font-size: 30px; color: #c9cdd4">择</div>
            <p>选择中间表格的一行<br />即可追加意见、选择采纳并处理否决</p>
          </div>
        </div>

        <section class="panel-section" style="margin-top: auto">
          <div style="color: #86909c; font-size: 11px; line-height: 1.7">
            最近状态：{{ message }}<br />
            数据与全部意见保存在当前浏览器，刷新、撤销后均可继续处理。
          </div>
        </section>
      </a-layout-sider>
    </a-layout>
  </a-layout>

  <a-modal v-model:visible="importVisible" title="导入同一作品的新版本" width="700px" @ok="confirmImport">
    <a-form :model="importForm" layout="vertical">
      <a-grid :cols="2" :col-gap="12">
        <a-grid-item>
          <a-form-item label="版本名称">
            <a-input v-model="importForm.name" placeholder="如：某刻本 / 某校点本" />
          </a-form-item>
        </a-grid-item>
        <a-grid-item>
          <a-form-item label="来源">
            <a-input v-model="importForm.source" placeholder="馆藏、整理者或文件来源" />
          </a-form-item>
        </a-grid-item>
      </a-grid>
      <a-form-item label="选择文本文件">
        <input ref="fileInput" type="file" accept=".txt,.md,text/plain,text/markdown" @change="handleFile" />
      </a-form-item>
      <a-form-item label="或直接粘贴正文">
        <a-textarea
          v-model="importForm.text"
          placeholder="空行分段；句号、问号、感叹号或分号后自动分句"
          :auto-size="{ minRows: 10, maxRows: 18 }"
        />
      </a-form-item>
      <a-alert type="info" :show-icon="true">导入仅写入当前浏览器。对齐过程会分片执行，原文不会被自动改写。</a-alert>
    </a-form>
  </a-modal>
</template>
